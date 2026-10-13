import { Dashboard, label, localDay, Row } from './api';
import { proposalDestination, type ProposalView } from './voice-result';

export type CareAction = {
  key: string;
  kind: 'proposal' | 'support_request' | 'followup' | 'preventive_task';
  sourceId: string;
  title: string;
  dueAt: string | null;
  dateOnly: string | null;
  group: 'review' | 'assigned' | 'due' | 'undated';
  action: 'review' | 'acknowledge' | 'record_outcome' | 'open';
  targetView: ProposalView;
  overdue: boolean;
  expired: boolean;
};

const can = (permissions: string[], scope: string) => permissions.includes('*') || permissions.includes(scope);
const terminal = (row: Row, field: string, states: string[]) => states.includes(label(row, field).toLowerCase());
const dateOnly = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const instant = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value || dateOnly(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
};

export function buildCareActions(data: Dashboard, viewerUserId: string, nowMs: number): CareAction[] {
  const items: CareAction[] = [];
  const permissions = data.permissions || [];
  const today = localDay(new Date(nowMs), data.patient.timezone);
  const add = (kind: CareAction['kind'], row: Row, title: string, dueAt: string | null, day: string | null,
    group: CareAction['group'], action: CareAction['action'], targetView: CareAction['targetView'], overdue = false, expired = false) => {
    if (typeof row.id !== 'string' || !row.id) return;
    items.push({ key: `${kind}:${row.id}`, kind, sourceId: row.id, title, dueAt, dateOnly: day, group, action, targetView, overdue, expired });
  };

  for (const proposal of data.proposals || []) {
    if (!['pending', 'awaiting_confirmation'].includes(proposal.status)) continue;
    const expired = proposal.expires_at != null && Date.parse(proposal.expires_at) <= nowMs;
    add('proposal', proposal, proposal.readback || `Review ${proposal.kind.replaceAll('_', ' ')}`,
      instant(proposal.expires_at), null, 'review', !expired && can(permissions, 'write:care') ? 'review' : 'open', proposalDestination(proposal.kind).view, false, expired);
  }
  for (const request of data.support_requests || []) {
    if (terminal(request, 'status', ['resolved', 'closed', 'cancelled'])) continue;
    const assigned = request.recipient_user_id === viewerUserId;
    const actionable = assigned && ['open', 'sent', 'pending'].includes(label(request, 'status').toLowerCase()) && can(permissions, 'ack:support');
    add('support_request', request, label(request, 'request_text', 'title', 'request') || 'Support request', null, null,
      assigned ? 'assigned' : 'undated', actionable ? 'acknowledge' : 'open', 'support');
  }
  for (const followup of data.followups || []) {
    if (['resolved', 'closed', 'cancelled'].includes(label(followup, 'resolution_state', 'status').toLowerCase())) continue;
    const at = instant(followup.check_at);
    add('followup', followup, label(followup, 'description') || 'Follow-up', at, dateOnly(followup.check_at),
      at || dateOnly(followup.check_at) ? 'due' : 'undated', can(permissions, 'write:care') ? 'record_outcome' : 'open', 'support',
      at ? Date.parse(at) < nowMs : dateOnly(followup.check_at) ? dateOnly(followup.check_at)! < today : false);
  }
  for (const task of data.preventive_tasks || []) {
    if (terminal(task, 'state', ['completed', 'declined', 'cancelled'])) continue;
    const day = dateOnly(task.due_date);
    const at = instant(task.due_date);
    const overdue = day ? day < today : at ? Date.parse(at) < nowMs : false;
    add('preventive_task', task, label(task, 'description', 'task_type', 'title') || 'Care-plan task', at, day,
      day || at ? 'due' : 'undated', 'open', 'care', overdue);
  }
  const groups: Record<CareAction['group'], number> = { review: 0, assigned: 1, due: 2, undated: 3 };
  return items.sort((a, b) => groups[a.group] - groups[b.group]
    || (a.dateOnly || (a.dueAt ? localDay(new Date(a.dueAt), data.patient.timezone) : '')).localeCompare(b.dateOnly || (b.dueAt ? localDay(new Date(b.dueAt), data.patient.timezone) : ''))
    || (a.dueAt && b.dueAt ? Date.parse(a.dueAt) - Date.parse(b.dueAt) : 0)
    || a.key.localeCompare(b.key));
}
