"use client";

import { arr, label, niceDate, Row } from './api';

export function RecordSource({row}: {row: Row}) {
  const raw = row.provenance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Row;
  const names: Record<string, string> = {phone:'Parse phone', pendant:'Parse cardholder', dashboard:'care dashboard'};
  const name = names[label(source,'type')];
  return <div className="record-source">{name ? `Recorded via ${name}` : 'Source not recorded'}{source.confirmed_at ? ` · Confirmed ${niceDate(source.confirmed_at)}` : ''}</div>;
}

export function RecordHistory({row}: {row: Row}) {
  const transitions = arr(row.transitions), reports = arr(row.report_history), resolutions = arr(row.resolutions);
  if (!transitions.length && !reports.length && !resolutions.length) return null;
  const entries = [...transitions, ...reports, ...resolutions];
  return <details className="record-history"><summary>Confirmed history ({entries.length})</summary>
    <ol>{entries.map(entry => <li key={entry.id}>
      <p>{label(entry,'reported_outcome') || label(entry,'to_state','report_state').replaceAll('_',' ')}
        {entry.appointment_date ? ` · Appointment ${niceDate(entry.appointment_date)}` : ''}
        {entry.completion_date ? ` · Completed ${niceDate(entry.completion_date)}` : ''}
        {entry.taken_time_text ? ` · Reported timing: ${String(entry.taken_time_text)}` : ''}</p>
      <RecordSource row={entry}/>
    </li>)}</ol>
  </details>;
}
