import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, FileText, Heart, ListChecks, LogOut, Menu, Pill, Plus, RefreshCw, Settings, Shield, Sparkles, Stethoscope, Users, X } from 'lucide-react';
import { api, ApiError, CareQueryItem, Dashboard, label, localDay, niceDate, Patient, Proposal, Row, Session, setCsrf, str, SummaryPurpose, val } from './api';

import DeviceSetup from './DeviceSetup';
import { useSharedSummary } from './useSharedSummary';
import { RecordSource, RecordHistory } from './RecordSource';
import CompanionSelection from './CompanionSelection';
import { uiPreview } from './uiPreview';
import BrandLogo from './BrandLogo';
import { buildCareActions, CareAction } from './careActions';
import { CareActionInbox } from './CareActionInbox';
import { AskParse } from './AskParse';
import { CareVocabulary } from './CareVocabulary';
import { SummaryPrint } from './SummaryPrint';

type View = 'overview' | 'ask' | 'timeline' | 'medications' | 'care' | 'support' | 'summary' | 'settings';
const nav: { id: View; title: string; icon: typeof Heart }[] = [
  { id: 'overview', title: 'Today', icon: Activity }, { id: 'ask', title: 'Ask Parse', icon: Sparkles }, { id: 'timeline', title: 'Timeline', icon: CalendarDays },
  { id: 'medications', title: 'Medications', icon: Pill }, { id: 'care', title: 'Care plan', icon: ListChecks },
  { id: 'support', title: 'Support', icon: Users }, { id: 'summary', title: 'Visit summary', icon: FileText }, { id: 'settings', title: 'Settings', icon: Settings },
];
const safeDate = (v: unknown) => { const date = str(v) ? new Date(str(v)) : null; return date && !Number.isNaN(date.valueOf()) ? date : null; };
const stateText = (row: Row) => label(row, 'status', 'state', 'report_state') || 'Status unavailable';
const hasPermission = (permissions: string[] | undefined, permission: string) => Boolean(permissions?.includes('*') || permissions?.includes(permission));
const stablePayload = (value: unknown): string => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(stablePayload(item))]))
  : value) ?? 'undefined';
const displayName = (patient?: Patient) => patient?.preferred_name || patient?.name || 'Care space';
const demo = import.meta.env.VITE_DEMO_MODE === 'true';

export default function App() {
  const [boundary, setBoundary] = useState({ generation: 0, message: '' });
  const onAccessLost = useCallback((message: string) => {
    // Unmount every patient view/dialog and its state. Late requests from the
    // old session cannot repopulate a new sign-in, even for the same patient.
    setBoundary(current => current.generation === boundary.generation
      ? { generation: current.generation + 1, message } : current);
    setCsrf('');
  }, [boundary.generation]);
  return <CareApp key={boundary.generation} skipSession={boundary.generation > 0} initialLoginError={boundary.message} onAccessLost={onAccessLost}/>;
}

