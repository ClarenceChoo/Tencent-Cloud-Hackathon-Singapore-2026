import type { Home, Proposal } from './companionApi';
import { isCaptureIntent, materialLabels } from './carePurpose';

const readable = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return 'Not stated';
};
const reportState = (value: unknown) => ({ reported_taken: 'Taken', reported_skipped: 'Skipped', reported_not_yet: 'Not yet', reported_uncertain: 'Unsure' } as Record<string, string>)[String(value)] || 'Not stated';

export default function ProposalDetails({ proposal, home }: { proposal: Proposal; home: Home }) {
  if (!isCaptureIntent(proposal.kind)) return <div className="companion-facts"><b>Material details</b>{Object.entries(proposal.payload).filter(([key]) => !key.endsWith('_id') && !key.endsWith('_ids') && !['timezone', 'share_with_names'].includes(key)).map(([key, value]) => <p key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{typeof value === 'string' || typeof value === 'number' ? String(value) : 'See read-back'}</strong></p>)}</div>;
  const payload = proposal.payload;
  const labels = materialLabels[proposal.kind];
  const values: [string, string][] = Object.entries(labels).filter(([key]) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '').map(([key, label]) => {
    if (key === 'recipient_user_id') return [label, home.permitted_recipients.find(person => person.id === payload[key])?.name as string || 'Recipient unavailable'];
    if (key === 'dose_instance_id') {
      const dose = home.doses.find(item => item.id === payload[key]);
      return [label, dose ? `${readable(dose.medicine_name)} · ${readable(dose.scheduled_at)}` : 'Dose unavailable'];
    }
    if (key === 'share_with_user_ids') {
      const ids = Array.isArray(payload[key]) ? payload[key] : [];
      return [label, ids.length ? home.permitted_recipients.filter(person => ids.includes(person.id)).map(person => person.name).join(', ') || 'Recipients unavailable' : 'Only your care space'];
    }
    if (key === 'report_state') return [label, reportState(payload[key])];
    return [label, readable(payload[key])];
  });
  return <div className="companion-facts"><b>Material details</b>{values.map(([label, value]) => <p key={label}><span>{label}</span><strong>{value}</strong></p>)}</div>;
}
