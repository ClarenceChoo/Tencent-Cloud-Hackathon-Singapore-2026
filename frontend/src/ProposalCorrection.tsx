import { useEffect, useState } from 'react';
import type { Home, Proposal } from './companionApi';
import { isCaptureIntent } from './carePurpose';

type Props = {
  proposal: Proposal;
  home: Home;
  busy: boolean;
  onEditingChange: (editing: boolean) => void;
  onRevise: (payload: Record<string, unknown>) => Promise<void>;
};

const string = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' ? String(value) : '';

export default function ProposalCorrection({ proposal, home, busy, onEditingChange, onRevise }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(proposal.payload);
  useEffect(() => { setEditing(false); onEditingChange(false); setDraft(proposal.payload); }, [proposal.id]);
  if (!isCaptureIntent(proposal.kind)) return null;
  const set = (key: string, value: unknown) => setDraft(previous => ({ ...previous, [key]: value }));
  const changed = JSON.stringify(draft) !== JSON.stringify(proposal.payload);
  const current = proposal.kind;
  const valid = changed && (current !== 'health_note' || !!string(draft.wording).trim())
    && (current !== 'support_request' || !!string(draft.request_text).trim())
    && (current !== 'measurement' || (Number.isInteger(Number(draft.systolic)) && Number.isInteger(Number(draft.diastolic)) && !!string(draft.source_description).trim()))
    && (current !== 'medication_report' || !!string(draft.dose_instance_id));
  const updateWhen = (value: string) => setDraft(previous => ({ ...previous, occurred_at: null, occurrence_text: value }));
  return <div className="companion-change">
    <button type="button" className="companion-plain" disabled={busy} onClick={() => { const next = !editing; setEditing(next); onEditingChange(next); if (!next) setDraft(proposal.payload); }}>{editing ? 'Close corrections' : current === 'health_note' ? 'Change wording' : 'Correct details'}</button>
    {editing && <div className="companion-correction-fields">
      {current === 'health_note' && <>
        <label>How should this note read?<textarea value={string(draft.wording)} onChange={event => set('wording', event.target.value)} rows={3}/></label>
        <label>Symptom, if stated<input value={string(draft.symptom)} onChange={event => set('symptom', event.target.value || null)}/></label>
        <label>When it happened<input value={string(draft.occurrence_text || draft.occurred_at)} onChange={event => updateWhen(event.target.value)}/></label>
        <fieldset><legend>Share this note with</legend>{home.permitted_recipients.map(person => <label key={person.id}><input type="checkbox" checked={Array.isArray(draft.share_with_user_ids) && draft.share_with_user_ids.includes(person.id)} onChange={event => { const ids = Array.isArray(draft.share_with_user_ids) ? draft.share_with_user_ids as string[] : []; set('share_with_user_ids', event.target.checked ? [...ids, person.id] : ids.filter(id => id !== person.id)); }}/>{person.name as string}</label>)}</fieldset>
      </>}
      {current === 'medication_report' && <>
        <label>Scheduled medicine<select value={string(draft.dose_instance_id)} onChange={event => set('dose_instance_id', event.target.value)}>{home.doses.map(dose => <option key={dose.id} value={dose.id}>{String(dose.medicine_name || 'Medicine')} · {String(dose.scheduled_at || 'Time unavailable')}</option>)}</select></label>
        <label>Your report<select value={string(draft.report_state)} onChange={event => setDraft(previous => ({ ...previous, report_state: event.target.value, taken_time_text: event.target.value === 'reported_taken' ? previous.taken_time_text : null }))}><option value="reported_taken">Taken</option><option value="reported_skipped">Skipped</option><option value="reported_not_yet">Not yet</option><option value="reported_uncertain">Unsure</option></select></label>
        {draft.report_state === 'reported_taken' && <label>Time taken, if stated<input value={string(draft.taken_time_text)} onChange={event => set('taken_time_text', event.target.value || null)}/></label>}
      </>}
      {current === 'measurement' && <>
        <label>Top number<input type="number" min="40" max="300" value={number(draft.systolic)} onChange={event => set('systolic', Number(event.target.value))}/></label>
        <label>Bottom number<input type="number" min="20" max="200" value={number(draft.diastolic)} onChange={event => set('diastolic', Number(event.target.value))}/></label>
        <label>When measured<input value={string(draft.occurrence_text || draft.occurred_at)} onChange={event => updateWhen(event.target.value)}/></label>
        <label>Reading source<input value={string(draft.source_description)} onChange={event => set('source_description', event.target.value)}/></label>
      </>}
      {current === 'support_request' && <>
        <label>Help needed<textarea value={string(draft.request_text)} onChange={event => set('request_text', event.target.value)} rows={3}/></label>
        <label>Recipient<select value={string(draft.recipient_user_id)} onChange={event => set('recipient_user_id', event.target.value)}>{home.permitted_recipients.map(person => <option key={person.id} value={person.id}>{person.name as string}</option>)}</select></label>
        <label>Urgency<select value={string(draft.urgency || 'routine')} onChange={event => set('urgency', event.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option></select></label>
        <label>Barrier, if stated<input value={string(draft.barrier_text)} onChange={event => set('barrier_text', event.target.value || null)}/></label>
      </>}
      <button type="button" className="companion-button companion-secondary" disabled={busy || !valid} onClick={() => void onRevise(draft)}>{current === 'health_note' ? 'Review changed note' : 'Review corrected details'}</button>
    </div>}
  </div>;
}