function CareApp({skipSession,initialLoginError,onAccessLost}:{skipSession:boolean;initialLoginError:string;onAccessLost:(message:string)=>void}) {
  const [session, setSession] = useState<Session | null>(null);
  const [patientId, setPatientId] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [view, setView] = useState<View>('timeline');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loginError, setLoginError] = useState(initialLoginError);
  const [refreshWarning, setRefreshWarning] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [noteForSharing, setNoteForSharing] = useState<Row | null>(null);
  const [proposalKind, setProposalKind] = useState('health_note');
  const [draftPayload, setDraftPayload] = useState<Record<string, unknown>>({});
  const [draftReadback, setDraftReadback] = useState('');
  const [composer, setComposer] = useState(false);
  const [composerKind, setComposerKind] = useState('health_note');
  const [composerSeed, setComposerSeed] = useState<Record<string,unknown>>({});
  const [mobileMenu, setMobileMenu] = useState(false);
  const [summary, setSummary] = useState<Row | null>(null);
  const [summaryPatientId, setSummaryPatientId] = useState('');
  const [summaryText, setSummaryText] = useState('');
  const [summaryPurpose, setSummaryPurpose] = useState<SummaryPurpose>('doctor_visit');
  const [summaryQuestions, setSummaryQuestions] = useState('');
  const [omittedSourceIds, setOmittedSourceIds] = useState<string[]>([]);
  const [summaryReviewed, setSummaryReviewed] = useState(false);
  const [toast, setToast] = useState('');
  const refreshInFlight = useRef(0);
  const dashboardRequest = useRef(0);
  const patientGeneration = useRef(0);
  const mutationInFlight = useRef(false);
  const mutationGeneration = useRef(0);
  const summaryEditGeneration = useRef(0);
  const summaryPresenceGrace = useRef('');
  const selectedPatient = useRef(patientId);
  const currentPatient = (id: string, generation: number) => mounted.current && selectedPatient.current === id && patientGeneration.current === generation;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const accessFailed = useCallback((error: unknown) => {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      if (mounted.current) onAccessLost(error.status === 401
        ? 'Your session ended. Sign in again to view current care information.'
        : 'Your access to this care space changed. Sign in again to check your current access.');
      return true;
    }
    return false;
  }, [onAccessLost]);
  const sharedToken = useMemo(() => uiPreview ? '' : window.location.pathname.match(/^\/shared\/summaries\/([^/]+)\/?$/)?.[1] || '', []);

  const publicView = useSharedSummary(sharedToken);

  const refreshSession = useCallback(async () => {
    const value = await api.session(); if (!mounted.current) return value; setSession(value); setCsrf(value.csrf_token);
    const selected = selectedPatient.current && value.patients.some(p => p.id === selectedPatient.current)
      ? selectedPatient.current : value.patients[0]?.id || '';
    if (selected !== selectedPatient.current) { patientGeneration.current++; dashboardRequest.current++; setDashboard(null); }
    selectedPatient.current = selected; setPatientId(selected);
    return value;
  }, []);
  const loadDashboard = useCallback(async (id: string) => {
    if (!id) return;
    const generation = patientGeneration.current;
    const request = ++dashboardRequest.current;
    setLoading(true); setError('');
    try { const next = await api.dashboard(id); if (currentPatient(id, generation) && request === dashboardRequest.current) { summaryPresenceGrace.current = ''; setDashboard(next); setRefreshWarning(''); } }
    catch (err) { if (currentPatient(id, generation) && request === dashboardRequest.current && !accessFailed(err)) setError(err instanceof Error ? err.message : 'Could not load this care space.'); }
    finally { if (currentPatient(id, generation) && request === dashboardRequest.current) setLoading(false); }
  }, [accessFailed]);
  useEffect(() => {
    if (sharedToken) return;
    if (skipSession) {
      setLoading(false);
    } else {
      refreshSession().then(value=>{if(!value.patients.length)setLoading(false);}).catch(err => {
        setSession(null);
        if (err instanceof ApiError && err.status >= 500) setLoginError(err.message);
        setLoading(false);
      });
    }
  }, [refreshSession, sharedToken, skipSession]);
  useEffect(() => { if (session && patientId) loadDashboard(patientId); }, [session, patientId, loadDashboard]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'auto' }); }, [view]);
  useEffect(() => {
    if (!session || !patientId || sharedToken || uiPreview) return;
    let active = true;
    const refresh = async () => {
      if (!active || document.visibilityState !== 'visible' || refreshInFlight.current !== 0) return;
      const generation = patientGeneration.current;
      const request = ++dashboardRequest.current;
      refreshInFlight.current = request;
      try {
        const value = await api.dashboard(patientId);
        if (active && currentPatient(patientId, generation) && request === dashboardRequest.current) { setDashboard(value); setRefreshWarning(''); setLoading(false); }
      } catch (err) {
        if (active && currentPatient(patientId, generation) && request === dashboardRequest.current && !accessFailed(err)) { setRefreshWarning('Connection interrupted. Showing the last loaded care information.'); setLoading(false); }
      }
      finally { if (refreshInFlight.current === request) refreshInFlight.current = 0; }
    };
    const timer = window.setInterval(refresh, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [session, patientId, sharedToken, accessFailed]);
  useEffect(() => {
    if (!dashboard || dashboard.patient.id !== patientId || summaryPatientId === patientId) return;
    const saved = (dashboard.summaries || []).find(item => !val(item,'invalidated_at') && item.source_access_current !== false);
    setSummary(saved || null); setSummaryText(saved ? summaryReadable(saved) : '');
    setSummaryPurpose(summaryPurposeOf(saved || null)); setSummaryQuestions(saved ? summaryQuestionsReadable(saved) : '');
    setOmittedSourceIds(saved && Array.isArray(saved.omitted_source_ids) ? saved.omitted_source_ids as string[] : []); setSummaryReviewed(Boolean(saved && (val(saved,'reviewed')===true||val(saved,'status')==='reviewed'))); setSummaryPatientId(patientId);
  }, [dashboard, patientId, summaryPatientId]);
  useEffect(() => {
    if (!summary?.id || !dashboard || dashboard.patient.id !== patientId) return;
    const current = (dashboard.summaries || []).find(item => item.id === summary.id);
    if ((!current && summaryPresenceGrace.current !== summary.id) || current?.source_access_current === false || current?.invalidated_at) {
      summaryEditGeneration.current++;
      setSummary(null); setSummaryText(''); setSummaryQuestions(''); setOmittedSourceIds([]); setSummaryReviewed(false);
      setToast('Summary access or a source record changed. Prepare and review a fresh draft.');
    }
  }, [dashboard, patientId, summary]);
  const patient = useMemo(() => (dashboard?.patient.id === patientId ? dashboard.patient : undefined) || session?.patients.find(p => p.id === patientId), [session, patientId, dashboard]);
  const canManageSharing = hasPermission(dashboard?.permissions, 'manage:sharing');
  const canWriteCare = hasPermission(dashboard?.permissions, 'write:care');
  const canManageDevices = hasPermission(dashboard?.permissions, 'manage:devices');
  const canManageProfile = hasPermission(dashboard?.permissions, 'manage:profile');
  const actions = useMemo(() => dashboard?.patient.id === patientId && session ? buildCareActions(dashboard, session.user.id, Date.now()) : [], [dashboard, patientId, session]);
  const evidenceRevision = useMemo(() => dashboard?.patient.id === patientId ? JSON.stringify({
    permissions: dashboard.permissions,
    measurements: dashboard.measurements.map(row => [row.id, row.version, row.superseded_at]),
    support: dashboard.support_requests.map(row => [row.id, row.status, row.recipient_user_id, row.resolved_at]),
    doses: dashboard.doses.map(row => [row.id, row.report_state, row.report_time, row.confirmation_proposal_id]),
  }) : '', [dashboard, patientId]);
  const [focusAction, setFocusAction] = useState<string | null>(null);
  useEffect(() => {
    if (!focusAction) return;
    const focus = () => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-action-source]')).find(element => element.dataset.actionSource === focusAction);
      if (!target) return false;
      target.focus(); target.scrollIntoView?.({ block: 'center' }); setFocusAction(null);
      return true;
    };
    if (focus()) return;
    const observer = new MutationObserver(() => { if (focus()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 2000);
    return () => { observer.disconnect(); window.clearTimeout(timeout); };
  }, [focusAction, view, dashboard]);
  function openCareAction(item: CareAction) {
    if (item.kind === 'proposal' && item.action === 'review') {
      const source = dashboard?.proposals.find(proposal => proposal.id === item.sourceId);
      if (source) openReview(source);
      return;
    }
    setFocusAction(item.key);
    setView(item.targetView);
  }
  async function openQuerySource(source: CareQueryItem) {
    const sourcePatient = patientId;
    const generation = patientGeneration.current;
    const request = ++dashboardRequest.current;
    try {
      const latest = await api.dashboard(sourcePatient);
      if (!currentPatient(sourcePatient, generation) || request !== dashboardRequest.current) return;
      setDashboard(latest);
      const viewFor = { measurement: 'timeline', support_request: 'support', dose: 'medications' } as const;
      const collection = source.source_type === 'measurement' ? latest.measurements :
        source.source_type === 'support_request' ? latest.support_requests : latest.doses;
      if (collection.some(row => row.id === source.source_id)) {
        setFocusAction(`${source.source_type}:${source.source_id}`);
        setView(viewFor[source.source_type]);
      } else {
        setToast('This source is current, but it is outside the recent dashboard view. Its details remain in Ask Parse.');
      }
    } catch (error) {
      if (currentPatient(sourcePatient, generation) && !accessFailed(error))
        setToast('The source is current, but the detailed view could not be refreshed. Its details remain in Ask Parse.');
    }
  }
  function choosePatient(id: string) {
    patientGeneration.current++;
    dashboardRequest.current++;
    refreshInFlight.current = 0;
    mutationGeneration.current++;
    summaryEditGeneration.current++;
    summaryPresenceGrace.current = '';
    mutationInFlight.current = false;
    selectedPatient.current = id;
    setDashboard(null); setLoading(true); setBusy(false); setProposal(null); setNoteForSharing(null); setComposer(false);
    setSummary(null); setSummaryPatientId(''); setSummaryText(''); setSummaryPurpose('doctor_visit'); setSummaryQuestions(''); setOmittedSourceIds([]); setSummaryReviewed(false);
    setFocusAction(null); setToast(''); setError(''); setRefreshWarning(''); setPatientId(id);
  }

  async function login(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setLoginError('');
    const data = new FormData(e.currentTarget);
    try { const value = await api.login(String(data.get('email')), String(data.get('password'))); if (!mounted.current) return; setSession(value); setCsrf(value.csrf_token); selectedPatient.current = value.patients[0]?.id || ''; setPatientId(selectedPatient.current); }
    catch (err) { setLoginError(err instanceof Error ? err.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  }
  async function logout() { setBusy(true); try { await api.logout(); } finally { if (mounted.current) onAccessLost(''); } }
  async function propose(kind: string, payload: Record<string, unknown>) {
    if (!patientId) return;
    const sourcePatient = patientId;
    const generation = patientGeneration.current;
    setBusy(true); setError('');
    try { const next = await api.createProposal(sourcePatient, kind, payload); if (currentPatient(sourcePatient, generation)) openReview(next); }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'The proposal could not be created.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  function openReview(value: Proposal) { setProposal(value); setProposalKind(value.kind); setDraftPayload(value.payload || {}); setDraftReadback(value.readback || 'Review the details below before confirming.'); setComposer(false); }
  async function revise() {
    if (!proposal) return;
    const sourcePatient = patientId;
    const generation = patientGeneration.current;
    setBusy(true); setError('');
    try { const revised = await api.reviseProposal(proposal.id, draftPayload); if (currentPatient(sourcePatient, generation)) { openReview(revised); setToast('Revised proposal created. Please review and confirm this version.'); } }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'Could not revise this proposal.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  async function confirmProposal() {
    if (!proposal) return;
    if (stablePayload(draftPayload) !== stablePayload(proposal.payload)) { setError('Review revised details before confirming. The original proposal is unchanged.'); return; }
    const sourcePatient = patientId;
    const generation = patientGeneration.current;
    setBusy(true); setError('');
    try { const result = await api.confirmProposal(proposal.id); if (result.status !== 'committed') throw new Error('The server has not confirmed this record as committed.'); if (currentPatient(sourcePatient, generation)) { setProposal(null); setToast('Confirmed and saved.'); await loadDashboard(sourcePatient); } }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'The record is not confirmed as saved.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  async function mutate(labelText: string, action: () => Promise<unknown>) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    const mutation = ++mutationGeneration.current;
    const sourcePatient = patientId;
    const generation = patientGeneration.current;
    setBusy(true); setError('');
    try { await action(); if (currentPatient(sourcePatient, generation)) { await loadDashboard(sourcePatient); if (currentPatient(sourcePatient, generation)) setToast(labelText); } }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'That change was not saved.'); }
    finally { if (mutation === mutationGeneration.current) mutationInFlight.current = false; if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  async function makeSummary(start: string, end: string, purpose: SummaryPurpose, questions: string[]) {
    const sourcePatient = patientId; const generation = patientGeneration.current;
    const editGeneration = summaryEditGeneration.current;
    setBusy(true); setError('');
    try { const row = await api.createSummary(sourcePatient, start, end, purpose, questions); if (currentPatient(sourcePatient, generation) && editGeneration === summaryEditGeneration.current) { summaryPresenceGrace.current = String(row.id); setSummary(row); setSummaryPatientId(sourcePatient); setSummaryText(summaryReadable(row)); setSummaryPurpose(summaryPurposeOf(row)); setSummaryQuestions(summaryQuestionsReadable(row)); setOmittedSourceIds([]); setSummaryReviewed(false); } }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'Could not prepare the summary.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  async function saveSummary() {
    if (!summary?.id) return;
    const sourcePatient = patientId; const generation = patientGeneration.current;
    const editGeneration = summaryEditGeneration.current;
    setBusy(true); setError('');
    try {
      const edits=parseSummaryDraft(summaryText,summary.sections as Row[]|undefined);
      const sections=(Array.isArray(summary.sections)?summary.sections as Row[]:[]).flatMap((section,sectionIndex)=>section.kind==='authored_questions'?[]:[{title:label(section,'title')||'Visit summary',items:(Array.isArray(section.items)?section.items as Row[]:[]).map((item,itemIndex)=>{const sourceId=label(item,'source_id');const edit=edits.find(entry=>entry.sectionIndex===sectionIndex&&entry.itemIndex===itemIndex);return {text:edit?.text??label(item,'text'),...(sourceId?{source_id:sourceId}:{})};}).filter(item=>!item.source_id||!omittedSourceIds.includes(String(item.source_id)))}]);
      const saved = await api.updateSummary(String(summary.id), { sections, questions: parseSummaryQuestions(summaryQuestions), omitted_source_ids: omittedSourceIds, reviewed: true });
      if (currentPatient(sourcePatient, generation) && editGeneration === summaryEditGeneration.current) { setSummary(saved); setSummaryText(summaryReadable(saved)); setSummaryQuestions(summaryQuestionsReadable(saved)); setOmittedSourceIds(Array.isArray(saved.omitted_source_ids) ? saved.omitted_source_ids as string[] : []); setSummaryReviewed(true); setToast('Review saved. It has not been shared.'); }
    }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'Review was not saved.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  async function revokeSummaryShare() {
    if (!summary?.id) return;
    const sourcePatient = patientId; const generation = patientGeneration.current;
    setBusy(true); setError('');
    try { await api.revokeSummaryShare(String(summary.id)); if (currentPatient(sourcePatient, generation)) { setSummary({...summary,url:null,share_token:null,expires_at:null,shared_at:null}); setToast('The read-only link has been revoked.'); } }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'The read-only link could not be revoked.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  async function shareSummary() {
    if (!summary?.id) return;
    const sourcePatient = patientId; const generation = patientGeneration.current;
    setBusy(true); setError('');
    try { const shared = await api.shareSummary(String(summary.id)); if (currentPatient(sourcePatient, generation)) { setSummary({...summary,...shared}); setToast('Read-only summary sharing is active.'); } }
    catch (err) { if (currentPatient(sourcePatient, generation)) setError(err instanceof Error ? err.message : 'Summary was not shared.'); }
    finally { if (currentPatient(sourcePatient, generation)) setBusy(false); }
  }
  function beginComposer(kind:string,seed:Record<string,unknown>={}) { setComposerKind(kind); setComposerSeed(seed); setComposer(true); }
  const greeting = view === 'timeline' ? `${displayName(patient)}’s care timeline` : ({overview:'Today’s care', ask:'Ask Parse', medications:'Medications', care:'Care plan', support:'Support', summary:'Visit summary', settings:'Care preferences'} as Partial<Record<View,string>>)[view];

  if (sharedToken) return <SharedSummaryPublic data={publicView.data} loading={publicView.loading} error={publicView.error} />;
  if (!session) return <Login onSubmit={login} loading={loading || busy} error={loginError} />;
  const d = dashboard?.patient.id === patientId ? dashboard : null;
  return <div className="app-shell">
    <header className="site-header">
      <button className="brand" aria-label="Parse home" onClick={() => { setView('timeline'); setMobileMenu(false); }}><BrandLogo /></button>
      <nav id="main-navigation" className={`nav-list ${mobileMenu ? 'nav-open' : ''}`} aria-label="Main navigation">{nav.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id); setMobileMenu(false); }}><span>{item.title}</span>{item.id === 'support' && d?.support_requests?.some(r => !['resolved','closed'].includes(stateText(r).toLowerCase())) && <i className="nav-dot" />}</button>)}</nav>
      <div className="header-account"><span className="avatar avatar-user" title={`${session.user.name} · ${session.user.role}`}>{initials(session.user.name)}</span><span className="account-name">{session.user.name}</span>{!uiPreview && <button className="icon-button" aria-label="Sign out" onClick={logout}><LogOut size={17}/></button>}</div>
      <button className="mobile-menu icon-button" aria-label={mobileMenu ? 'Close menu' : 'Open menu'} aria-controls="main-navigation" aria-expanded={mobileMenu} onClick={() => setMobileMenu(!mobileMenu)}>{mobileMenu ? <X size={21}/> : <Menu size={21}/>}</button>
    </header>
    <main className="main-area">
      <div className="page-content">
        {uiPreview && <div className="preview-banner" role="status"><strong>UI demo · fictional sample data</strong><span>Explore the care views. Nothing here is connected, saved, shared, or sent to a device.</span></div>}
        <div className="workspace-bar"><div className="patient-select-wrap"><label className="patient-select-label"><span>Care space</span><select value={patientId} onChange={e => choosePatient(e.target.value)} aria-label="Choose patient profile">{session.patients.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><ChevronDown size={14} className="select-chevron"/></div><div className="workspace-actions">{(demo || uiPreview) && <span className="demo-badge"><span className="demo-dot"/>{uiPreview ? 'Fictional UI demo' : 'Fictional demo data'}</span>}<button className="icon-button" aria-label="Refresh care data" onClick={() => loadDashboard(patientId)}><RefreshCw size={16}/></button></div></div>
        <div className="page-heading"><div><h1>{greeting}</h1><p className="lead">{weekdayDate(patient?.timezone)}<span className="page-timezone">{patient?.timezone.replaceAll('_',' ')}</span></p></div>{view !== 'summary' && canWriteCare && <button className="button button-primary" onClick={() => beginComposer('health_note')}><Plus size={19}/> Add entry</button>}</div>
        {(error || toast) && <div className={`feedback ${error ? 'feedback-error' : 'feedback-success'}`} role={error ? 'alert' : 'status'}>{error || toast}<button aria-label="Dismiss" onClick={() => { setError(''); setToast(''); }}><X size={15} /></button></div>}
        {refreshWarning && <p className="source-note" role="status">{refreshWarning}</p>}
        {loading ? <div className="loading-card"><span className="spinner" /><p>Loading confirmed care information…</p></div> : error && !d ? <div className="empty-card"><CircleHelp size={24} /><h2>This care space isn’t available</h2><p>Check your access or try again. No new information has been saved.</p><button className="button" onClick={() => loadDashboard(patientId)}>Try again</button></div> : d ? <>
          {view === 'overview' && <><CareActionInbox items={actions} onOpen={openCareAction}/><Overview data={d} canWriteCare={canWriteCare} onNavigate={setView} canShareNote={canManageSharing} canDeleteNote={canWriteCare} onShareNote={setNoteForSharing} onDeleteNote={deleteNote} onCompose={beginComposer} /></>}
          {view === 'ask' && <AskParse key={patientId} patientId={patientId} timezone={d.patient.timezone} sessionKey={session.csrf_token} evidenceRevision={evidenceRevision} preview={uiPreview} onOpenSource={openQuerySource} onSessionExpired={() => onAccessLost('Your session ended. Sign in again to view current care information.')}/>}
    {view === 'timeline' && <Timeline key={patientId} data={d} focusSource={focusAction} onNavigate={setView} onReviewProposal={openReview} onCorrect={row=>beginComposer('measurement',measurementSeed(row))} canWriteCare={canWriteCare} canShareNote={canManageSharing} canDeleteNote={canWriteCare} onShareNote={setNoteForSharing} onDeleteNote={deleteNote} />}
          {view === 'medications' && <Medications data={d} canWriteCare={canWriteCare} onCompose={beginComposer} onPlan={payload => mutate('Medication plan saved after review.', () => api.createMedicationPlan(patientId, payload))} busy={busy} />}
          {view === 'care' && <CarePlan data={d} canWriteCare={canWriteCare} onCompose={beginComposer} onCreate={(kind,payload) => propose(kind,payload)} />}
          {view === 'support' && <Support data={d} currentUserId={session.user.id} canWriteCare={canWriteCare} onCompose={beginComposer} onCreate={(kind,payload)=>propose(kind,payload)} onAcknowledge={id => mutate('Request acknowledged.', () => api.acknowledge(id))} onResolve={(id,outcome) => mutate('Resolution saved.', () => api.resolve(id,outcome))} />}
          {view === 'summary' && (canManageSharing ? <Summary timezone={patient?.timezone || dashboard?.patient.timezone || 'Asia/Singapore'} patientId={patientId} patientName={displayName(patient)} identityKey={`${session.user.id}:${session.csrf_token}:${patientId}`} summary={summary} summaryText={summaryText} setSummaryText={text=>{summaryEditGeneration.current++;setSummaryText(text);setSummaryReviewed(false);}} purpose={summaryPurpose} setPurpose={value=>{summaryEditGeneration.current++;setSummaryPurpose(value);setSummaryReviewed(false);}} questionsText={summaryQuestions} setQuestionsText={value=>{summaryEditGeneration.current++;setSummaryQuestions(value);setSummaryReviewed(false);}} omittedSourceIds={omittedSourceIds} setOmittedSourceIds={ids=>{summaryEditGeneration.current++;setOmittedSourceIds(ids);setSummaryReviewed(false);}} reviewed={summaryReviewed} makeSummary={makeSummary} saveSummary={saveSummary} shareSummary={shareSummary} revokeShare={revokeSummaryShare} busy={busy} /> : <section className="card empty-card"><Shield size={24}/><h2>Summary sharing is owner managed</h2><p>This account does not have permission to prepare or share appointment summaries.</p></section>)}
          {view === 'settings' && <><SettingsView onReleaseRemoved={(id,generation)=>mutate('Old phone removed. Choose a companion to resume reminders.',()=>api.releaseRemovedPhone(id,generation))} onSelect={(id,generation,poweredOff)=>mutate('Reminder companion updated.',()=>api.selectCompanion(patientId,id,generation,poweredOff))} data={d} patient={d.patient} onProfile={payload=>mutate('Care preferences saved.',()=>api.updateProfile(patientId,payload))} onClaim={(code,kind) => mutate(kind==='phone'?'Companion paired. Return to the Parse companion.':'Cardholder paired. Connect it to Wi-Fi to bring it online.',()=>kind==='phone'?api.approvePhone(code,patientId):api.claimDevice(code,patientId))} onRevoke={id => mutate('Device access revoked.', () => api.revokeDevice(id))} onGrant={(userId,scopes)=>mutate('Sharing permission added.',()=>api.grant(patientId,userId,scopes))} onRevokeGrant={id=>mutate('Sharing permission removed.',()=>api.revokeGrant(id))} canManageSharing={canManageSharing} canManageDevices={canManageDevices && !uiPreview} canManageProfile={canManageProfile} /><CareVocabulary key={patientId} patientId={patientId} canManage={canManageProfile && !uiPreview} onAccessLost={onAccessLost}/></>}
        </> : <div className="empty-card"><Heart size={25} /><h2>Your care space is ready</h2><p>There are no care records to show yet.</p></div>}
        <footer className="page-footer"><span>Parse · Your everyday care record</span><span><a href="/landing/">About Parse</a><Shield size={13}/> Shared only with permission</span></footer>
      </div>
    </main>
    {composer && d && <Composer kind={composerKind} doses={d.doses} recipients={d.allowed_recipients||[]} seed={composerSeed} timezone={patient?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone} setKind={setComposerKind} onClose={() => setComposer(false)} onCreate={propose} busy={busy} />}
    {noteForSharing && d && canManageSharing && <NoteSharingDialog note={noteForSharing} grants={d.access_grants||[]} busy={busy} onClose={()=>setNoteForSharing(null)} onSave={async ids=>{const sourcePatient=patientId;const generation=patientGeneration.current;setBusy(true);setError('');try{await api.setNoteSharing(String(noteForSharing.id),ids);if(currentPatient(sourcePatient,generation)){setNoteForSharing(null);setSummary(null);setSummaryPatientId('');setSummaryText('');setSummaryPurpose('doctor_visit');setSummaryQuestions('');setOmittedSourceIds([]);setSummaryReviewed(false);await loadDashboard(sourcePatient);if(currentPatient(sourcePatient,generation))setToast('Note sharing updated. Any affected summary must be prepared and reviewed again.');}}catch(err){if(currentPatient(sourcePatient,generation))setError(err instanceof Error?err.message:'Note sharing was not updated.');}finally{if(currentPatient(sourcePatient,generation))setBusy(false);}}} />}
    {proposal && <ReviewDialog key={proposal.id} kind={proposalKind} payload={draftPayload} setPayload={setDraftPayload} readback={draftReadback} expiresAt={proposal.expires_at} revise={revise} confirm={confirmProposal} busy={busy} error={error} onClose={() => setProposal(null)} />}
  </div>;

  async function deleteNote(note: Row) {
    const wording = label(note, 'wording', 'text', 'content', 'note') || 'this care note';
    if (!window.confirm(`Delete “${wording}”? This will also invalidate summaries that cite it.`)) return;
    const sourcePatient = patientId; const generation = patientGeneration.current;
    await mutate('Care note deleted. Affected summaries are no longer valid.', () => api.deleteNote(String(note.id)));
    if (currentPatient(sourcePatient, generation)) { setSummary(null); setSummaryPatientId(''); setSummaryText(''); setSummaryPurpose('doctor_visit'); setSummaryQuestions(''); setOmittedSourceIds([]); setSummaryReviewed(false); }
  }
}

function measurementSeed(row:Row):Record<string,unknown> { const value=val(row,'occurred_at'); const date=value?new Date(String(value)):null; const local=date&&!Number.isNaN(date.valueOf())?`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:''; return {supersedes_id:row.id,measurement_type:'blood_pressure',systolic:val(row,'systolic'),diastolic:val(row,'diastolic'),unit:label(row,'unit')||'mmHg',occurred_at:local,occurrence_text:local?'':label(row,'occurrence_text'),timezone:label(row,'timezone'),source_description:label(row,'source_description'),reporting_actor:label(row,'reporting_actor')||'patient'}; }
function initials(name: string) { return name.split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase(); }
function weekdayDate(timezone?: string) { return new Intl.DateTimeFormat('en-SG', { timeZone:timezone, weekday:'long', month:'long', day:'numeric' }).format(new Date()); }
function Login({ onSubmit, loading, error }: { onSubmit: (e: React.FormEvent<HTMLFormElement>) => void; loading: boolean; error: string }) { return <main className="login-page"><div className="login-aside"><a className="brand brand-light" href="/landing/" aria-label="Parse, about"><BrandLogo /></a><div className="login-message"><span className="eyebrow">Care, connected</span><h1>A little more clarity, for the moments that matter.</h1><p>A thoughtful space for the notes, routines and follow-ups you choose to share.</p></div><div className="login-footer">Private by design · Shared with permission</div></div><div className="login-main"><form className="login-form" onSubmit={onSubmit}><span className="eyebrow">Welcome back</span><h2>Sign in to your care space</h2><p>Use the account provided for your Parse demo.</p><label>Email address<input type="email" name="email" autoComplete="username" required placeholder="you@example.com" /></label><label>Password<input type="password" name="password" autoComplete="current-password" required placeholder="Enter your password" /></label>{error && <div className="inline-error" role="alert">{error}</div>}<button className="button button-primary button-wide" disabled={loading}>{loading ? 'Signing in…' : 'Continue'}<span>→</span></button><div className="login-help"><Shield size={14} />Your session is protected by a secure sign-in.</div></form></div></main>; }

function SectionHead({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: React.ReactNode }) { return <div className="section-head"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div>{action}</div>; }
function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) { return <div className="empty-inline"><span className="empty-icon"><Sparkles size={16}/></span><div><b>{title}</b><p>{text}</p>{action}</div></div>; }
function Status({ children, warm = false }: { children: React.ReactNode; warm?: boolean }) { return <span className={`status ${warm ? 'status-warm' : ''}`}><span className="status-dot" />{children}</span>; }

function Overview({ data, onNavigate, canShareNote, canDeleteNote, canWriteCare, onShareNote, onDeleteNote, onCompose }: { data: Dashboard; canWriteCare:boolean; canShareNote:boolean; canDeleteNote:boolean; onNavigate: (v: View) => void; onShareNote:(note:Row)=>void; onDeleteNote:(note:Row)=>void; onCompose: (kind:string,seed?:Record<string,unknown>)=>void }) {
  const pendingRequests = data.support_requests.filter(r => !['resolved','closed'].includes(stateText(r).toLowerCase()));
  const activePlan = data.medication_plans.find(plan => plan.active === true);
  const today = localDay(new Date(), data.patient.timezone);
  const meds = data.doses.filter(dose => {
    const scheduled = safeDate(dose.scheduled_at);
    return activePlan && dose.plan_version === activePlan.version && scheduled && !Number.isNaN(scheduled.valueOf()) && localDay(scheduled, data.patient.timezone) === today;
  }).sort((a,b) => new Date(String(a.scheduled_at)).valueOf() - new Date(String(b.scheduled_at)).valueOf()).slice(0,4);
  const notes = data.notes.slice(0,1); const tasks = data.preventive_tasks.filter(t => !['completed','declined'].includes(stateText(t).toLowerCase())).slice(0,2);
  const latest = data.measurements.filter(m => label(m,'type','kind').toLowerCase().includes('blood') || val(m,'systolic') !== null).slice(0,4);
  const device = data.devices.find(item=>item.id===data.active_companion?.device_id);
  return <div className="view-stack">
    <div className="metric-row"><Metric value={String(data.notes.length)} label="Confirmed notes" icon={FileText} detail="In this care space"/><Metric value={String(pendingRequests.length)} label="Open support requests" icon={Users} detail="Awaiting follow-up"/><Metric value={String(data.preventive_tasks.filter(t => ['due','needs_discussion'].includes(stateText(t).toLowerCase())).length)} label="Tasks to check" icon={CalendarDays} detail="From the care plan"/></div>
    <div className="dashboard-grid"><div className="column-stack">
      <section className="card"><SectionHead title="Today’s medication check-ins" action={<button className="text-link" onClick={() => onNavigate('medications')}>Open plan <span>→</span></button>}/>{meds.length ? <div className="list">{meds.map((dose,i)=><DoseRow key={String(dose.id||i)} row={dose}/>)}</div> : <Empty title="No dose reports yet" text="An unanswered reminder stays unconfirmed." action={<button className="text-link" onClick={() => onNavigate('medications')}>View medication plan →</button>}/>}<div className="card-footnote"><Shield size={14}/> A reminder or playback does not mean a dose was taken.</div></section>
      <section className="card"><SectionHead title="In their own words" action={<button className="text-link" onClick={() => onNavigate('timeline')}>See timeline <span>→</span></button>}/>{notes.length ? notes.map((note,i)=><NotePreview row={note} key={String(note.id||i)} onShare={canShareNote?()=>onShareNote(note):undefined} onDelete={canDeleteNote?()=>onDeleteNote(note):undefined}/>) : <Empty title="No confirmed notes yet" text="New notes stay as proposals until reviewed and confirmed." action={canWriteCare&&<button className="text-link" onClick={() => onCompose('health_note')}>Start a note →</button>}/>}</section>
      <section className="card"><SectionHead title="Blood pressure history" action={<button className="text-link" onClick={() => onNavigate('timeline')}>See history <span>→</span></button>}/>{latest.length ? <PressureChart rows={latest} onCorrect={row=>onCompose('measurement',measurementSeed(row))}/> : <Empty title="No readings recorded" text="Parse does not measure blood pressure. Readings come from a person's existing monitor and are saved after confirmation." action={canWriteCare&&<button className="text-link" onClick={() => onCompose('measurement')}>Add a reported reading →</button>}/>}</section>
    </div><div className="column-stack">
      <section className="card card-highlight"><div className="highlight-top"><span className="eyebrow">A little help needed</span><span className="highlight-symbol"><Heart size={16}/></span></div>{pendingRequests.length ? <><h3>{label(pendingRequests[0],'title','request','request_text','text') || 'Support request'}</h3><p className="request-quote">{label(pendingRequests[0],'request_text','description','content','text') || 'A support request was shared.'}</p><div className="request-meta">{niceDate(val(pendingRequests[0],'created_at','occurred_at'))} · {stateText(pendingRequests[0])}</div><button className="button button-deep" onClick={() => onNavigate('support')}>View request <span>→</span></button></> : <Empty title="No open requests" text="Support requests appear here when shared with you."/>}</section>
      <section className="card"><SectionHead title="Care plan" action={<button className="text-link" onClick={() => onNavigate('care')}>View all <span>→</span></button>}/>{tasks.length ? <div className="mini-task-list">{tasks.map((t,i)=><div key={String(t.id||i)} className="mini-task"><span className="task-icon"><Stethoscope size={16}/></span><div><b>{label(t,'title','description','task_type') || 'Care plan task'}</b><span>{stateText(t)}{val(t,'due_date') ? ` · due ${niceDate(val(t,'due_date'))}` : ''}</span></div></div>)}</div> : <Empty title="No upcoming tasks" text="Tasks are added from an existing care plan."/>}</section>
      <section className="card device-card"><SectionHead title="Companion device" action={<button className="icon-button" aria-label="Open settings" onClick={() => onNavigate('settings')}><Settings size={16}/></button>}/>{device ? <><Status warm={['offline','disconnected'].includes(label(device,'connection_status','status').toLowerCase())}>{label(device,'connection_status','status') || 'Status unavailable'}</Status><div className="device-meta"><span>Last seen</span><b>{niceDate(val(device,'last_seen'))}</b></div><div className="device-meta"><span>Battery</span><b>{val(device,'battery_percent') != null ? `${val(device,'battery_percent')}%` : val(device,'battery_mv') != null ? `${(Number(val(device,'battery_mv'))/1000).toFixed(2)} V` : 'Unavailable'}</b></div></> : <Empty title="No reminder companion selected" text="Select a paired companion in settings when it is ready." action={<button className="text-link" onClick={() => onNavigate('settings')}>Device settings →</button>}/>}</section>
    </div></div>
  </div>;
}
function Metric({value,label:labelText,icon:Icon,detail}: {value:string;label:string;icon:typeof Heart;detail:string}) { return <div className="metric"><div className="metric-icon"><Icon size={17}/></div><strong>{value}</strong><span>{labelText}</span><small>{detail}</small></div>; }
function DoseRow({row}: {row:Row}) { const status=stateText(row); const timing=niceDate(val(row,'scheduled_at','due_at'), 'Time not provided'); return <div className="dose-row"><div className="dose-time">{timing}</div><div className="dose-body"><div><b>{label(row,'medicine_name','medication_name','name') || 'Medication'}</b><span>{label(row,'instructions','dose','detail') || 'Dose details not provided'}</span></div><Status warm={!status.toLowerCase().includes('taken')}>{prettyState(status)}</Status></div></div>; }
function prettyState(s:string) { return s.replaceAll('_',' ').replace(/^reported /,'Reported ').replace(/\b\w/g,c=>c.toUpperCase()); }
function NotePreview({row,onShare,onDelete}: {row:Row;onShare?:()=>void;onDelete?:()=>void}) { const text=label(row,'wording','text','content','summary','note') || 'Confirmed note'; return <><blockquote className="note-quote">“{text}”</blockquote><div className="note-meta"><CheckCircle2 size={14}/>Confirmed · {niceDate(val(row,'confirmed_at','created_at','occurred_at'))}{label(row,'shared_with','recipient') ? ` · Shared with ${label(row,'shared_with','recipient')}` : ''}</div><RecordSource row={row}/>{onShare&&<button className="text-link note-share" onClick={onShare}>Manage sharing →</button>}{onDelete&&<button className="text-link note-share note-delete" onClick={onDelete}>Delete note</button>}</>; }

type TimelineFilter = 'All entries' | 'Medication' | 'Notes' | 'Readings';
type TimelineEntry = { kind: string; row: Row; date: Date | null };
const timelineFilters: TimelineFilter[] = ['All entries', 'Medication', 'Notes', 'Readings'];
function clockTime(date: Date, timezone: string) { return date.toLocaleTimeString('en-GB', {timeZone:timezone, hour:'2-digit', minute:'2-digit'}); }
function entryDate(row: Row) { return safeDate(val(row,'report_time','occurred_at','confirmed_at','updated_at','created_at')); }
function timelineTitle(kind: string, row: Row) {
  if (kind === 'Confirmed note') return label(row,'wording','title','text','content') || 'Care note';
  if (kind === 'Medication report') return label(row,'medicine_name','medication_name','name') || 'Medication';
  if (kind === 'Blood pressure reading') return `${val(row,'systolic') ?? '—'} / ${val(row,'diastolic') ?? '—'} ${label(row,'unit','units') || 'mmHg'}`;
  if (kind === 'Care plan update') return label(row,'description','title','task_type') || 'Care plan task';
  return label(row,'request_text','title','request','text') || 'Support request';
}
function timelineMeta(kind: string, row: Row) {
  if (kind === 'Confirmed note') return `Confirmed care note · ${row.occurred_at ? 'Reported time' : 'Time saved'}${label(row,'occurrence_text') ? ` · ${label(row,'occurrence_text')}` : ''}`;
  if (kind === 'Medication report') return prettyState(stateText(row));
  if (kind === 'Blood pressure reading') return `Reported reading · ${label(row,'source_description','source') || 'Source not provided'}`;
  if (kind === 'Care plan update') return `Care plan · ${prettyState(stateText(row))}`;
  return `Support request · ${prettyState(stateText(row))}`;
}
function Timeline({data,focusSource,onNavigate,onReviewProposal,canShareNote,canDeleteNote,canWriteCare,onShareNote,onDeleteNote,onCorrect}: {data:Dashboard;focusSource?:string|null;onNavigate:(view:View)=>void;onCorrect:(measurement:Row)=>void;onReviewProposal:(proposal:Proposal)=>void;canWriteCare:boolean;canShareNote:boolean;canDeleteNote:boolean;onShareNote:(note:Row)=>void;onDeleteNote:(note:Row)=>void}) {
  const [filter,setFilter] = useState<TimelineFilter>('All entries');
  const [expanded,setExpanded] = useState<string | null>(null);
  const [visibleCount,setVisibleCount] = useState(12);
  const timezone = data.patient.timezone;
  const categories: [string, Row[]][] = [
    ['Confirmed note',data.notes],
    ['Medication report',data.doses.filter(row => Boolean(row.report_time) && label(row,'report_state').startsWith('reported_'))],
    ['Blood pressure reading',data.measurements], ['Care plan update',data.preventive_tasks], ['Support request',data.support_requests],
  ];
  const all = categories.flatMap(([kind,rows]) => rows.map(row => ({kind,row,date:entryDate(row)})))
    .filter(entry => filter === 'All entries' || entry.kind === ({Medication:'Medication report',Notes:'Confirmed note',Readings:'Blood pressure reading'} as Partial<Record<TimelineFilter,string>>)[filter])
    .sort((a,b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  useEffect(() => {
    if (!focusSource) return;
    const index = all.findIndex(entry => `${entry.kind === 'Blood pressure reading' ? 'measurement' : entry.kind === 'Support request' ? 'support_request' : entry.kind === 'Medication report' ? 'dose' : ''}:${entry.row.id}` === focusSource);
    if (index >= 0) setVisibleCount(Math.max(12, index + 1));
  }, [focusSource, data]);
  const groups = new Map<string,TimelineEntry[]>();
  for (const entry of all.slice(0,visibleCount)) {
    const day = entry.date ? localDay(entry.date,timezone) : 'undated';
    groups.set(day,[...(groups.get(day) || []),entry]);
  }
  return <div className="timeline-layout">
    <div className="timeline-main">
      <div className="timeline-filters" role="group" aria-label="Filter timeline">{timelineFilters.map(item => <button key={item} className={`filter-button ${filter === item ? 'active' : ''}`} aria-pressed={filter === item} onClick={() => {setFilter(item);setVisibleCount(12);}}>{item}</button>)}</div>
      <section className="care-timeline" aria-label="Care timeline">
        {all.length ? Array.from(groups,([day,entries]) => <section className="timeline-day" key={day} aria-label={day === 'undated' ? 'Date not recorded' : day}>
          <h2 className="timeline-date">{day === 'undated' ? 'Date not recorded' : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-SG',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long',year:'numeric'})}</h2>
          <div className="timeline">{entries.sort((a,b) => (a.date?.getTime() ?? 0)-(b.date?.getTime() ?? 0)).map(({kind,row,date},i) => {
            const key = `${kind}-${row.id || i}`;
            const open = expanded === key;
            return <article className="timeline-item" key={key} data-action-source={`${kind === 'Blood pressure reading' ? 'measurement' : kind === 'Support request' ? 'support_request' : kind === 'Medication report' ? 'dose' : ''}:${String(row.id)}`} tabIndex={-1}>
              <time className="timeline-time" dateTime={date?.toISOString()}>{date ? clockTime(date,timezone) : '—'}</time>
              <div className="timeline-rail"><span className="timeline-dot"/></div>
              <div className="timeline-content"><div className="timeline-heading"><div><h3>{timelineTitle(kind,row)}</h3><p className="timeline-meta">{timelineMeta(kind,row)}</p><RecordSource row={row}/></div><button className="timeline-view" aria-expanded={open} aria-controls={`entry-${key}`} onClick={() => setExpanded(open ? null : key)}>{open ? 'Close' : 'View'}<ChevronRight size={17}/></button></div>
                {open && <div className="timeline-detail" id={`entry-${key}`}><RecordHistory row={row}/>
                  {kind === 'Confirmed note' && <><p>{(row.shared_with_user_ids as string[] | undefined)?.length ? `Shared with ${(row.shared_with_user_ids as string[]).length} selected recipient(s).` : 'Not shared with other care members.'}</p>{canShareNote && <button className="text-link note-share" onClick={() => onShareNote(row)}>Manage sharing →</button>}{canDeleteNote && <button className="text-link note-share note-delete" onClick={() => onDeleteNote(row)}>Delete note</button>}</>}
                  {kind === 'Medication report' && <p>Scheduled: {niceDate(row.scheduled_at)}. This is a reported status; reminder delivery does not confirm a dose was taken.{row.taken_time_text ? ` Reported timing: ${str(row.taken_time_text)}.` : ''}</p>}
                  {kind === 'Blood pressure reading' && <><p>Reporter: {label(row,'reporting_actor') || 'Not recorded'}. {label(row,'occurrence_text') ? `Reported timing: ${label(row,'occurrence_text')}.` : ''}{!row.occurred_at && ' The time shown is when this reading was saved.'}</p>{canWriteCare && <button className="text-link" onClick={() => onCorrect(row)}>Correct this reading →</button>}</>}
                  {kind === 'Care plan update' && <><p>Source: {label(row,'source') || 'Not recorded'}. {row.due_date ? `Due ${niceDate(row.due_date)}.` : ''} {row.appointment_date ? `Appointment ${niceDate(row.appointment_date)}.` : ''}</p><button className="text-link" onClick={() => onNavigate('care')}>Open care plan →</button></>}
                  {kind === 'Support request' && <button className="text-link" onClick={() => onNavigate('support')}>Open support request →</button>}
                </div>}
              </div>
            </article>;
          })}</div>
        </section>) : <Empty title={filter === 'All entries' ? 'Your timeline starts here' : `No ${filter.toLowerCase()} entries yet`} text="Confirmed notes, medication reports and readings will appear here."/>}
      </section>
      {all.length > visibleCount && <button className="button load-entries" onClick={() => setVisibleCount(count => count + 12)}>Show more entries <span>({all.length - visibleCount})</span></button>}
      <ProposalList proposals={data.proposals} canReview={canWriteCare} onReview={onReviewProposal}/>
    </div>
    <CareAside data={data} onNavigate={onNavigate}/>
  </div>;
}
function CareAside({data,onNavigate}: {data:Dashboard;onNavigate:(view:View)=>void}) {
  const timezone = data.patient.timezone;
  const activePlan = data.medication_plans.find(plan => plan.active === true);
  const comingUp = data.doses.filter(row => activePlan && row.plan_version === activePlan.version && !row.report_time && !label(row,'report_state').startsWith('reported_') && (safeDate(row.scheduled_at)?.getTime() ?? 0) > Date.now())
    .sort((a,b) => safeDate(a.scheduled_at)!.getTime()-safeDate(b.scheduled_at)!.getTime()).slice(0,2);
  const today = localDay(new Date(),timezone);
  const visit = data.preventive_tasks.filter(row => row.state === 'arranged' && label(row,'appointment_date') >= today).sort((a,b) => label(a,'appointment_date').localeCompare(label(b,'appointment_date')))[0];
  const recipients = data.allowed_recipients || [];
  const device = data.devices.find(row => row.id === data.active_companion?.device_id);
  return <aside className="care-aside" aria-label="Care at a glance">
    <section className="aside-section"><h2>Coming up</h2>{comingUp.length ? comingUp.map(row => <div className="upcoming-dose" key={row.id}><p><time>{clockTime(safeDate(row.scheduled_at)!,timezone)}</time><span>·</span><b>{label(row,'medicine_name') || 'Medication'}</b></p><small>{localDay(safeDate(row.scheduled_at)!,timezone) === today ? 'Today' : niceDate(localDay(safeDate(row.scheduled_at)!,timezone))} · No report yet</small></div>) : <p className="aside-empty">No upcoming doses scheduled.</p>}<button className="text-link" onClick={() => onNavigate('medications')}>View medication plan <span>→</span></button></section>
    <section className="aside-section"><h2>Next visit</h2>{visit ? <><div className="visit-date"><span className="aside-icon"><CalendarDays size={21}/></span><b>{niceDate(visit.appointment_date)}</b></div><p className="aside-empty">{label(visit,'description')}</p></> : <p className="aside-empty">No arranged visit recorded.</p>}<button className="text-link" onClick={() => onNavigate('care')}>Open care plan <span>→</span></button></section>
    <section className="aside-section"><h2>Care circle</h2>{recipients.length ? recipients.map(person => <div className="care-person" key={person.id}><span className="avatar">{initials(label(person,'name'))}</span><div><b>{label(person,'name')}</b><span>{prettyState(label(person,'relationship'))}</span></div></div>) : <p className="aside-empty">Care circle details are not available for this account.</p>}</section>
    <button className="device-status" onClick={() => onNavigate('settings')}><span className={`device-dot ${device?.status === 'connected' ? 'is-connected' : ''}`}/><span>{device ? `${device.device_type === 'phone' ? device.platform === 'web' ? 'Browser' : 'Phone' : 'Cardholder'} ${device.status === 'connected' ? 'connected' : device.status === 'revoked' ? 'revoked' : 'not connected'}` : data.active_companion ? 'No reminder companion selected' : 'Device status unavailable'}{Boolean(device?.last_seen) && <small>Last seen {niceDate(device?.last_seen)}</small>}</span><ChevronRight size={15}/></button>
  </aside>;
}
function ProposalList({proposals,canReview,onReview}:{proposals:Proposal[];canReview:boolean;onReview:(proposal:Proposal)=>void}) { const awaiting=proposals.filter(p=>['pending','awaiting_confirmation'].includes(p.status)); return awaiting.length>0?<section className="card proposal-list"><SectionHead eyebrow="Needs a decision" title="Proposals awaiting confirmation"/>{awaiting.map(p=>{const expired=Boolean(p.expires_at&&Date.now()>=new Date(p.expires_at).getTime());return <div className="proposal-row" key={p.id} data-action-source={`proposal:${p.id}`} tabIndex={-1}><Clock3 size={16}/><div><b>{prettyState(p.kind)}</b><p>{p.readback||'Review the proposal details before confirming.'}</p><small>{expired?'Expired':p.expires_at?`Expires ${niceDate(p.expires_at)}`:'Expiry unavailable'}</small></div>{canReview&&<button className="button" disabled={expired} onClick={()=>onReview(p)}>{expired?'Expired':'Review'}</button>}<span className="status status-warm">Not saved</span></div>;})}</section>:null; }

function Medications({data,onCompose,onPlan,busy,canWriteCare}:{data:Dashboard;canWriteCare:boolean;onCompose:(kind:string)=>void;onPlan:(p:Record<string,unknown>)=>void;busy:boolean}) {
 const emptyForm={name:'',instructions:'',schedule:'',timezone:data.patient?.timezone||'',source:''};
 const [add,setAdd]=useState(false);const [checked,setChecked]=useState(false);const [editingId,setEditingId]=useState('');const [form,setForm]=useState(emptyForm);
 const plans=data.medication_plans;const active=plans.find(p=>p.active===true)||plans[0];
 const editMedicine=(medicine:Row,plan:Row)=>{const id=String(val(medicine,'id')||'');const schedule=Array.isArray(plan.schedule)?(plan.schedule as Row[]).find(item=>String(val(item,'medicine_id'))===id):undefined;setEditingId(id);setForm({name:label(medicine,'name','medicine_name'),instructions:label(medicine,'instructions','dose'),schedule:label(schedule||{},'local_time'),timezone:label(plan,'timezone')||data.patient?.timezone||'',source:label(medicine,'reference_source')||label(plan,'source')});setChecked(false);setAdd(true);};
 const change=(key:keyof typeof emptyForm,value:string)=>{setForm(prev=>({...prev,[key]:value}));setChecked(false);};
 const savePlan=()=>{const oldMeds=Array.isArray(active?.medicines)?active.medicines as Row[]:[];const oldSchedule=Array.isArray(active?.schedule)?active.schedule as Row[]:[];const medId=editingId||`med_${Date.now()}`;const medicine={id:medId,name:form.name,instructions:form.instructions,reviewed_reference:form.instructions,reference_source:form.source};const medicines=editingId?oldMeds.map(m=>String(val(m,'id'))===editingId?medicine:m):[...oldMeds,medicine];const schedule=editingId?oldSchedule.map(item=>String(val(item,'medicine_id'))===editingId?{...item,local_time:form.schedule}:item):[...oldSchedule,{medicine_id:medId,local_time:form.schedule}];onPlan({timezone:form.timezone||data.patient?.timezone||'',source:[active?.source?`Existing plan: ${String(active.source)}`:'',`Reviewed entry: ${form.source}`].filter(Boolean).join(' · '),checked:true,medicines,schedule});};
 return <div className="view-stack"><section className="card"><SectionHead eyebrow="Checked medication plan" title="Current instructions" action={canWriteCare&&<button className="button button-primary" onClick={()=>{if(add){setAdd(false);setEditingId('');setChecked(false);}else{setForm(emptyForm);setEditingId('');setChecked(false);setAdd(true);}}}><Plus size={15}/>{add?'Close':active?'Add medicine':'Create plan'}</button>}/><p className="section-intro">Only activate a plan after checking each medicine and instruction against the current prescription or label. Parse does not suggest dose changes.</p>{add&&<div className="form-card"><h3>{editingId?'Edit a checked medication entry':'Review a medication entry'}</h3><div className="form-grid"><Field label="Medicine name" value={form.name} onChange={v=>change('name',v)}/><Field label="Instructions from label" value={form.instructions} onChange={v=>change('instructions',v)}/><Field label="Schedule and time" value={form.schedule} onChange={v=>change('schedule',v)} type="time"/><Field label="Timezone" value={form.timezone} onChange={v=>change('timezone',v)}/><Field label="Source (e.g. current prescription)" value={form.source} onChange={v=>change('source',v)}/></div><label className="checkline"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/> I checked these details against the current prescription or medicine label.</label><button className="button button-deep" disabled={busy||!checked||!form.name.trim()||!form.instructions.trim()||!form.schedule||!form.source.trim()} onClick={savePlan}>{busy?'Saving…':editingId?'Save reviewed version':'Save checked plan'}</button></div>}
 {plans.length ? plans.flatMap((plan,i)=>{const medicines=Array.isArray(plan.medicines)?plan.medicines as Row[]:[plan];return medicines.map((medicine,j)=><div className="med-plan-row" key={`${String(plan.id||i)}-${j}`}><span className="med-plan-icon"><Pill size={18}/></span><div className="med-plan-main"><h3>{label(medicine,'name','medicine_name')||'Medication'}</h3><p>{label(medicine,'instructions','dose')||'Instructions not provided'}</p><div className="med-plan-meta"><span>{Array.isArray(plan.schedule)?(plan.schedule as Row[]).filter(item=>val(item,'medicine_id')===val(medicine,'id')).map(item=>label(item,'local_time')).join(', ')||'Schedule not provided':label(plan,'schedule','timing')||'Schedule not provided'}</span><span>·</span><span>{label(plan,'timezone')||data.patient?.timezone||'Timezone not provided'}</span></div><div className="source-note">Source: {label(plan,'source')||'Not provided'} · {val(plan,'checked_at')?`Checked ${niceDate(val(plan,'checked_at'))}`:'Check date unavailable'}</div></div><Status>{val(plan,'active')===false?'Inactive':'Checked'}</Status>{canWriteCare&&val(plan,'active')!==false&&<button className="button" onClick={()=>editMedicine(medicine,plan)}>Edit</button>}</div>);}) : <Empty title="No checked medication plan" text="Add the current label details and source after checking them with the person’s prescription."/>}</section>
 <section className="card"><SectionHead title="Dose reports"/><p className="section-intro">A scheduled reminder, delivered audio, or silence is not a dose report. Each status is recorded only after explicit confirmation.</p>{data.doses.length?<div className="table-wrap"><table><thead><tr><th>Medicine</th><th>Scheduled occurrence</th><th>Reported status</th><th>Report time</th></tr></thead><tbody>{data.doses.map((r,i)=><tr key={String(r.id||i)} data-action-source={`dose:${String(r.id||i)}`} tabIndex={-1}><td>{label(r,'medicine_name','medication_name','name')||'Medication'}</td><td>{niceDate(val(r,'scheduled_at','due_at'))}</td><td><Status warm={!stateText(r).includes('taken')}>{prettyState(stateText(r))}</Status></td><td>{niceDate(val(r,'reported_at','report_time'),'Not reported')}{r.report_time ? <><RecordSource row={r}/><RecordHistory row={r}/></> : null}</td></tr>)}</tbody></table></div>:<Empty title="No dose reports" text="Reported taken, skipped, not yet, uncertain and no-response states remain separate."/>}</section>
 {canWriteCare&&<section className="card"><SectionHead title="Report a dose"/><div className="compact-form"><p>Start a proposal for a specific scheduled medicine occurrence. Review the medicine, time and reported status before confirming.</p><button className="button" onClick={()=>onCompose('medication_report')}>Create a medication report</button></div></section>}</div>;
}
function Field({label:lab,value,onChange,type='text'}:{label:string;value:string;onChange:(v:string)=>void;type?:string}) {return <label>{lab}<input type={type} value={value} onChange={e=>onChange(e.target.value)}/></label>;}

function TaskTransition({row,onPropose}:{row:Row;onPropose:(payload:Record<string,unknown>)=>void}) {const transitions:Record<string,string[]>={planned:['due','arranged','declined','needs_discussion'],due:['arranged','declined','needs_discussion'],arranged:['completed','declined','needs_discussion'],completed:['needs_discussion'],declined:['needs_discussion','arranged'],needs_discussion:['planned','due','arranged','declined']};const current=label(row,'state').toLowerCase();const options=transitions[current]||[];const [open,setOpen]=useState(false);const [state,setState]=useState(options[0]||'needs_discussion');const [appointmentDate,setAppointmentDate]=useState('');const [completionDate,setCompletionDate]=useState('');return <div className="task-transition"><button className="text-link task-update" onClick={()=>{setState(options[0]||'needs_discussion');setOpen(!open);}}>{open?'Close update':'Propose an update →'}</button>{open&&<div className="transition-form"><label>New status<select aria-label="New status" value={state} onChange={e=>setState(e.target.value)}>{options.map(value=><option key={value} value={value}>{prettyState(value)}</option>)}</select></label>{['arranged','completed'].includes(state)&&<label>{state==='arranged'?'Appointment date':'Completion date'}<input type="date" value={state==='arranged'?appointmentDate:completionDate} onChange={e=>state==='arranged'?setAppointmentDate(e.target.value):setCompletionDate(e.target.value)}/></label>}<button className="button button-soft" disabled={!options.length} onClick={()=>onPropose({task_id:row.id,state,...(state==='arranged'&&appointmentDate?{appointment_date:appointmentDate}:{}),...(state==='completed'&&completionDate?{completion_date:completionDate}:{})})}>Review proposed change</button>{!options.length&&<p className="source-note">No further task update is available from this status.</p>}</div>}</div>;}

function CarePlan({data,onCompose,onCreate,canWriteCare}:{data:Dashboard;canWriteCare:boolean;onCompose:(kind:string)=>void;onCreate:(k:string,p:Record<string,unknown>)=>void}) { const tasks=data.preventive_tasks; return <div className="view-stack"><section className="card"><SectionHead eyebrow="From an existing care plan" title="Preventive care and follow-ups" action={canWriteCare&&<button className="button button-primary" onClick={()=>onCompose('preventive_task')}><Plus size={15}/> Add task</button>}/><p className="section-intro">Parse tracks tasks you enter. It does not calculate screening eligibility, book appointments, or infer that a task is complete.</p>{tasks.length?tasks.map((r,i)=><div className="care-task" key={String(r.id||i)} data-action-source={`preventive_task:${String(r.id||i)}`} tabIndex={-1}><div className="task-icon"><Stethoscope size={17}/></div><div className="care-task-copy"><div className="care-task-head"><h3>{label(r,'title','description','task_type')||'Care plan task'}</h3><Status warm={['due','needs_discussion'].includes(stateText(r).toLowerCase())}>{prettyState(stateText(r))}</Status></div><p>{label(r,'details','notes')||'No additional details provided.'}</p><div className="med-plan-meta"><span>{val(r,'due_date')?`Due ${niceDate(val(r,'due_date'))}`:'Due date not provided'}</span>{val(r,'appointment_date')!=null&&<><span>·</span><span>{`Arranged ${niceDate(val(r,'appointment_date'))}`}</span></>}{val(r,'completion_date','completed_at')!=null&&<><span>·</span><span>{`Completed ${niceDate(val(r,'completion_date','completed_at'))}`}</span></>}</div><div className="source-note">Source: {label(r,'source')||'Care plan source not provided'}</div><RecordSource row={r}/><RecordHistory row={r}/>{canWriteCare&&<TaskTransition row={r} onPropose={payload=>onCreate('preventive_task',payload)} />}</div></div>):<Empty title="No care-plan tasks" text="Add a screening, vaccination or follow-up that already appears in the care plan."/>}</section><section className="card info-card"><Shield size={17}/><p>Only dates and statuses explicitly reported by a person become arranged or completed. The timeline preserves the confirmed update.</p></section></div>; }

function FollowupOutcome({followup,onCreate}:{followup:Row;onCreate:(payload:Record<string,unknown>)=>void}) {const [open,setOpen]=useState(false);const [outcome,setOutcome]=useState('');return <div className="followup-outcome"><button className="text-link" onClick={()=>setOpen(!open)}>{open?'Close':'Record follow-up outcome →'}</button>{open&&<div className="resolve-row"><input aria-label="Reported follow-up outcome" value={outcome} onChange={e=>setOutcome(e.target.value)} placeholder="What was reported?"/><button className="button button-soft" disabled={!outcome.trim()} onClick={()=>onCreate({followup_id:String(followup.id),reported_outcome:outcome,resolution_state:'resolved'})}>Review outcome</button></div>}</div>;}

function FollowupProposal({row,onCreate}:{row:Row;onCreate:(payload:Record<string,unknown>)=>void}) {const [checkAt,setCheckAt]=useState('');const [permissionScope,setPermissionScope]=useState('private');return <div className="followup-form"><label>When to check in<input type="datetime-local" required value={checkAt} onChange={e=>setCheckAt(e.target.value)}/></label><label>Who may see this check-in<select aria-label="Who may see this check-in" value={permissionScope} onChange={e=>setPermissionScope(e.target.value)}><option value="private">Private</option><option value="related_recipients">People already shared on the related request</option></select></label><button className="button button-soft" disabled={!checkAt} onClick={()=>onCreate({related_type:'support_request',related_id:String(row.id),check_at:new Date(checkAt).toISOString(),permission_scope:permissionScope})}>Review follow-up</button></div>;}

function Support({data,currentUserId,onCompose,onCreate,onAcknowledge,onResolve,canWriteCare}:{data:Dashboard;currentUserId:string;onCompose:(kind:string)=>void;onCreate:(kind:string,payload:Record<string,unknown>)=>void;onAcknowledge:(id:string)=>void;onResolve:(id:string,outcome:string)=>void;canWriteCare:boolean}) { const [outcomes,setOutcomes]=useState<Record<string,string>>({}); const [followupOpen,setFollowupOpen]=useState(''); const canAcknowledge=hasPermission(data.permissions,'ack:support');const canResolve=hasPermission(data.permissions,'resolve:support')||hasPermission(data.permissions,'write:care'); return <div className="view-stack"><section className="card"><SectionHead eyebrow="Shared requests" title="Follow up together" action={canWriteCare&&<button className="button button-primary" onClick={()=>onCompose('support_request')}><Plus size={15}/> New request</button>}/><p className="section-intro">A request is visible here only under the person's sharing permissions. Acknowledging it means you have seen it; resolving it records a reported outcome.</p>{data.support_requests.length?data.support_requests.map((r,i)=>{const st=stateText(r).toLowerCase();const id=String(r.id||i);return <div className="support-item" key={id} data-action-source={`support_request:${id}`} tabIndex={-1}><div className="support-icon"><Heart size={17}/></div><div className="support-copy"><div className="care-task-head"><h3>{label(r,'title','request','request_text','text')||'Support request'}</h3><Status warm={!['resolved','closed'].includes(st)}>{prettyState(stateText(r))}</Status></div><p className="support-quote">“{label(r,'description','content','request_text','text')||'Request details unavailable'}”</p><div className="source-note">{label(r,'requester_name','created_by') ? `${label(r,'requester_name','created_by')} · `:''}{niceDate(val(r,'created_at','occurred_at'))}{label(r,'recipient_name','shared_with')?` · Shared with ${label(r,'recipient_name','shared_with')}`:''}</div><RecordSource row={r}/>{canAcknowledge&&currentUserId===String(r.recipient_user_id)&&(st==='sent'||st==='open'||st==='pending')?<button className="button button-soft" onClick={()=>onAcknowledge(id)}><Check size={15}/> Acknowledge</button>:null}{canWriteCare&&<button className="text-link" onClick={()=>setFollowupOpen(followupOpen===id?'':id)}>Schedule a follow-up →</button>}{canWriteCare&&followupOpen===id&&<FollowupProposal row={r} onCreate={payload=>onCreate('followup',payload)}/ >}{canResolve&&!['resolved','closed'].includes(st)&&<div className="resolve-row"><input placeholder="Outcome to record" value={outcomes[id]||''} onChange={e=>setOutcomes({...outcomes,[id]:e.target.value})}/><button className="button" disabled={!outcomes[id]} onClick={()=>onResolve(id,outcomes[id])}>Record resolution</button></div>}</div></div>}) : <Empty title="No shared requests" text="New support requests will appear here when the person chooses to share them."/>}</section>{data.followups.length>0&&<section className="card"><SectionHead eyebrow="Agreed check-ins" title="Follow-ups"/>{data.followups.map((f,i)=><div className="permission-row" key={String(f.id||i)} data-action-source={`followup:${String(f.id||i)}`} tabIndex={-1}><div><b>{label(f,'description','related_type')||'Follow-up'}</b><span>{niceDate(val(f,'check_at'))} · {label(f,'resolution_state','status')||'Open'}{label(f,'reported_outcome')?` · ${label(f,'reported_outcome')}`:''}</span><RecordSource row={f}/><RecordHistory row={f}/></div>{!['resolved'].includes(label(f,'resolution_state','status').toLowerCase())&&canWriteCare&&<FollowupOutcome followup={f} onCreate={payload=>onCreate('followup',payload)}/>}</div>)}</section>}<section className="card info-card"><CircleHelp size={17}/><p>{label(data.patient,'calling_route')?`Configured calling route: ${label(data.patient,'calling_route')}. Parse does not dispatch emergency services.`:'No calling route is configured. Parse does not dispatch emergency services.'}</p></section></div>; }

function PressureChart({rows,onCorrect}:{rows:Row[];onCorrect:(row:Row)=>void}) { const readings=rows.map(r=>({r,s:Number(val(r,'systolic')),d:Number(val(r,'diastolic'))})).filter(x=>Number.isFinite(x.s)&&Number.isFinite(x.d)).reverse(); if(!readings.length)return <Empty title="No confirmed readings" text="Values without confirmed numbers are not plotted."/>; const values=readings.flatMap(p=>[p.s,p.d]);const min=Math.floor((Math.min(...values)-10)/10)*10;const max=Math.ceil((Math.max(...values)+10)/10)*10; const y=(n:number)=>130-(n-min)/(max-min)*105;const x=(i:number)=>readings.length<2?160:i*(320/(readings.length-1));const systolic=readings.map((p,i)=>`${x(i)},${y(p.s)}`).join(' ');const diastolic=readings.map((p,i)=>`${x(i)},${y(p.d)}`).join(' ');return <><div className="chart-caption"><span>{readings.length} confirmed {readings.length===1?'reading':'readings'}</span><span>mmHg · both reported values · no interpretation</span></div><div className="chart-wrap"><svg viewBox="0 0 320 150" role="img" aria-label={`Blood pressure readings: ${readings.map(p=>`${p.s} systolic and ${p.d} diastolic`).join(', ')}`}><line x1="0" x2="320" y1={y(Math.round(((min+max)/2)/10)*10)} y2={y(Math.round(((min+max)/2)/10)*10)} className="chart-gridline"/><polyline points={systolic} className="chart-line"/><polyline points={diastolic} className="chart-line chart-diastolic"/>{readings.map((p,i)=><g key={String(p.r.id||i)}><circle cx={x(i)} cy={y(p.s)} r="4" className="chart-point"/><circle cx={x(i)} cy={y(p.d)} r="3" className="chart-point chart-diastolic-point"/><text x={x(i)} y={y(p.s)-8} textAnchor="middle" className="chart-label">{p.s}/{p.d}</text></g>)}</svg></div><div className="chart-legend"><span><i/> Systolic</span><span><i/> Diastolic</span></div><div className="reading-list">{readings.slice(-3).reverse().map((p,i)=><div key={String(p.r.id||i)}><b>{p.s}/{p.d} <small>mmHg</small></b><span>{label(p.r,'occurrence_text')?`About ${label(p.r,'occurrence_text')}`:niceDate(val(p.r,'occurred_at'))}</span><button className="text-link" onClick={()=>onCorrect(p.r)}>Correct</button></div>)}</div><p className="chart-disclaimer">Each point is a reported observation. Differences alone do not show a trend, diagnosis or cause.</p></>; }

type SummaryEdit = { sectionIndex: number; itemIndex: number; text: string };
const summaryPurposes: { value: SummaryPurpose; label: string }[] = [
  { value: 'doctor_visit', label: 'Doctor visit' },
  { value: 'family_handoff', label: 'Family handoff' },
  { value: 'weekly_review', label: 'Weekly care review' },
];
function summaryPurposeOf(row: Row | null): SummaryPurpose {
  const value = row ? label(row, 'purpose') : '';
  return summaryPurposes.some(option => option.value === value) ? value as SummaryPurpose : 'doctor_visit';
}
function parseSummaryQuestions(text: string): string[] { return text.split(/\r?\n/).map(value => value.trim()).filter(Boolean); }
function summaryQuestionsReadable(row: Row): string { return (Array.isArray(row.questions) ? row.questions as Row[] : []).map(question => label(question, 'text')).join('\n'); }
function summaryReadable(row: Row) {
  return JSON.stringify((Array.isArray(row.sections) ? row.sections as Row[] : []).flatMap((section, sectionIndex) =>
    section.kind === 'authored_questions' ? [] : (Array.isArray(section.items) ? section.items as Row[] : []).map((item, itemIndex) =>
      ({ sectionIndex, itemIndex, text: label(item, 'text') }))));
}
function parseSummaryDraft(text: string, sections?: Row[]): SummaryEdit[] {
  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed as SummaryEdit[]; }
  catch { /* Keep original source text when an older draft cannot be parsed. */ }
  return (sections || []).flatMap((section, sectionIndex) =>
    section.kind === 'authored_questions' ? [] : (Array.isArray(section.items) ? section.items as Row[] : []).map((item, itemIndex) =>
      ({ sectionIndex, itemIndex, text: label(item, 'text') })));
}
type SummaryProps = {
  timezone: string; patientId: string; patientName: string; identityKey: string;
  summary: Row | null; summaryText: string; setSummaryText: (text: string) => void;
  purpose: SummaryPurpose; setPurpose: (purpose: SummaryPurpose) => void;
  questionsText: string; setQuestionsText: (text: string) => void;
  omittedSourceIds: string[]; setOmittedSourceIds: (ids: string[]) => void;
  reviewed: boolean; busy: boolean;
  makeSummary: (start: string, end: string, purpose: SummaryPurpose, questions: string[]) => void;
  saveSummary: () => void; shareSummary: () => void; revokeShare: () => void;
};
function Summary({ timezone, patientId, patientName, identityKey, summary, summaryText, setSummaryText,
  purpose, setPurpose, questionsText, setQuestionsText, omittedSourceIds, setOmittedSourceIds,
  reviewed, makeSummary, saveSummary, shareSummary, revokeShare, busy }: SummaryProps) {
  const [start, setStart] = useState(localDay(new Date(Date.now() - 30 * 86400000), timezone));
  const [end, setEnd] = useState(localDay(new Date(), timezone));
  const isShared = Boolean(val(summary || {}, 'url', 'share_token', 'share_active'));
  const invalidated = Boolean(val(summary || {}, 'invalidated_at'));
  const purposeChanged = Boolean(summary && summaryPurposeOf(summary) !== purpose);
  const sources = Array.isArray(summary?.sources) ? summary.sources as Row[] : [];
  const sections = Array.isArray(summary?.sections) ? summary.sections as Row[] : [];
  const evidenceSections = sections.map((section, index) => ({ section, index })).filter(({ section }) => section.kind !== 'authored_questions');
  const edits = parseSummaryDraft(summaryText, sections);
  const questions = parseSummaryQuestions(questionsText);
  const questionError = questions.length > 10 ? 'Use at most 10 questions.' : questions.some(text => text.length > 500) ? 'Each question must be 500 characters or fewer.' : '';
  const changeItem = (sectionIndex: number, itemIndex: number, text: string) => {
    const next = sections.flatMap((section, si) => section.kind === 'authored_questions' ? [] :
      (Array.isArray(section.items) ? section.items as Row[] : []).map((item, ii) => ({
        sectionIndex: si, itemIndex: ii,
        text: edits.find(entry => entry.sectionIndex === si && entry.itemIndex === ii)?.text ?? label(item, 'text'),
      }))).map(entry => entry.sectionIndex === sectionIndex && entry.itemIndex === itemIndex ? { ...entry, text } : entry);
    setSummaryText(JSON.stringify(next));
  };
  return <div className="view-stack"><section className="card">
    <SectionHead eyebrow="Care handoff" title="A summary you can review" />
    <p className="section-intro">Choose a purpose and date range. Parse arranges confirmed, permitted records and keeps the source of every report visible. Review before sharing or printing.</p>
    <div className="summary-purpose-fields">
      <label>Summary purpose<select aria-label="Summary purpose" value={purpose} onChange={event => setPurpose(event.target.value as SummaryPurpose)}>
        {summaryPurposes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <label>Questions to discuss<textarea aria-label="Questions to discuss" value={questionsText} onChange={event => setQuestionsText(event.target.value)} placeholder="One question per line" rows={3} /></label>
      <p className="source-note">Questions are written by you and shown separately from confirmed reports. One per line, up to 10 questions of 500 characters each.</p>
      {questionError && <p className="inline-error" role="alert">{questionError}</p>}
    </div>
    <div className="date-range"><Field label="From" value={start} onChange={setStart} type="date"/><Field label="To" value={end} onChange={setEnd} type="date"/>
      <button className="button button-deep" disabled={busy || !start || !end || start > end || Boolean(questionError)} onClick={() => makeSummary(start, end, purpose, questions)}><Sparkles size={15}/>{summary ? 'Prepare a fresh draft' : 'Prepare draft'}</button></div>
    {summary ? <>
      {invalidated && <div className="inline-error" role="alert">The source records changed. This draft and its share link are no longer valid. Prepare a fresh draft to continue.</div>}
      {purposeChanged && <div className="inline-error" role="status">The purpose changed. Prepare a fresh draft for this purpose before reviewing, sharing or printing.</div>}
      <div className="summary-meta"><span><FileText size={14}/> {summaryPurposes.find(option => option.value === summaryPurposeOf(summary))?.label} · template {String(val(summary, 'template_version') ?? 1)}</span><span>{label(summary, 'start_date') || start} — {label(summary, 'end_date') || end}</span></div>
      <div className="summary-source-list"><h3>Review statements and sources</h3><p className="source-instructions">Edit each statement or uncheck a source to omit its linked statement from the saved review. Current context is labelled separately from reports in the selected period.</p>
        {evidenceSections.map(({ section, index: sectionIndex }) => <div className="summary-section-edit" key={`${label(section, 'title')}-${sectionIndex}`}><h4>{label(section, 'title') || 'Summary'}</h4>
          {(Array.isArray(section.items) ? section.items as Row[] : []).map((item, itemIndex) => {
            const sourceId = label(item, 'source_id'); const source = sources.find(entry => String(entry.id) === sourceId);
            const omitted = Boolean(sourceId && omittedSourceIds.includes(sourceId));
            const text = edits.find(entry => entry.sectionIndex === sectionIndex && entry.itemIndex === itemIndex)?.text ?? label(item, 'text');
            return <div className={`summary-source ${omitted ? 'source-omitted' : ''}`} key={`${sourceId || 'item'}-${itemIndex}`}>
              <label className="summary-source-check"><input type="checkbox" checked={!omitted} disabled={!sourceId || invalidated || purposeChanged} onChange={event => setOmittedSourceIds(event.target.checked ? omittedSourceIds.filter(id => id !== sourceId) : [...omittedSourceIds, sourceId])}/>
                <span>{source ? `${String(source.type || 'Source')} · ${sourceId} · version ${String(val(source, 'version') ?? 'unknown')}` : 'Unlinked note'}</span>{omitted && <em>Omitted</em>}</label>
              <textarea aria-label={`Edit ${label(section, 'title') || 'summary'} statement ${itemIndex + 1}`} disabled={omitted || invalidated || purposeChanged} value={text} onChange={event => changeItem(sectionIndex, itemIndex, event.target.value)}/>
            </div>;
          })}
        </div>)}
        {!evidenceSections.length && <span><CircleHelp size={14}/> The draft contains no included care statements.</span>}
      </div>
      <div className="summary-authored-questions"><h3>Authored questions · separate from reported care</h3>
        {questions.length ? questions.map((text, index) => <p key={`${index}-${text}`}>Question {index + 1}: {text}</p>) : <p>No questions entered.</p>}
      </div>
      <div className="summary-actions"><span>{invalidated ? 'Prepare a fresh draft before sharing.' : purposeChanged ? 'Prepare a fresh draft for this purpose.' : reviewed ? 'Reviewed and ready to share or print.' : 'Save your review before sharing or printing.'}</span>
        <div>{isShared && Boolean(val(summary, 'url')) && <a className="button" href={String(val(summary, 'url')).replace(/^\/v1/, '')} target="_blank" rel="noreferrer">Open read-only view</a>}
          <button className="button" disabled={busy || invalidated || purposeChanged || Boolean(questionError)} onClick={saveSummary}>Save review</button>
          <button className="button button-primary" disabled={busy || invalidated || purposeChanged || !reviewed} onClick={shareSummary}>Share read-only</button>
          {isShared && <button className="button button-danger" disabled={busy || invalidated} onClick={revokeShare}>Revoke link</button>}
        </div>
      </div>
      {reviewed && !busy && !invalidated && !purposeChanged && summary.status === 'reviewed' && <SummaryPrint summary={summary} patientId={patientId} patientName={patientName} identityKey={identityKey} loadCurrentSummary={api.printSummary} />}
    </> : <Empty title="No summary draft yet" text="Choose a purpose and dates above to draft a source-linked summary. It will not be shared until you choose to share it."/>}
  </section><div className="summary-guard"><Shield size={16}/><span>Unknown and unconfirmed information stays visible as such. Sharing is a separate, deliberate action.</span></div></div>;
}

function ProfileSettings({patient,onSave,canManage}:{patient:Patient;onSave:(payload:Record<string,unknown>)=>void;canManage:boolean}) { const [form,setForm]=useState({preferred_name:patient.preferred_name||patient.name,language:patient.language||'en',timezone:patient.timezone||'Asia/Singapore',daily_check_in_enabled:patient.daily_check_in_enabled===true,daily_check_in_local_time:patient.daily_check_in_local_time||'',calling_route:patient.calling_route||''});return <section className="card"><SectionHead eyebrow="Care preferences" title="How the companion addresses them"/><p className="section-intro">The chosen name and language are used for device context. An optional daily check-in is a preference, not a wellbeing signal.</p><div className="form-grid"><Field label="Preferred name" value={form.preferred_name} onChange={v=>setForm({...form,preferred_name:v})}/><Field label="Language" value={form.language} onChange={v=>setForm({...form,language:v})}/><Field label="Timezone" value={form.timezone} onChange={v=>setForm({...form,timezone:v})}/><Field label="Configured calling route (optional)" value={form.calling_route} onChange={v=>setForm({...form,calling_route:v})}/>{form.daily_check_in_enabled&&<Field label="Daily check-in time" value={form.daily_check_in_local_time} onChange={v=>setForm({...form,daily_check_in_local_time:v})} type="time"/>}</div><label className="checkline"><input type="checkbox" checked={form.daily_check_in_enabled} onChange={e=>setForm({...form,daily_check_in_enabled:e.target.checked})}/> Enable an optional daily check-in</label><button className="button button-deep" disabled={!canManage||!form.preferred_name.trim()||!form.language.trim()||!form.timezone.trim()||form.calling_route.length>200||(form.daily_check_in_enabled&&!form.daily_check_in_local_time)} onClick={()=>onSave({...form,daily_check_in_local_time:form.daily_check_in_enabled?form.daily_check_in_local_time:null})}>Save preferences</button>{!canManage&&<p className="source-note">Only an account with profile management permission can change these preferences.</p>}</section>; }

function SettingsView({data,patient,onSelect,onReleaseRemoved,onClaim,onRevoke,onGrant,onRevokeGrant,canManageSharing,canManageDevices,canManageProfile,onProfile}:{data:Dashboard;onSelect:(id:string|null,generation:number,poweredOff:boolean)=>Promise<void>;onReleaseRemoved:(id:string,generation:number)=>Promise<void>;patient?:Patient;canManageSharing:boolean;canManageDevices:boolean;canManageProfile:boolean;onProfile:(payload:Record<string,unknown>)=>void;onClaim:(s:string,kind?:'phone'|'pendant')=>Promise<void>;onRevoke:(id:string)=>void;onGrant:(userId:string,scopes:string[])=>void;onRevokeGrant:(id:string)=>void}) { const [userId,setUserId]=useState('');const [scopes,setScopes]=useState<string[]>(['read:notes','read:measurements']);const grants=(data.access_grants||[]).filter(g=>g.relationship!=='owner');return <div className="view-stack"><DeviceSetup data={data} canManage={canManageDevices} onClaim={onClaim} onRevoke={onRevoke}/><CompanionSelection data={data} canManage={canManageDevices} onSelect={onSelect} onReleaseRemoved={onReleaseRemoved}/>{patient&&<ProfileSettings patient={patient} onSave={onProfile} canManage={canManageProfile}/>}<section className="card"><SectionHead eyebrow="Privacy" title="Sharing permissions"/><p className="section-intro">Choose who may see care information. Each permission can be removed here.</p>{grants.length?grants.map((g,i)=>{const u=(val(g,'user')||{}) as Row;const grantScopes=Array.isArray(g.scopes)?(g.scopes as string[]).join(', '):'Scope unavailable';return <div className="permission-row" key={String(g.id||i)}><div><b>{label(u,'name','email')||'Authorised person'}</b><span>{grantScopes}{val(g,'expires_at')?` · Expires ${niceDate(val(g,'expires_at'))}`:''}</span></div>{canManageSharing&&<button className="button button-danger" onClick={()=>onRevokeGrant(String(g.id))}>Remove access</button>}</div>;}):<Empty title="No additional people have access" text="Add a person only when you have their account ID and the person has agreed to share."/>}{canManageSharing&&<div className="grant-form"><h3>Add a person</h3><label>Account ID<input value={userId} onChange={e=>setUserId(e.target.value)} placeholder="User ID"/></label><div className="scope-options">{['read:notes','read:measurements','read:medications','ack:support'].map(scope=><label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(s=>s!==scope))}/>{scope}</label>)}</div><button className="button button-deep" disabled={!userId.trim()||!scopes.length} onClick={()=>onGrant(userId,scopes)}>Add permission</button></div>}</section><section className="card privacy-card"><Shield size={18}/><div><h3>Audio belongs to the companion device</h3><p>The Parse browser companion, native phone companion, and cardholder have separate device identities. This dashboard view does not record audio. A companion records only after you deliberately start it.</p></div></section></div>; }

function SharedSummaryPublic({ data, loading, error }: { data: Row | null; loading: boolean; error: string }) {
  const summary = (data?.summary && typeof data.summary === 'object' ? data.summary : {}) as Row;
  const patient = (data?.patient && typeof data.patient === 'object' ? data.patient : {}) as Row;
  const sections = Array.isArray(summary.sections) ? summary.sections as Row[] : [];
  const sources = Array.isArray(summary.sources) ? summary.sources as Row[] : [];
  const purpose = summaryPurposes.find(option => option.value === summaryPurposeOf(summary))?.label || 'Doctor visit';
  return <main className="public-share-page"><div className="public-share-brand"><BrandLogo /><span className="readonly-badge"><Shield size={13}/> Read-only summary</span></div>
    {loading ? <div className="loading-card"><span className="spinner"/><p>Checking this shared summary…</p></div> :
      error ? <div className="empty-card"><CircleHelp size={25}/><h2>This summary is unavailable</h2><p>{error}</p><p>It may have expired, been revoked or changed after the source records were updated.</p></div> :
      data ? <article className="public-summary"><div className="eyebrow">{purpose} · reviewed care summary</div>
        <h1>{label(patient, 'name') || label(summary, 'patient_name', 'name') || 'Care summary'}</h1>
        <p className="public-summary-meta">{label(summary, 'start_date')} – {label(summary, 'end_date')} · Generated {label(summary, 'created_at') || 'time unknown'} · Reviewed and shared</p>
        <p className="source-note">Sections labelled current context describe a snapshot at generation time, outside the selected-period filter.</p>
        {sections.map((section, index) => {
          const authored = section.kind === 'authored_questions';
          return <section key={String(section.id || index)}><h2>{label(section, 'title') || (authored ? 'Authored questions' : 'Care reports')}</h2>
            {authored && <p>Written questions, separate from confirmed care reports.</p>}
            {(Array.isArray(section.items) ? section.items as Row[] : []).map((item, itemIndex) => {
              const sourceId = label(item, 'source_id');
              const source = sources.find(entry => String(entry.id) === sourceId);
              return <div className="public-summary-item" key={`${sourceId || 'question'}-${itemIndex}`}><p>{label(item, 'text')}</p>
                {authored ? <small>Authored question · {label(item, 'author_display_name') || 'Author unknown'} · {label(item, 'authored_at') || 'Time unknown'}</small> :
                  source && <small><Shield size={12}/>{String(source.type || 'Source')} · version {String(val(source, 'version') ?? 'unknown')}</small>}
              </div>;
            })}
          </section>;
        })}
        <div className="summary-guard"><Shield size={15}/> Read-only copy. It does not include live device data.</div>
      </article> : null}
  </main>;
}

function NoteSharingDialog({note,grants,busy,onClose,onSave}:{note:Row;grants:Row[];busy:boolean;onClose:()=>void;onSave:(ids:string[])=>void}) {const eligible=grants.filter(g=>g.relationship!=='owner'&&Array.isArray(g.scopes)&&((g.scopes as string[]).includes('*')||((g.scopes as string[]).includes('read:notes')||(g.scopes as string[]).includes('read:dashboard'))));const existing=Array.isArray(note.shared_with_user_ids)?note.shared_with_user_ids as string[]:[];const [selected,setSelected]=useState(existing);return <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="note-sharing-title"><div className="modal-head"><div><div className="eyebrow">Private by default</div><h2 id="note-sharing-title">Choose who can see this note</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button></div><p className="section-intro">Changing access may invalidate summaries that cite this note. Removing everyone makes it private again.</p>{eligible.length?eligible.map((grant,i)=>{const user=(val(grant,'user')||{}) as Row;const id=String(user.id||'');return <label className="share-recipient" key={String(grant.id||i)}><input type="checkbox" checked={selected.includes(id)} onChange={e=>setSelected(e.target.checked?[...selected,id]:selected.filter(x=>x!==id))}/><span><b>{label(user,'name')||'Caregiver'}</b><small>{label(user,'email')||'Authorised account'}</small></span></label>;}):<Empty title="No eligible caregiver accounts" text="Add a person with read:notes or read:dashboard access in sharing settings first."/>}<div className="modal-note"><Shield size={15}/> Only the people checked above will see this health note.</div><div className="modal-actions"><button className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy} onClick={()=>onSave(selected)}>{busy?'Saving…':'Save sharing'}</button></div></section></div>;}

function Composer({kind,doses,recipients,seed,timezone,setKind,onClose,onCreate,busy}:{kind:string;doses:Row[];recipients:Row[];seed:Record<string,unknown>;timezone:string;setKind:(s:string)=>void;onClose:()=>void;onCreate:(k:string,p:Record<string,unknown>)=>void;busy:boolean}) {
 const [fields,setFields]=useState<Record<string,string>>(()=>Object.fromEntries(Object.entries(seed).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>[k,String(v)])));
 const [validationMessage,setValidationMessage]=useState('');
 const definitions:Record<string,{title:string;fields:[string,string,string][]}>={
  health_note:{title:'Create a care note proposal',fields:[['wording','What would you like recorded?','textarea'],['occurred_at','When did this happen? (optional)','datetime-local']]},
  measurement:{title:'Report a blood pressure reading',fields:[['systolic','Systolic (mmHg)','number'],['diastolic','Diastolic (mmHg)','number'],['occurred_at','When was it taken? (optional)','datetime-local'],['occurrence_text','Or describe the approximate time','text'],['source_description','Source (e.g. home monitor)','text'],['reporting_actor','Who reported this?','actor_select']]},
  support_request:{title:'Create a support request proposal',fields:[['request_text','What help is needed?','textarea'],['recipient_user_id','Share with','recipient_select'],['urgency','Urgency','urgency_select'],['barrier_text','What is getting in the way? (optional)','text']]},
  preventive_task:{title:'Add a care-plan task proposal',fields:[['task_type','Task type','text'],['description','Description from the care plan','textarea'],['source','Care plan source','text'],['due_date','Due date','date'],['state','Task state','task_state']]},
  medication_report:{title:'Report a medication status',fields:[['dose_instance_id','Scheduled dose','dose_select'],['report_state','Reported status','report_state'],['taken_time_text','When it was taken (as described)','text']]},
  followup:{title:'Propose a follow-up',fields:[['related_type','Related care item type','text'],['related_id','Related care item ID','text'],['check_at','When to follow up?','datetime-local'],['permission_scope','What may be shared?','text']]}
 };
 const def=definitions[kind]||definitions.health_note;
 const supportRecipients=recipients.filter(user=>user.relationship!=='owner');
 function submit(e:React.FormEvent){
  e.preventDefault(); const payload:Record<string,unknown>={};
  for(const [key,value] of Object.entries(fields))if(value.trim()!=='')payload[key]=value.trim();
  const toIso=(key:string)=>{if(typeof payload[key]==='string'){const date=new Date(String(payload[key]));if(Number.isNaN(date.valueOf()))throw new Error(`Enter a valid ${key.replaceAll('_',' ')}.`);payload[key]=date.toISOString();}};
  try {
   if(kind==='health_note'){if(!String(payload.wording||'').trim()){setValidationMessage('Enter the note you want reviewed.');return;}toIso('occurred_at');payload.timezone=timezone;}
   if(kind==='measurement'){
    for(const key of ['systolic','diastolic']){const number=Number(payload[key]);if(payload[key]===undefined||!Number.isInteger(number)){setValidationMessage(`Enter a whole-number ${key} blood pressure value.`);return;}payload[key]=number;}
    if(!((payload.occurred_at&&!payload.occurrence_text)||(!payload.occurred_at&&payload.occurrence_text))){setValidationMessage('Enter a precise time or describe when the reading was taken.');return;}
    toIso('occurred_at'); payload.measurement_type='blood_pressure';payload.unit='mmHg';payload.timezone=timezone;
    if(!payload.source_description){setValidationMessage('Enter the source of this reported reading.');return;}if(!payload.reporting_actor){setValidationMessage('Choose who reported this reading.');return;}
   }
   if(kind==='support_request'){
    if(!String(payload.request_text||'').trim()){setValidationMessage('Describe the help being requested.');return;}
    if(!payload.recipient_user_id){setValidationMessage('Choose a permitted caregiver to receive this request.');return;}
    if(!payload.urgency)payload.urgency='routine';
   }
   if(kind==='preventive_task'){
    if(!payload.task_type||!payload.description||!payload.source||!payload.due_date){setValidationMessage('Enter the task, care-plan description, source, and due date.');return;}
    payload.state=payload.state||'planned';payload.timezone=timezone;
   }
   if(kind==='medication_report'){
    if(payload.report_state!=='reported_taken')delete payload.taken_time_text;
    if(!payload.dose_instance_id){setValidationMessage('Choose a scheduled dose.');return;}
    payload.report_state=payload.report_state||'reported_uncertain';
   }
   if(kind==='followup'){
    if(!payload.related_type||!payload.related_id||!payload.check_at||!payload.permission_scope){setValidationMessage('Complete the follow-up details before review.');return;}
    toIso('check_at');payload.resolution_state='open';
   }
  }catch(err){setValidationMessage(err instanceof Error?err.message:'Check the entered date.');return;}
  setValidationMessage('');onCreate(kind,payload);
 }
 return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><form className="modal-card" onSubmit={submit} aria-labelledby="composer-title"><div className="modal-head"><div><div className="eyebrow">Review before saving</div><h2 id="composer-title">{def.title}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18}/></button></div><label>Type<select aria-label="Type" value={kind} onChange={e=>{setKind(e.target.value);setFields({});setValidationMessage('');}}><option value="health_note">Care note</option><option value="measurement">Blood pressure reading</option><option value="medication_report">Medication report</option><option value="preventive_task">Care-plan task</option><option value="support_request">Support request</option><option value="followup">Follow-up</option></select></label>{def.fields.filter(([key])=>kind!=='medication_report'||key!=='taken_time_text'||(fields.report_state||'reported_uncertain')==='reported_taken').map(([key,title,type])=><label key={key}>{title}{type==='dose_select'?<select aria-label={title} required value={fields[key]||''} onChange={e=>setFields({...fields,[key]:e.target.value})}><option value="">Choose a scheduled dose</option>{doses.map(dose=><option key={String(dose.id)} value={String(dose.id)}>{label(dose,'medicine_name')||'Medication'} · {niceDate(val(dose,'scheduled_at'))} · {prettyState(label(dose,'report_state')||'unconfirmed')}</option>)}</select>:type==='recipient_select'?<select aria-label={title} required value={fields[key]||''} onChange={e=>setFields({...fields,[key]:e.target.value})}><option value="">Choose a caregiver</option>{supportRecipients.map((user,i)=><option key={String(user.id||i)} value={String(user.id||'')}>{label(user,'name')||'Caregiver'}</option>)}</select>:type==='actor_select'?<select aria-label={title} required value={fields[key]||''} onChange={e=>setFields({...fields,[key]:e.target.value})}><option value="">Choose a reporter</option><option value="patient">The patient</option><option value="caregiver">A caregiver</option></select>:type==='urgency_select'?<select aria-label={title} value={fields[key]||'routine'} onChange={e=>setFields({...fields,[key]:e.target.value})}><option value="routine">Routine</option><option value="urgent">Urgent</option></select>:type==='task_state'||type==='report_state'?<select aria-label={title} value={fields[key]||(type==='task_state'?'planned':'reported_uncertain')} onChange={e=>setFields({...fields,[key]:e.target.value})}>{(type==='task_state'?['planned','due','arranged','completed','declined','needs_discussion']:['reported_taken','reported_skipped','reported_not_yet','reported_uncertain']).map(v=><option key={v} value={v}>{prettyState(v)}</option>)}</select>:type==='textarea'?<textarea required={['wording','request_text','description'].includes(key)} value={fields[key]||''} onChange={e=>setFields({...fields,[key]:e.target.value})}/>:<input required={['systolic','diastolic','source_description','task_type','source','due_date','reporting_actor','related_type','related_id','check_at','permission_scope'].includes(key)} type={type} value={fields[key]||''} onChange={e=>setFields({...fields,[key]:e.target.value})}/>}</label>)}{kind==='support_request'&&supportRecipients.length===0&&<div className="inline-error" role="status">No permitted caregiver account is available to receive this request.</div>}{validationMessage&&<div className="inline-error" role="alert">{validationMessage}</div>}<div className="modal-note"><Shield size={15}/> This creates a proposal. The record is saved only after a separate review and confirmation.</div><div className="modal-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy||(kind==='support_request'&&!supportRecipients.length)}>{busy?'Preparing…':'Review proposal'} <span>→</span></button></div></form></div>;
}

function ReviewDialog({kind,payload,setPayload,readback,revise,confirm,busy,error,onClose,expiresAt}:{kind:string;payload:Record<string,unknown>;setPayload:(p:Record<string,unknown>)=>void;readback:string;revise:()=>void;confirm:()=>void;busy:boolean;error:string;onClose:()=>void;expiresAt?:string}) {
 const dialogRef=useRef<HTMLElement>(null);useEffect(()=>{dialogRef.current?.focus();},[]);
 const [serverPayloadFingerprint]=useState(()=>stablePayload(payload));const dirty=stablePayload(payload)!==serverPayloadFingerprint;const expired=Boolean(expiresAt&&Date.now()>=new Date(expiresAt).getTime());
 const editableKeys=new Set(['wording','symptom','occurrence_text','occurred_at','systolic','diastolic','source_description','reporting_actor','dose_instance_id','report_state','taken_time_text','task_type','description','source','due_date','state','appointment_date','completion_date','request_text','urgency','barrier_text','related_type','related_id','check_at','permission_scope','reported_outcome']);
 const editable=Object.entries(payload).filter(([key,value])=>editableKeys.has(key)&&['string','number','boolean'].includes(typeof value));
 const displayOnly=Object.entries(payload).filter(([key,value])=>!editableKeys.has(key)&&value!==null&&value!==undefined&&!['share_with_user_ids','permitted_user_ids','recipient_user_id'].includes(key)&&(!Array.isArray(value)||key==='share_with_names')&&(typeof value!=='object'||key==='share_with_names'));
 const reviseLabel=dirty?'Review revised details':'Create a new reviewed version';
 return <div className="modal-backdrop"><section ref={dialogRef} tabIndex={-1} className="modal-card review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="modal-head"><div><div className="eyebrow">Not saved yet · {prettyState(kind)}</div><h2 id="review-title">Review before confirming</h2></div><button className="icon-button" aria-label="Close review" onClick={onClose}><X size={18}/></button></div><div className="readback-box"><div className="readback-icon"><CheckCircle2 size={16}/></div><div><b>Server read-back</b><p>{readback}</p></div></div>{editable.length>0&&<div className="review-fields">{editable.map(([key,value])=><label key={key}>{prettyState(key)}<input aria-label={prettyState(key)} value={String(value)} onChange={e=>setPayload({...payload,[key]:e.target.value})}/></label>)}</div>}{displayOnly.length>0&&<div className="review-fields review-fields-readonly">{displayOnly.map(([key,value])=><div key={key}><span>{prettyState(key)}</span><b>{key==='share_with_names'&&Array.isArray(value)?value.join(', '):String(value)}</b></div>)}</div>}{error&&<div className="inline-error" role="alert">{error}</div>}{expired&&<div className="inline-error" role="alert">This proposal expired. Create a new proposal before confirming.</div>}{dirty&&<div className="inline-error" role="status">These edits are not the server-reviewed proposal yet. Create a revised version and review its new read-back before confirming.</div>}<div className="modal-note"><Shield size={15}/> Confirming commits only the exact proposal returned by the server.</div><div className="modal-actions"><button className="button" disabled={busy||expired||!dirty} onClick={revise}>{reviseLabel}</button><button className="button button-primary" disabled={busy||expired||dirty} onClick={confirm}>{busy?'Saving…':'Confirm and save'}</button></div></section></div>;
}
