import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { ActivityFilters, ActivityItem, api, ApiError } from './api';

const categories = [
  ['all', 'All activity'], ['notes', 'Care notes'], ['readings', 'Readings'], ['medications', 'Medications'],
  ['care', 'Care tasks'], ['support', 'Requests & follow-ups'], ['recordings', 'Recordings'],
  ['reminders', 'Reminders'], ['summaries', 'Summaries'], ['settings', 'Settings & access'],
];
const emptyFilters = { search: '', category: 'all', start: '', end: '' };
const readable = (value: string) => value.replaceAll('_', ' ');

export function ActivityLog({ patientId, timezone, accessRevision, onAccessLost }: {
  patientId: string; timezone: string; accessRevision: string; onAccessLost: (message: string) => void;
}) {
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState<ActivityFilters>(emptyFilters);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const currentIdentity = `${patientId}:${accessRevision}:${JSON.stringify(filters)}:${refresh}`;
  const [loadedIdentity, setLoadedIdentity] = useState(currentIdentity);
  const visible = loadedIdentity === currentIdentity ? items : [];
  const onLost = useRef(onAccessLost);
  onLost.current = onAccessLost;

  useEffect(() => {
    const generation = ++request.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setItems([]); setCursor(null); setError(''); setLoading(true); setLoadedIdentity(currentIdentity);
    api.activity(patientId, filters, abort.signal).then(page => {
      if (request.current !== generation || abort.signal.aborted) return;
      setItems(page.items); setCursor(page.next_cursor);
    }).catch(err => {
      if (request.current !== generation || abort.signal.aborted) return;
      setItems([]); setCursor(null);
      if (err instanceof ApiError && [401, 403].includes(err.status)) onLost.current('Your access changed. Sign in again to view current care information.');
      else setError(err instanceof Error ? err.message : 'Activity could not be loaded.');
    }).finally(() => { if (request.current === generation && !abort.signal.aborted) setLoading(false); });
    return () => { controller.current?.abort(); request.current++; };
  }, [patientId, currentIdentity, filters, refresh]);

  async function loadOlder() {
    if (loading || !cursor) return;
    const generation = ++request.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError('');
    try {
      const page = await api.activity(patientId, { ...filters, cursor }, abort.signal);
      if (request.current !== generation || abort.signal.aborted) return;
      setItems(current => { const existing = new Set(current.map(row => row.id)); return [...current, ...page.items.filter(row => !existing.has(row.id))]; });
      setCursor(page.next_cursor);
    } catch (err) {
      if (request.current !== generation || abort.signal.aborted) return;
      // Clear even earlier pages on failure: previous permissions may be stale.
      setItems([]); setCursor(null);
      if (err instanceof ApiError && [401, 403].includes(err.status)) onLost.current('Your access changed. Sign in again to view current care information.');
      else setError('Older activity could not be loaded. Refresh to try again.');
    } finally { if (request.current === generation && !abort.signal.aborted) setLoading(false); }
  }

  const invalidDates = Boolean(draft.start && draft.end && draft.start > draft.end);
  const formatTime = (value: string) => new Intl.DateTimeFormat('en-SG', {
    timeZone: timezone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));

  return <section className="activity-log" aria-label="Recorded activity">
    <div className="activity-intro"><p>Recordings, reviewed updates and recorded changes in this care space.</p>
      <button className="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16}/> Refresh log</button></div>
    <form className="activity-filters" onSubmit={event => { event.preventDefault(); if (!invalidDates) setFilters({ ...draft }); }}>
      <label className="activity-search">Search activity<div><Search size={16}/><input type="search" maxLength={200} value={draft.search} onChange={event => setDraft({ ...draft, search: event.target.value })} placeholder="Search recorded details" /></div></label>
      <label>Category<select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}>{categories.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
      <label>From<input type="date" value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })}/></label>
      <label>To<input type="date" value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })}/></label>
      <button className="button button-deep" disabled={invalidDates}>Apply filters</button>
      <button type="button" className="text-link" onClick={() => { setDraft(emptyFilters); setFilters({ ...emptyFilters }); }}>Clear</button>
    </form>
    {invalidDates && <p className="inline-error" role="alert">Choose an end date on or after the start date.</p>}
    <p className="source-note">Times and date filters use {timezone}. Recording receipt and processing states do not confirm a care update.</p>
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    <p className="activity-count" role="status" aria-live="polite">{loading ? 'Loading activity…' : `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'} loaded${cursor ? ' · older activity available' : ''}`}</p>
    {!loading && !error && visible.length === 0 ? <div className="activity-empty"><h2>No recorded activity matches</h2><p>New activity appears here after it reaches Parse. Try clearing your filters or refresh after recording an update.</p></div> : null}
    <ol className="activity-list">{visible.map(item => <li key={item.id} className="activity-row">
      <time dateTime={item.recorded_at}>{formatTime(item.recorded_at)}</time>
      <div className="activity-content"><h2>{item.event}</h2>{item.summary ? <p>{item.summary}</p> : null}
        <div className="activity-meta"><span>{item.source}</span><span className="activity-state">{readable(item.status)}</span></div>
        <details><summary>Entry details</summary><dl><dt>Entry ID</dt><dd>{item.id}</dd><dt>Record reference</dt><dd>{item.record_id}</dd><dt>Category</dt><dd>{categories.find(([value]) => value === item.category)?.[1] || item.category}</dd><dt>State</dt><dd>{readable(item.status)}</dd></dl></details>
      </div>
    </li>)}</ol>
    {cursor && !error ? <button className="button activity-older" disabled={loading} onClick={loadOlder}>Load older activity</button> : null}
  </section>;
}
