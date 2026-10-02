import { useEffect, useRef, useState } from 'react';
import { api, ApiError, niceDate, VocabularySuggestion, VocabularyTerm, VocabularyView } from './api';

const blank = (): VocabularyTerm => ({ canonical: '', aliases: [], category: 'other' });
const key = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase();

export function vocabularyError(terms: VocabularyTerm[]): string {
  if (terms.length > 100) return 'Keep at most 100 reviewed terms.';
  const spellings = new Map<string, number>();
  for (const [index, term] of terms.entries()) {
    if (!term.canonical.trim() || term.canonical.trim().length > 80) return 'Each name must be 1–80 characters.';
    if (term.aliases.length > 5) return 'Keep at most 5 alternatives for each name.';
    const names = [term.canonical, ...term.aliases];
    for (const name of names) {
      if (!name.trim() || name.trim().length > 80) return 'Each alternative must be 1–80 characters.';
      const normalized = key(name);
      if (spellings.has(normalized) && spellings.get(normalized) !== index)
        return 'A name or alternative points to more than one reviewed term.';
      if (spellings.has(normalized)) return 'Remove repeated names or alternatives.';
      spellings.set(normalized, index);
    }
  }
  return '';
}

export function CareVocabulary({ patientId, canManage, onAccessLost }: {
  patientId: string; canManage: boolean; onAccessLost: (message: string) => void;
}) {
  const [saved, setSaved] = useState<VocabularyView | null>(null);
  const [draft, setDraft] = useState<VocabularyTerm[]>([]);
  const [suggestions, setSuggestions] = useState<VocabularySuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(false);
  const selectedPatient = useRef(patientId);
  const saveGeneration = useRef(0);
  selectedPatient.current = patientId;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; saveGeneration.current++; };
  }, []);
  useEffect(() => {
    saveGeneration.current++;
    if (!canManage || !patientId) return;
    let active = true;
    setLoading(true); setSaved(null); setDraft([]); setSuggestions([]); setConflict(false); setMessage('');
    Promise.all([api.vocabulary(patientId), api.vocabularySuggestions(patientId)]).then(([view, options]) => {
      if (!active) return;
      setSaved(view); setDraft(view.terms.map(term => ({ ...term, aliases: [...term.aliases] })));
      setSuggestions(options.suggestions);
    }).catch(error => {
      if (!active) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) onAccessLost(error.status === 401
        ? 'Your session ended. Sign in again to view current care information.'
        : 'Your access to this care space changed. Sign in again to check your current access.');
      else setMessage(error instanceof Error ? error.message : 'Could not load reviewed names.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [patientId, canManage, onAccessLost]);

  const update = (index: number, term: VocabularyTerm) => setDraft(current => current.map((item, i) => i === index ? term : item));
  const validation = vocabularyError(draft);
  const changed = Boolean(saved && JSON.stringify(saved.terms) !== JSON.stringify(draft));
  async function save() {
    if (!saved || busy || validation || !changed) return;
    const sourcePatient = patientId;
    const generation = ++saveGeneration.current;
    const current = () => mounted.current && selectedPatient.current === sourcePatient && saveGeneration.current === generation;
    setBusy(true); setMessage('');
    try {
      const updated = await api.updateVocabulary(sourcePatient, saved.version, draft);
      if (!current()) return;
      setSaved(updated); setDraft(updated.terms.map(term => ({ ...term, aliases: [...term.aliases] })));
      setConflict(false); setMessage('Reviewed names saved.');
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        setMessage('Someone else saved a newer version. Your unsaved entries are still here. Compare them with the current saved version before saving again.');
        try { const latest = await api.vocabulary(sourcePatient); if (current()) setSaved(latest); }
        catch (refreshError) { if (current() && refreshError instanceof ApiError && [401, 403].includes(refreshError.status)) onAccessLost('Your access to this care space changed. Sign in again to check your current access.'); }
      } else if (error instanceof ApiError && [401, 403].includes(error.status)) {
        onAccessLost(error.status === 401 ? 'Your session ended. Sign in again to view current care information.' : 'Your access to this care space changed. Sign in again to check your current access.');
      } else setMessage(error instanceof Error ? error.message : 'Could not save reviewed names.');
    } finally { if (current()) setBusy(false); }
  }

  return <section className="card vocabulary-card" aria-label="Reviewed care names">
    <div className="section-heading"><div><span className="eyebrow">Care vocabulary</span><h2>Reviewed names</h2></div></div>
    <p className="section-intro">Add medicine and person names only after checking them. Alternatives are advisory context for interpreting a transcript; they never change the recorded words or settle an uncertain medicine, amount, or negation.</p>
    <p className="source-note">Custom vocabulary for speech recognition is unavailable for the current provider setup. Audio still uses normal recognition.</p>
    {!canManage ? <p className="source-note">Only an account with profile management permission can view or change these names.</p> : loading ? <p role="status">Loading reviewed names…</p> : <>
      {saved && <p className="source-note">Version {saved.version}{saved.reviewed_at ? ` · Reviewed ${niceDate(saved.reviewed_at)}` : ' · No reviewed names yet'}{saved.reviewed_by_user_id ? ' · Reviewed by an authorised account' : ''}</p>}
      {suggestions.length > 0 && <div className="vocabulary-suggestions"><h3>Names to consider</h3><p>These come from the current checked medicine plan and permitted people. Review each before adding it.</p><div className="vocabulary-suggestion-list">{suggestions.map((suggestion, index) => <button type="button" className="button" key={`${suggestion.category}-${suggestion.canonical}-${index}`} disabled={draft.length >= 100 || draft.some(term => key(term.canonical) === key(suggestion.canonical))} onClick={() => setDraft(current => [...current, { ...suggestion, aliases: [] }])}>Add {suggestion.canonical}</button>)}</div></div>}
      <div className="vocabulary-terms">{draft.map((term, index) => <fieldset className="vocabulary-term" key={index}><legend>Reviewed term {index + 1}</legend>
        <label>Checked name<input value={term.canonical} maxLength={80} onChange={event => update(index, { ...term, canonical: event.target.value })}/></label>
        <label>Category<select value={term.category} onChange={event => update(index, { ...term, category: event.target.value as VocabularyTerm['category'] })}><option value="medicine">Medicine</option><option value="person">Person</option><option value="other">Other</option></select></label>
        {term.aliases.map((alias, aliasIndex) => <div className="vocabulary-alias" key={aliasIndex}><label>Alternative {aliasIndex + 1}<input value={alias} maxLength={80} onChange={event => update(index, { ...term, aliases: term.aliases.map((value, i) => i === aliasIndex ? event.target.value : value) })}/></label><button type="button" className="button" onClick={() => update(index, { ...term, aliases: term.aliases.filter((_, i) => i !== aliasIndex) })}>Remove alternative</button></div>)}
        <div className="vocabulary-actions"><button type="button" className="button" disabled={term.aliases.length >= 5} onClick={() => update(index, { ...term, aliases: [...term.aliases, ''] })}>Add alternative</button><button type="button" className="button button-danger" onClick={() => setDraft(current => current.filter((_, i) => i !== index))}>Remove term</button></div>
      </fieldset>)}</div>
      <div className="vocabulary-actions"><button type="button" className="button" disabled={draft.length >= 100} onClick={() => setDraft(current => [...current, blank()])}>Add reviewed name</button><button type="button" className="button button-deep" disabled={!saved || busy || !changed || Boolean(validation)} onClick={save}>{busy ? 'Saving…' : 'Save reviewed names'}</button></div>
      {validation && <p role="alert" className="form-error">{validation}</p>}
      {message && <p role={conflict ? 'alert' : 'status'}>{message}</p>}
      {conflict && saved && <div className="vocabulary-conflict"><h3>Current saved version {saved.version}</h3><ul>{saved.terms.map((term, index) => <li key={index}>{term.canonical} ({term.category}){term.aliases.length ? ` — ${term.aliases.join(', ')}` : ''}</li>)}</ul><p>Your entries above remain unsaved. Check them against this version, then save if they are still correct.</p><button type="button" className="button" onClick={() => { setDraft(saved.terms.map(term => ({ ...term, aliases: [...term.aliases] }))); setConflict(false); setMessage('Current saved version loaded.'); }}>Use current saved version</button></div>}
    </>}
  </section>;
}
