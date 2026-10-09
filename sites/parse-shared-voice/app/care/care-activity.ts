import type { ActivityItem, ActivityPage, Dashboard, Row } from './api';
import { requireCare, rows, text, type CareProposal } from './care-state';

const categories = new Set(['all', 'notes', 'readings', 'medications', 'care', 'support', 'recordings', 'reminders', 'summaries', 'settings']);
const compare = (a: Pick<ActivityItem, 'recorded_at' | 'id'>, b: Pick<ActivityItem, 'recorded_at' | 'id'>) =>
  b.recorded_at.localeCompare(a.recorded_at) || b.id.localeCompare(a.id);
const source = (row: Row) => (row.provenance as Row | undefined)?.type === 'esp32' ? 'ESP32 relay' : row.source_type === 'phone' || (row.provenance as Row | undefined)?.type === 'phone' ? 'Voice recording' : 'Care dashboard';
const readable = (value: unknown) => text(value).replaceAll('_', ' ');

// Receives the same permission-filtered snapshot as the dashboard. Private
// recordings are queried separately only for the care-space owner.
export async function careActivity(db: D1Database, data: Dashboard, ownerId: string | null, params: URLSearchParams): Promise<ActivityPage> {
  const category = params.get('category') || 'all', search = (params.get('search') || '').trim().toLowerCase();
  const start = params.get('start') || '', end = params.get('end') || '';
  const limitText = params.get('limit') || '50', limit = Number(limitText);
  requireCare(categories.has(category) && search.length <= 200, 422, 'Choose a valid category and a search of up to 200 characters.');
  requireCare(/^\d+$/.test(limitText) && Number.isInteger(limit) && limit >= 1 && limit <= 100, 422, 'Choose a page size from 1 to 100.');
  for (const date of [start, end]) if (date) {
    const parsed = Date.parse(`${date}T00:00:00Z`);
    requireCare(/^\d{4}-\d\d-\d\d$/.test(date) && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date, 422, 'Choose a valid calendar date.');
  }
  requireCare(!start || !end || start <= end, 422, 'Choose an end date on or after the start date.');
  const timezone = data.patient.timezone;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const localDate = (stamp: string) => {
    const parts = formatter.formatToParts(new Date(stamp));
    return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
  };
  // Bind pagination to the patient and filters so a stale cursor cannot be
  // silently reused for a different care space or query.
  const query = JSON.stringify([data.patient.id, timezone, category, search, start, end]);
  let after: Pick<ActivityItem, 'id' | 'recorded_at'> | null = null;
  if (params.get('cursor')) {
    const cursor = params.get('cursor')!;
    requireCare(cursor.length <= 2048, 422, 'Refresh the log to restart pagination.');
    try {
      const value = JSON.parse(decodeURIComponent(atob(cursor))) as Record<string, unknown>;
      requireCare(value.query === query && typeof value.id === 'string' && value.id.length <= 240 && typeof value.recorded_at === 'string' && Number.isFinite(Date.parse(value.recorded_at)), 422, 'Refresh the log to restart pagination.');
      after = { id: value.id, recorded_at: new Date(value.recorded_at).toISOString() };
    } catch { requireCare(false, 422, 'Refresh the log to restart pagination.'); }
  }
  const items: ActivityItem[] = [];
  function add(category: string, event: string, row: Row, stamp: unknown, summary: string, status: unknown, eventId = text(row.id)) {
    const millis = typeof stamp === 'number' ? stamp : Date.parse(text(stamp));
    if (!row.id || !Number.isFinite(millis)) return; // No invented historical timestamps.
    items.push({ id: `${category}:${eventId}:${event}`, record_id: row.id, recorded_at: new Date(millis).toISOString(), category, event, summary: summary.slice(0, 5000), status: text(status) || 'recorded', source: source(row) });
  }
  for (const note of data.notes) if (!note.deleted_at)
    add('notes', 'Care note confirmed', note, note.confirmed_at || note.created_at, text(note.wording), 'confirmed');
  for (const reading of data.measurements)
    add('readings', 'Reading confirmed', reading, reading.confirmed_at || reading.created_at, `${reading.systolic}/${reading.diastolic} ${text(reading.unit)} · ${text(reading.source_description)}`, reading.superseded_at ? 'superseded' : 'confirmed');
  for (const dose of data.doses) {
    const history = rows(dose.report_history);
    if (history.length) for (const report of history)
      add('medications', 'Medication report confirmed', { ...dose, provenance: report.provenance }, report.report_time, `${text(dose.medicine_name)} · ${readable(report.report_state)}`, report.report_state, `${dose.id}:${report.id}`);
    else if (dose.report_time) add('medications', 'Medication report confirmed', dose, dose.report_time, `${text(dose.medicine_name)} · ${readable(dose.report_state)}`, dose.report_state);
  }
  for (const plan of data.medication_plans)
    add('medications', 'Medication plan reviewed', plan, plan.reviewed_at || plan.created_at, `Reviewed plan version ${plan.version}.`, 'reviewed');
  for (const task of data.preventive_tasks) {
    add('care', 'Care task recorded', task, task.confirmed_at || task.created_at, text(task.description), 'recorded');
    for (const transition of rows(task.transitions)) add('care', 'Care task updated', task, (transition.provenance as Row | undefined)?.confirmed_at, `${text(task.description)} · ${readable(transition.from_state)} → ${readable(transition.to_state)}`, transition.to_state, `${task.id}:${transition.id}`);
  }
  for (const request of data.support_requests) {
    add('support', 'Support requested', request, request.confirmed_at || request.created_at, text(request.request_text), 'recorded');
    add('support', 'Request acknowledged', request, request.acknowledged_at, text(request.request_text), 'acknowledged');
    add('support', 'Request resolved', request, request.resolved_at, text(request.outcome || request.request_text), 'resolved');
  }
  for (const followup of data.followups) {
    const related = ({ health_note: data.notes, medication_report: data.doses, support_request: data.support_requests } as Record<string, Row[]>)[text(followup.related_type)];
    if (!ownerId && !related?.some(row => row.id === followup.related_id && !row.deleted_at)) continue;
    add('support', 'Follow-up recorded', followup, followup.confirmed_at || followup.created_at, text(followup.description), 'recorded');
    for (const resolution of rows(followup.resolutions)) add('support', 'Follow-up resolved', followup, resolution.resolved_at, text(resolution.reported_outcome), 'resolved', `${followup.id}:${resolution.id}`);
  }
  if (ownerId) {
    for (const proposal of data.proposals as CareProposal[]) {
      const row = proposal as unknown as Row;
      // Generic proposal metadata never repeats raw voice or a deleted note.
      const category = ({ health_note: 'notes', measurement: 'readings', medication_report: 'medications', preventive_task: 'care', support_request: 'support', followup: 'support' } as Record<string, string>)[proposal.kind] || 'care';
      const status = proposal.status === 'pending' && Date.parse(proposal.expires_at || '') <= Date.now() ? 'expired' : proposal.status;
      add(category, 'Update prepared for review', row, proposal.created_at, `Review requested for ${readable(proposal.kind)}.`, status);
    }
    for (const summary of data.summaries) {
      add('summaries', 'Summary prepared', summary, summary.created_at, 'A care summary was prepared for review.', 'draft');
      add('summaries', 'Summary reviewed', summary, summary.reviewed_at, 'A care summary was reviewed.', 'reviewed');
      add('summaries', 'Summary shared', summary, summary.shared_at, 'A reviewed summary link was created.', 'shared');
    }
    // Select only safe metadata. Audio, transcripts, errors and credentials
    // never enter this endpoint, even for the owner.
    const recordings = await db.prepare('SELECT r.id,r.state,r.created_at,r.updated_at,v.client_type FROM voice_recordings r JOIN voice_rooms v ON v.id = r.room_id AND v.owner_id = r.owner_id WHERE r.owner_id = ?').bind(ownerId).all<{ id: string; state: string; created_at: number; updated_at: number; client_type: string }>();
    for (const recording of recordings.results) {
      const row = { id: recording.id, provenance: { type: recording.client_type === 'esp32' ? 'esp32' : 'phone' } };
      add('recordings', 'Recording started', row, recording.created_at, 'A recording reached Parse. This is not a confirmed care update.', 'received');
      if (recording.state !== 'receiving') add('recordings', 'Recording status updated', row, recording.updated_at, 'Recording processing does not confirm a care update.', recording.state);
    }
  }
  const filtered = items.filter(item => (category === 'all' || item.category === category)
    && (!search || `${item.event} ${item.summary} ${item.status} ${item.source}`.toLowerCase().includes(search))
    && (!start || localDate(item.recorded_at) >= start) && (!end || localDate(item.recorded_at) <= end)
    && (!after || compare(item, after) > 0)).sort(compare);
  const page = filtered.slice(0, limit), last = page.at(-1);
  return { items: page, timezone, next_cursor: filtered.length > limit && last ? btoa(encodeURIComponent(JSON.stringify({ query, id: last.id, recorded_at: last.recorded_at }))) : null };
}
