import { CareAction } from './careActions';
import { niceDate } from './api';

const groupLabel: Record<CareAction['group'], string> = {
  review: 'To review', assigned: 'Assigned requests', due: 'Follow-ups and care tasks', undated: 'Without a due time',
};
const kindLabel: Record<CareAction['kind'], string> = {
  proposal: 'Proposal', support_request: 'Support request', followup: 'Follow-up', preventive_task: 'Care-plan task',
};
const actionLabel: Record<CareAction['action'], string> = {
  review: 'Review', acknowledge: 'Open request', record_outcome: 'Record outcome', open: 'Open',
};

export function CareActionInbox({ items, onOpen }: { items: CareAction[]; onOpen: (item: CareAction) => void }) {
  return <section className="card care-action-inbox" aria-labelledby="care-action-title">
    <div className="section-head"><div><div className="eyebrow">Your next steps</div><h2 id="care-action-title">Attention</h2></div><span className="care-action-count" aria-label={`${items.length} permitted items`}>{items.length}</span></div>
    {items.length === 0 ? <p className="care-action-empty" role="status">Nothing needs attention in this care space right now.</p> :
      (Object.keys(groupLabel) as CareAction['group'][]).map(group => {
        const rows = items.filter(item => item.group === group);
        return rows.length ? <div className="care-action-group" key={group}><h3>{groupLabel[group]}</h3><ul>{rows.map(item =>
          <li key={item.key} className="care-action-row"><div><span className="care-action-kind">{kindLabel[item.kind]}</span><p>{item.title}</p><span className="care-action-date">{item.expired ? 'Expired · confirmation unavailable' : item.kind === 'proposal' && item.action === 'open' ? 'Review unavailable for this account' : item.dateOnly ? `${item.overdue ? 'Overdue · ' : 'Due '}${niceDate(item.dateOnly)}` : item.dueAt ? `${item.overdue ? 'Overdue · ' : item.kind === 'proposal' ? 'Expires ' : 'Due '}${niceDate(item.dueAt)}` : 'No due time given'}</span></div><button className="button" onClick={() => onOpen(item)} aria-label={`${actionLabel[item.action]} ${kindLabel[item.kind]}: ${item.title}`}>{actionLabel[item.action]}</button></li>)}</ul></div> : null;
      })}
  </section>;
}
