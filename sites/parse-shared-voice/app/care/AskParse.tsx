/* eslint react-hooks/set-state-in-effect: "off", react-hooks/refs: "off" -- Keep the existing immediate session/source guards that clear stale private content. */
"use client";

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, CareQueryItem, CareQueryKind, CareQueryResponse, localDay, str } from './api';
import { RecordSource } from './RecordSource';

const questions: Record<CareQueryKind, string> = {
  latest_reading: 'What is the latest reported blood-pressure reading?',
  open_support: 'Which support requests are still open?',
  medication_reports: 'What was reported about scheduled medicines on this date?',
};
const reportLabels: Record<string, string> = {
  reported_taken: 'Reported taken', reported_skipped: 'Reported skipped',
  reported_not_yet: 'Reported not yet', reported_uncertain: 'Reported uncertain',
};

function localTime(value: unknown, timezone: string, fallback: string) {
  if (typeof value !== 'string' || !value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

function sourceFacts(item: CareQueryItem, timezone: string) {
  if (item.source_type === 'measurement') return <>
    <p><strong>{String(item.systolic)}/{String(item.diastolic)} {str(item.unit)}</strong> blood pressure</p>
    <p>Recorded: {localTime(item.recorded_at, timezone, 'Unknown')}</p>
    <p>Occurred: {localTime(item.occurred_at, timezone, 'Unknown')}</p>
    {item.occurrence_text ? <p>Reported time: {str(item.occurrence_text)}</p> : null}
    {item.source_description ? <p>Source: {str(item.source_description)}</p> : null}
    <RecordSource row={item}/>
  </>;
  if (item.source_type === 'support_request') return <>
    <p><strong>{str(item.request_text)}</strong></p>
    <p>Status: {str(item.status, 'Unknown')}</p>
    <p>Recorded: {localTime(item.recorded_at, timezone, 'Unknown')}</p>
    {item.urgency ? <p>Urgency: {str(item.urgency)}</p> : null}
    <RecordSource row={item}/>
  </>;
  const reports = Array.isArray(item.report_history) ? item.report_history as Record<string, unknown>[] : [];
  return <>
    <p><strong>{str(item.medicine_name, 'Scheduled medicine')}</strong></p>
    <p>Scheduled: {localTime(item.scheduled_at, timezone, 'Unknown')}</p>
    {reports.length === 0 ? <p>No confirmed report is recorded. This does not say whether the medicine was taken.</p> :
      <ul>{reports.map((report, index) => <li key={str(report.id, String(index))}>
        {reportLabels[str(report.report_state)] || 'Unknown report state'} · confirmed {localTime(report.confirmed_at, timezone, 'Unknown')}
        {report.taken_time_text ? ` · reported time: ${str(report.taken_time_text)}` : ''}
        <RecordSource row={report}/>
      </li>)}</ul>}
    <RecordSource row={item}/>
  </>;
}

function fictionalAnswer(kind: CareQueryKind, date: string, timezone: string): CareQueryResponse {
  const now = new Date().toISOString();
  const sample: CareQueryItem = kind === 'latest_reading' ? {
    source_type: 'measurement', source_id: 'sample-reading', source_version: 1,
    recorded_at: now, occurred_at: null, systolic: 122, diastolic: 78,
    unit: 'mmHg', source_description: 'Home monitor',
  } : kind === 'open_support' ? {
    source_type: 'support_request', source_id: 'sample-support', source_version: null,
    recorded_at: now, occurred_at: null, request_text: 'Request for a ride to an appointment',
    status: 'open', urgency: 'routine',
  } : {
    source_type: 'dose', source_id: 'sample-dose', source_version: null,
    recorded_at: null, occurred_at: null, medicine_name: 'Daily medicine',
    scheduled_at: `${date}T01:00:00Z`, report_state: 'unreported', report_history: [],
  };
  return { kind, generated_at: now, timezone, date_basis: kind === 'medication_reports' ?
    'scheduled_local_date' : 'recorded_at', local_date: kind === 'medication_reports' ? date : null,
    items: [sample], truncated: false };
}

type TaggedAnswer = { patientId: string; sessionKey: string; value: CareQueryResponse };
type TaggedSource = { patientId: string; sessionKey: string; value: CareQueryItem };

export function AskParse({ patientId, timezone, sessionKey = '', evidenceRevision = '', preview = false, onOpenSource, onSessionExpired }: {
  patientId: string; timezone: string; sessionKey?: string; evidenceRevision?: string; preview?: boolean;
  onOpenSource?: (source: CareQueryItem) => void;
  onSessionExpired?: () => void;
}) {
  const [kind, setKind] = useState<CareQueryKind>('latest_reading');
  const [date, setDate] = useState(() => localDay(new Date(), timezone));
  const [answer, setAnswer] = useState<TaggedAnswer | null>(null);
  const [source, setSource] = useState<TaggedSource | null>(null);
  const [status, setStatus] = useState('');
  const [sourceStatus, setSourceStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const identity = `${sessionKey}\u0000${patientId}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const queryGeneration = useRef(0);
  const sourceGeneration = useRef(0);
  const queryAbort = useRef<AbortController | null>(null);
  const sourceAbort = useRef<AbortController | null>(null);

  function clearRequests() {
    queryGeneration.current += 1;
    sourceGeneration.current += 1;
    queryAbort.current?.abort();
    sourceAbort.current?.abort();
    queryAbort.current = null;
    sourceAbort.current = null;
    setAnswer(null);
    setSource(null);
    setStatus('');
    setSourceStatus('');
    setBusy(false);
    setSourceBusy(false);
  }

  useEffect(() => {
    clearRequests();
    setKind('latest_reading');
    setDate(localDay(new Date(), timezone));
    return () => { queryAbort.current?.abort(); sourceAbort.current?.abort(); queryGeneration.current++; sourceGeneration.current++; };
    // Identity changes clear care-space and session-specific evidence.
  }, [identity, timezone]);
  useEffect(() => { clearRequests(); }, [evidenceRevision]);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (kind === 'medication_reports' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setStatus('Choose a valid patient-local date.');
      return;
    }
    if (preview) {
      setSource(null);
      setAnswer({ patientId, sessionKey, value: fictionalAnswer(kind, date, timezone) });
      setStatus('Preview shown.');
      return;
    }
    queryAbort.current?.abort();
    sourceAbort.current?.abort();
    const controller = new AbortController();
    queryAbort.current = controller;
    const generation = ++queryGeneration.current;
    ++sourceGeneration.current;
    const startedFor = identity;
    setAnswer(null);
    setSource(null);
    setSourceStatus('');
    setBusy(true);
    setStatus('Checking current permitted records…');
    try {
      const value = await api.careQuery(patientId, kind, kind === 'medication_reports' ? date : undefined, controller.signal);
      if (generation !== queryGeneration.current || activeIdentity.current !== startedFor) return;
      setAnswer({ patientId, sessionKey, value });
      setStatus(value.items.length === 0 ? 'No matching permitted records were found.' : `${value.items.length} source${value.items.length === 1 ? '' : 's'} shown.`);
    } catch (error) {
      if (controller.signal.aborted || generation !== queryGeneration.current || activeIdentity.current !== startedFor) return;
      if (error instanceof ApiError && error.status === 401) onSessionExpired?.();
      setStatus(error instanceof ApiError && error.status === 403 ? 'You do not have permission to view this category.' :
        error instanceof ApiError && error.status === 401 ? 'Your session has expired. Sign in again to ask.' :
        error instanceof ApiError && error.status === 422 ? 'Check the selected question and date.' :
        'The answer could not be loaded. Try again.');
    } finally {
      if (generation === queryGeneration.current && activeIdentity.current === startedFor) setBusy(false);
    }
  }

  async function viewSource(item: CareQueryItem) {
    if (preview) {
      setAnswer(null);
      setStatus('');
      setSource({ patientId, sessionKey, value: item });
      setSourceStatus('Preview source.');
      return;
    }
    sourceAbort.current?.abort();
    const controller = new AbortController();
    sourceAbort.current = controller;
    const generation = ++sourceGeneration.current;
    const startedFor = identity;
    setSource(null);
    setSourceBusy(true);
    setSourceStatus('Checking the current source…');
    try {
      const value = await api.careQuerySource(patientId, item.source_type, item.source_id, controller.signal);
      if (generation !== sourceGeneration.current || activeIdentity.current !== startedFor) return;
      // The answer is a snapshot. Keep only the newly authorized source evidence.
      setAnswer(null);
      setStatus('');
      setSource({ patientId, sessionKey, value });
      setSourceStatus('Current source loaded.');
      onOpenSource?.(value);
    } catch (error) {
      if (controller.signal.aborted || generation !== sourceGeneration.current || activeIdentity.current !== startedFor) return;
      setAnswer(null);
      setStatus('');
      setSource(null);
      if (error instanceof ApiError && error.status === 401) onSessionExpired?.();
      setSourceStatus(error instanceof ApiError && error.status === 403 ? 'Access to this category was removed.' :
        error instanceof ApiError && error.status === 404 ? 'This source is no longer available here. Ask again for current results.' :
        error instanceof ApiError && error.status === 401 ? 'Your session has expired. Sign in again.' :
        'The source could not be loaded. Try again.');
    } finally {
      if (generation === sourceGeneration.current && activeIdentity.current === startedFor) setSourceBusy(false);
    }
  }

  const currentAnswer = answer?.patientId === patientId && answer.sessionKey === sessionKey ? answer.value : null;
  const currentSource = source?.patientId === patientId && source.sessionKey === sessionKey ? source.value : null;
  return <section className="card ask-parse" aria-labelledby="ask-parse-title">
    <div className="section-head"><div><div className="eyebrow">Care record questions</div><h2 id="ask-parse-title">Ask Parse</h2></div></div>
    <p>{preview ? 'Explore the preview. Changes are not saved.' :
      'Choose one question. Answers use the records you can view in this care space.'}</p>
    <form onSubmit={ask}>
      <label htmlFor="ask-parse-question">Question</label>
      <select id="ask-parse-question" value={kind} onChange={event => { clearRequests(); setKind(event.target.value as CareQueryKind); }}>
        {(Object.keys(questions) as CareQueryKind[]).map(option => <option key={option} value={option}>{questions[option]}</option>)}
      </select>
      {kind === 'medication_reports' ? <><label htmlFor="ask-parse-date">Scheduled date in {timezone}</label>
        <input id="ask-parse-date" type="date" required value={date} onChange={event => { clearRequests(); setDate(event.target.value); }}/></> : null}
      <button className="button" type="submit" disabled={busy}>Find answer</button>
    </form>
    <p role="status" aria-live="polite">{currentAnswer || busy ? status : answer ? '' : status}</p>
    {currentAnswer ? <div className="ask-parse-answer">
      <h3>{questions[currentAnswer.kind]}</h3>
      <p>{currentAnswer.date_basis === 'scheduled_local_date' ?
        `Scheduled on ${currentAnswer.local_date} in ${currentAnswer.timezone}.` :
        `Ordered by when records were entered. Times shown in ${currentAnswer.timezone}.`}</p>
      <p>Checked: {localTime(currentAnswer.generated_at, currentAnswer.timezone, 'Unknown')}</p>
      {currentAnswer.items.length === 0 ? <p className="ask-parse-empty">{currentAnswer.kind === 'latest_reading' ?
        'No confirmed blood-pressure reading is available to you.' : currentAnswer.kind === 'open_support' ?
        'No open support requests are visible to you.' : 'No doses are scheduled for this date in the records you can view.'}</p> :
        <ul className="ask-parse-results">{currentAnswer.items.map(item => <li key={`${item.source_type}:${item.source_id}`}>
          {sourceFacts(item, currentAnswer.timezone)}
          <button className="button" type="button" disabled={sourceBusy} onClick={() => viewSource(item)}>
            View source
          </button>
        </li>)}</ul>}
      {currentAnswer.truncated ? <p className="ask-parse-truncated" role="status">Showing the first 50 permitted results. More results exist; this list is incomplete.</p> : null}
    </div> : null}
    <p role="status" aria-live="polite">{sourceStatus}</p>
    {currentSource ? <div className="ask-parse-source" aria-label="Current source detail">
      <h3>{preview ? 'Preview source' : 'Current source'}</h3>{sourceFacts(currentSource, timezone)}
    </div> : null}
  </section>;
}
