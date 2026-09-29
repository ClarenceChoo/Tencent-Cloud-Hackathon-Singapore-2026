import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, Check, Heart, Mic, Play, RefreshCw, Send, ShieldCheck, Square, X } from 'lucide-react';
import { CompanionApiError, companionApi, fetchWebAudio, setCompanionCsrf, webAudioPath } from './companionApi';
import type { Enrollment, Home, Reminder, TurnEvent } from './companionApi';
import './companion.css';

type Pending = { key: string; context: string | null; turnId?: string; createdAt: number };
type Phase = 'ready' | 'permission' | 'recording' | 'sending' | 'waiting' | 'reply';
const pendingKey = 'parse.web.pending.v1';
const ledgerKey = 'parse.web.playback.v1';
const maxBytes = 2 * 1024 * 1024;
const validId = /^[a-z0-9_-]{8,100}$/i;
const safePending = (): Pending | null => {
  try { const v = JSON.parse(sessionStorage.getItem(pendingKey) || 'null') as Pending | null;
    return v && /^[0-9a-f-]{36}$/i.test(v.key) && (!v.turnId || validId.test(v.turnId)) && (!v.context || validId.test(v.context)) && Number.isFinite(v.createdAt) ? v : null;
  } catch { return null; }
};
function savePending(v: Pending | null) { if (v) sessionStorage.setItem(pendingKey, JSON.stringify(v)); else sessionStorage.removeItem(pendingKey); }
type PlaybackLedger = Record<string, { stage: string; acks: Record<string,string> }>;
function readLedger(): PlaybackLedger { const value = JSON.parse(localStorage.getItem(ledgerKey) || '{}') as PlaybackLedger; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reminder history is unavailable.'); return value; }
function reserveReminder(id: string): boolean {
  try { const value = readLedger(); if (value[id]) return false; value[id] = { stage: 'reserved', acks: {} }; localStorage.setItem(ledgerKey, JSON.stringify(value)); return true; }
  catch { return false; }
}
const field = (item: Record<string, unknown>, key: string) => typeof item[key] === 'string' ? item[key] as string : '';
const stamp = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time unavailable';
const name = (v: Record<string, unknown>) => field(v, 'name') || field(v, 'title') || field(v, 'medicine_name') || field(v, 'wording') || field(v, 'description') || field(v, 'request_text') || (v.systolic && v.diastolic ? 'Blood pressure reading' : '') || (v.related_type ? `${String(v.related_type).replaceAll('_',' ')} follow-up` : '') || 'Care item';
const sourceName = (item: Record<string, unknown>) => {
  const value = item.source && typeof item.source === 'object' ? item.source as Record<string, unknown> : null;
  return value?.type === 'dashboard' ? 'Owner dashboard' : value?.type === 'phone' ? 'Companion' : value?.type === 'pendant' ? 'Cardholder' : 'Source unavailable';
};
const kindName = (kind: string) => ({ health_note: 'Health note', medication_report: 'Medicine update', measurement: 'Reading', preventive_task: 'Care task', support_request: 'Support request', followup: 'Follow-up' } as Record<string,string>)[kind] || 'Care update';

function CareList({ title, items, describe }: { title: string; items: Record<string, unknown>[]; describe: (item: Record<string,unknown>) => string }) {
  return <section className="companion-list"><h3>{title}</h3>{items.length ? <ul>{items.map((item, i) => <li key={String(item.id || i)}><strong>{name(item)}</strong><span>{describe(item)}</span></li>)}</ul> : <p>Nothing current to show.</p>}</section>;
}

export default function Companion() {
  const [booting, setBooting] = useState(true);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [home, setHome] = useState<Home | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [message, setMessage] = useState('Tap to record when you are ready.');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [reply, setReply] = useState<TurnEvent | null>(null);
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [wording, setWording] = useState('');
  const [changing, setChanging] = useState(false);
  const [recovery, setRecovery] = useState<Pending | null>(safePending);
  const [playing, setPlaying] = useState(false);
  const [connected, setConnected] = useState(false);
  const mounted = useRef(true);
  const loadRun = useRef(0);
  const denied = useRef(false);
  const epoch = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recordingAt = useRef(0);
  const discard = useRef(false);
  const timer = useRef<number | null>(null);
  const turnAbort = useRef<AbortController | null>(null);
  const playAbort = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const activeUrl = useRef<string | null>(null);
  const playRun = useRef(0);
  const reminderRef = useRef<Reminder | null>(null);
  reminderRef.current = reminder;

  const stopAudio = useCallback(() => {
    playRun.current++;
    playAbort.current?.abort(); playAbort.current = null;
    if (audio.current) { audio.current.pause(); audio.current.removeAttribute('src'); audio.current.load(); audio.current = null; }
    if (activeUrl.current) { URL.revokeObjectURL(activeUrl.current); activeUrl.current = null; }
    if (mounted.current) setPlaying(false);
  }, []);
  const releaseMic = useCallback(() => {
    if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach(track => { track.onended = null; track.stop(); }); stream.current = null;
  }, []);
  const stopRecording = useCallback((send = false) => {
    discard.current = !send;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    releaseMic();
  }, [releaseMic]);
  const interrupt = useCallback(() => {
    epoch.current++;
    stopRecording(false); releaseMic(); stopAudio(); turnAbort.current?.abort();
    if (mounted.current) { setPhase('ready'); setMessage('Interrupted. Tap to record when you are ready.'); }
  }, [stopRecording, releaseMic, stopAudio]);
  const deny = useCallback((err: unknown) => {
    if (!(err instanceof CompanionApiError) || ![401, 403].includes(err.status)) return false;
    denied.current = true; loadRun.current++; interrupt();
    setBooting(false); savePending(null); setRecovery(null);
    setConnected(false); setEnrollment(null); setHome(null); setReply(null); setReminder(null);
    setError('This browser no longer has access. Ask the care-space owner to check pairing, then connect again.');
    return true;
  }, [interrupt]);

  useEffect(() => {
    mounted.current = true;
    const leave = () => interrupt();
    const hide = () => { if (document.visibilityState !== 'visible') interrupt(); };
    document.addEventListener('visibilitychange', hide); window.addEventListener('blur', leave);
    return () => { mounted.current = false; interrupt(); document.removeEventListener('visibilitychange', hide); window.removeEventListener('blur', leave); };
  }, [interrupt]);

  const load = useCallback(async () => {
    const run = ++loadRun.current;
    try {
      const session = await companionApi.session();
      if (!mounted.current || run !== loadRun.current) return;
      setCompanionCsrf(session.csrf_token || '');
      if (!session.has_installation) { denied.current = false; setEnrollment(null); setHome(null); setConnected(false); setBooting(false); return; }
      const next = await companionApi.enrollment();
      if (!mounted.current || run !== loadRun.current) return;
      const fresh = next.status === 'paired' ? await companionApi.home() : null;
      if (!mounted.current || run !== loadRun.current) return;
      denied.current = false; setEnrollment(next); setHome(fresh); setConnected(true);
      setError('');
    } catch (err) {
      if (mounted.current && run === loadRun.current && !deny(err)) { setConnected(false); setError('Connection interrupted. Showing the last checked details. Tap Refresh to check current access.'); }
    } finally { if (mounted.current && run === loadRun.current) setBooting(false); }
  }, [deny]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!enrollment || document.visibilityState !== 'visible') return;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, enrollment.status === 'paired' ? 10000 : 5000);
    return () => window.clearInterval(id);
  }, [enrollment, load]);

  async function enroll() {
    setBusy(true); setError('');
    try {
      const next = await companionApi.enroll();
      if (!mounted.current) return;
      denied.current = false;
      setEnrollment(next); setCompanionCsrf(next.csrf_token || '');
      await load();
    } catch (err) { if (!deny(err)) setError(err instanceof Error ? err.message : 'Could not start pairing.'); }
    finally { setBusy(false); }
  }

  async function resolve(pending: Pending) {
    const controller = new AbortController(); turnAbort.current = controller;
    const current = () => mounted.current && !denied.current && !controller.signal.aborted && document.visibilityState === 'visible';
    setPhase('waiting'); setMessage('Checking your recording. No second upload will be sent.');
    try {
      let id = pending.turnId;
      if (!id) {
        const receipt = await companionApi.receipt(pending.key, controller.signal);
        if (!current()) return;
        id = receipt.turn_id;
        pending = { ...pending, turnId: id }; savePending(pending); setRecovery(pending);
      }
      for (let i = 0; i < 90 && current(); i++) {
        const result = await companionApi.turn(id!, controller.signal);
        if (!current()) return;
        if (result.status === 'failed') { savePending(null); setRecovery(null); throw new Error(result.error || 'Speech could not be processed. No record was saved.'); }
        if (result.event) {
          const fresh = await companionApi.home();
          if (!current()) return;
          setHome(fresh); savePending(null); setRecovery(null);
          const event = result.event;
          if (event.payload.status === 'awaiting_confirmation' && fresh.current_proposal?.context_id !== event.payload.context_id) {
            setReply(null); setMessage('The read-back changed. Review the current proposal below.');
          } else { setReply(event); setMessage(event.payload.spoken_text || 'Response ready. Review the details below.'); }
          setPhase('reply'); return;
        }
        await new Promise<void>(done => window.setTimeout(done, 700));
      }
      if (current()) { setPhase('ready'); setMessage('Processing is taking longer. Use Check recording to continue.'); }
    } catch (err) {
      if (!current()) return;
      setPhase('ready');
      if (!deny(err)) setError(err instanceof CompanionApiError && err.status === 404 ? 'Parse has no receipt yet. Check again before starting another recording.' : err instanceof Error ? err.message : 'Could not check this recording.');
    } finally { if (turnAbort.current === controller) turnAbort.current = null; }
  }

  async function sendRecording(blob: Blob, context: string | null) {
    if (blob.size < 12 || blob.size > maxBytes) { setPhase('ready'); setError('Recording is empty or over 2 MB. Please try again.'); return; }
    const pending: Pending = { key: crypto.randomUUID(), context, createdAt: Date.now() };
    try { savePending(pending); } catch { setPhase('ready'); setError('This browser cannot retain a recording receipt. Allow session storage before sending.'); return; }
    setRecovery(pending); setPhase('sending'); setMessage('Sending your recording…');
    const controller = new AbortController(); turnAbort.current = controller;
    try {
      const receipt = await companionApi.upload(blob, pending.key, context, controller.signal);
      if (controller.signal.aborted || !mounted.current || denied.current) return;
      const accepted = { ...pending, turnId: receipt.turn_id }; savePending(accepted); setRecovery(accepted);
      await resolve(accepted);
    } catch (err) {
      if (controller.signal.aborted || !mounted.current || denied.current) return;
      setPhase('ready'); if (!deny(err)) setError(err instanceof Error ? err.message : 'Could not send recording. Check its status before recording again.');
    } finally { if (turnAbort.current === controller) turnAbort.current = null; }
  }

  async function beginRecording() {
    if (!['ready', 'reply'].includes(phase) || recovery || !home || !connected || busy) return;
    stopAudio(); setError(''); setNotice(''); setReply(null);
    const generation = ++epoch.current;
    setPhase('permission'); setMessage('Allow microphone access to record.');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio. Try a current browser over HTTPS.');
      const type = ['audio/webm;codecs=opus', 'audio/mp4'].find(candidate => MediaRecorder.isTypeSupported(candidate));
      if (!type) throw new Error('This browser has no supported recording format.');
      const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!mounted.current || epoch.current !== generation || document.visibilityState !== 'visible') { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media; chunks.current = []; discard.current = false;
      const recording = new MediaRecorder(media, { mimeType: type }); recorder.current = recording;
      recording.ondataavailable = event => { if (event.data.size) chunks.current.push(event.data); };
      recording.onerror = () => { stopRecording(false); setError('Recording was interrupted. Please try again.'); };
      recording.onstop = () => {
        const length = performance.now() - recordingAt.current;
        const shouldSend = !discard.current && epoch.current === generation && length >= 300 && length <= 20_000 && document.visibilityState === 'visible';
        const blob = shouldSend ? new Blob(chunks.current, { type }) : null;
        chunks.current = []; recorder.current = null; releaseMic(); setElapsed(0);
        if (shouldSend && blob) void sendRecording(blob, home.current_proposal?.context_id || null);
        else if (mounted.current) { setPhase('ready'); setMessage(length < 300 && !discard.current ? 'That was too short. Speak for at least a moment.' : 'Recording discarded.'); }
      };
      media.getTracks().forEach(track => { track.onended = () => { if (recorder.current === recording) stopRecording(false); }; });
      recording.start(250); recordingAt.current = performance.now(); setElapsed(0); setPhase('recording'); setMessage('Recording. Tap Send when you finish.');
      timer.current = window.setInterval(() => { const seconds = (performance.now() - recordingAt.current) / 1000; setElapsed(Math.floor(seconds)); if (seconds >= 19) stopRecording(true); }, 200);
    } catch (err) {
      if (epoch.current === generation && mounted.current) { releaseMic(); setPhase('ready'); setError(err instanceof Error ? err.message : 'Microphone access failed.'); }
    }
  }

  const proposal = home?.current_proposal || null;
  async function proposalAction(action: 'confirm' | 'cancel' | 'revise' | 'speech') {
    if (!proposal || busy || !connected) return;
    setBusy(true); setError(''); stopAudio();
    try {
      if (action === 'confirm') {
        const result = await companionApi.confirm(proposal);
        if (result.status !== 'committed') throw new Error('Parse has not confirmed this record as saved.');
        if (denied.current) return; setNotice('Confirmed and saved.'); setChanging(false);
      } else if (action === 'cancel') { await companionApi.cancel(proposal); if (denied.current) return; setNotice('Proposal cancelled. No record was saved.'); setChanging(false); }
      else if (action === 'revise') { const updated = await companionApi.revise(proposal, { ...proposal.payload, wording: wording.trim() }); if (denied.current) return; setHome(current => current ? { ...current, current_proposal: updated } : current); setNotice('Wording changed. Review the new read-back before confirming.'); setChanging(false); }
      else { const event = await companionApi.speech(proposal); if (denied.current) return; setReply(event); setNotice('Tap Play reply to hear the current read-back.'); }
      if (action !== 'speech') { const current = await companionApi.home(); if (!denied.current) setHome(current); }
    } catch (err) { if (!deny(err)) setError(err instanceof Error ? err.message : 'The proposal could not be updated. It is not saved.'); }
    finally { setBusy(false); }
  }

  async function play(event: TurnEvent, onStart?: () => Promise<void>, onEnd?: (ok: boolean) => Promise<void>) {
    if (!connected || denied.current) { setError('Check the current connection before playing speech.'); return; }
    stopAudio(); const run = ++playRun.current; const controller = new AbortController(); playAbort.current = controller;
    const valid = () => {
      if (controller.signal.aborted || run !== playRun.current || denied.current || document.visibilityState !== 'visible') throw new Error('Playback stopped.');
      const expires = Date.parse(event.expires_at);
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('This spoken reply has expired. Check current care details.');
    };
    let started = false;
    try {
      const paths = event.payload.audio_paths;
      if (!paths?.length || paths.length > 20) throw new Error('The spoken reply must contain 1–20 parts.');
      valid(); setPlaying(true);
      let total = 0;
      for (const path of paths) {
        valid(); webAudioPath(path);
        const clip = await fetchWebAudio(path, controller.signal);
        if (!clip) throw new Error('Spoken reply is missing.');
        total += clip.duration; if (total > 120) throw new Error('Spoken reply exceeds two minutes.');
        valid(); await fetchWebAudio(path, controller.signal, 'HEAD'); valid();
        if (!started && onStart) { await onStart(); started = true; }
        const url = URL.createObjectURL(clip.blob); activeUrl.current = url;
        const player = new Audio(url); audio.current = player;
        await new Promise<void>((resolve, reject) => {
          const end = () => { cleanup(); resolve(); };
          const fail = () => { cleanup(); reject(new Error('Playback was interrupted. Tap Repeat to try again.')); };
          const cleanup = () => { player.removeEventListener('ended', end); player.removeEventListener('error', fail); controller.signal.removeEventListener('abort', fail); window.clearTimeout(limit); window.clearInterval(check); };
          const limit = window.setTimeout(fail, (clip.duration + 8) * 1000);
          const check = window.setInterval(() => { try { valid(); } catch { fail(); } }, 500);
          player.addEventListener('ended', end); player.addEventListener('error', fail); controller.signal.addEventListener('abort', fail, { once: true });
          void player.play().catch(fail);
        });
        player.pause(); player.removeAttribute('src'); player.load(); audio.current = null;
        URL.revokeObjectURL(url); activeUrl.current = null;
      }
      if (onEnd) await onEnd(true);
    } catch (err) {
      if (onEnd && started) void onEnd(false);
      if (!controller.signal.aborted && mounted.current && !deny(err)) setError(err instanceof Error ? err.message : 'Could not play speech. Tap Repeat.');
    } finally { if (playAbort.current === controller) { stopAudio(); } }
  }

  // Only opaque command and ack IDs are retained. Browser storage never holds speech or care text.
  const ack = async (command: string, stage: string) => {
    const value = readLedger(), entry = value[command];
    if (!entry) throw new Error('Reminder history is unavailable. Playback was stopped.');
    const id = entry.acks[stage] || crypto.randomUUID();
    entry.acks[stage] = id; entry.stage = stage;
    localStorage.setItem(ledgerKey, JSON.stringify(value));
    await companionApi.ack(command, id, stage);
  };
  useEffect(() => {
    if (!home || document.visibilityState !== 'visible') return;
    let alive = true;
    const poll = async () => {
      if (!alive || document.visibilityState !== 'visible') return;
      try {
        const result = await companionApi.pending();
        if (!alive) return;
        const next = [...result.commands, ...result.checkins].find(item => Date.parse(item.expires_at) > Date.now() && validId.test(item.payload.command_id));
        if (next && !reminderRef.current && reserveReminder(next.payload.command_id)) { setReminder(next); void ack(next.payload.command_id, 'received').catch(() => {}); }
      } catch (err) { deny(err); }
    };
    void poll(); const id = window.setInterval(poll, 5000);
    return () => { alive = false; window.clearInterval(id); };
  }, [home?.device_id]);
  async function playReminder() {
    if (!reminder || playing || !connected) return;
    const id = reminder.payload.command_id;
    try {
      const fresh = await companionApi.reminder(id);
      if (fresh.payload.command_id !== id || fresh.payload.route_generation !== reminder.payload.route_generation || Date.parse(fresh.expires_at) <= Date.now()) throw new Error('This reminder is no longer current. Check your care details.');
      await play(fresh, () => ack(id, 'playback_started'), async ok => { try { await ack(id, ok ? 'playback_completed' : 'interrupted'); } finally { setReminder(null); } });
    } catch (err) { setReminder(null); if (!deny(err)) setError(err instanceof Error ? err.message : 'Reminder is unavailable.'); }
  }
  async function dismissReminder() { if (!reminder) return; stopAudio(); try { await ack(reminder.payload.command_id, 'interrupted'); } catch { /* will retry on next poll */ } setReminder(null); }
  async function disconnect() {
    setBusy(true); setError(''); interrupt();
    try { loadRun.current++; if (enrollment?.status === 'paired' || denied.current) await companionApi.quiesce(); await companionApi.revoke(); savePending(null); setRecovery(null); setEnrollment(null); setHome(null); setReply(null); setReminder(null); setConnected(false); denied.current = false; setCompanionCsrf(''); setNotice('This browser has been disconnected.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not disconnect this browser.'); }
    finally { setBusy(false); }
  }
  async function pauseReminders() {
    if (!connected || busy) return;
    setBusy(true); stopAudio(); setReminder(null);
    try { await companionApi.quiesce(); setNotice('Reminders paused on this browser. The owner can choose another companion in Settings.'); await load(); }
    catch (err) { if (!deny(err)) setError(err instanceof Error ? err.message : 'Could not pause reminders.'); }
    finally { setBusy(false); }
  }

  return <div className="companion-app"><div className="companion-frame">
    <header className="companion-header"><span className="companion-wordmark">Parse<span className="companion-mark">✳</span></span><a href="/" className="companion-dashboard"><ArrowLeft size={19}/> Owner dashboard</a></header>
    {booting ? <main className="companion-card"><h1>Opening Parse…</h1></main> : !enrollment ? <main className="companion-landing"><div className="companion-orbit"><Heart size={42}/></div><p className="companion-eyebrow">A calmer way to stay close</p><h1>Your care companion, right here.</h1><p>Speak naturally, hear a read-back, and choose what to save. Your care-space owner connects this browser with a private code.</p><button className="companion-button companion-primary" disabled={busy} onClick={() => void enroll()}>{busy ? 'Starting…' : 'Connect this browser'}</button>{denied.current && <button className="companion-plain" disabled={busy} onClick={() => void disconnect()}>Clear old browser pairing</button>}<p className="companion-small">The owner dashboard uses a separate sign-in.</p></main> : enrollment.status === 'awaiting_approval' ? <main className="companion-pair"><p className="companion-eyebrow">One last step</p><h1>Connect this browser</h1><p>Ask the care-space owner to open Settings in the Parse dashboard, choose <b>Parse browser</b>, and enter this code for the right person.</p><div className="companion-code" aria-label={'Pairing code ' + enrollment.code}>{enrollment.code}</div><p>Code expires {stamp(enrollment.expires_at)}. Waiting for approval…</p><button className="companion-button companion-secondary" onClick={() => void load()}><RefreshCw size={20}/> Check connection</button><button className="companion-plain" disabled={busy} onClick={() => void disconnect()}>Start over</button></main> : <main>
      <section className="companion-welcome"><div><p className="companion-eyebrow">Your care space</p><h1>Hello, {home?.patient.preferred_name || home?.patient.name || enrollment.patient?.name || 'there'}.</h1><p>{home ? 'Here is what matters today.' : 'Connecting to your care space…'}</p></div><div className="companion-status"><span className="companion-live"/> {connected ? 'Connected' : 'Connection needs checking'} · {enrollment.patient?.name || home?.patient.name || 'companion'}</div></section>
      {home?.voice.voice_service === 'simulated' && <div className="companion-simulation" role="status">Demo speech is simulated. Responses are for testing, not live care guidance.</div>}
      {home && !home.voice.scheduler_enabled && <div className="companion-simulation">Scheduled reminders are disabled on this server.</div>}
      {error && <div className="companion-alert" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}><X size={18}/></button>{!connected && <button onClick={() => void load()}>Retry</button>}</div>}
      {notice && <div className="companion-notice" role="status">{notice}</div>}
      <section className="companion-talk" aria-label="Talk to Parse"><div className="companion-talk-heading"><div className="companion-talk-icon"><AudioLines size={25}/></div><div><p className="companion-eyebrow">A moment to speak</p><h2>Talk to Parse</h2></div></div><p aria-live="polite">{message}</p>
        {recovery && <div className="companion-recovery"><p>An earlier recording may have reached Parse. Check its status before speaking again.</p><button className="companion-button companion-secondary" disabled={phase === 'waiting'} onClick={() => void resolve(recovery)}>Check recording</button><button className="companion-plain" onClick={() => { savePending(null); setRecovery(null); setMessage('Recording lookup dismissed. Its outcome may still appear in current care details.'); }}>Dismiss lookup</button></div>}
        <div className="companion-record-actions">{(phase === 'ready' || phase === 'reply') && <button className="companion-record" disabled={!home || !connected || !!recovery || busy} onClick={() => void beginRecording()}><Mic size={34}/> Tap to record</button>}{phase === 'permission' && <button className="companion-record companion-muted" onClick={() => interrupt()}><X size={30}/> Cancel</button>}{phase === 'recording' && <><div className="companion-record-time" aria-live="off"><span className="companion-record-dot"/> {elapsed}s / 19s</div><button className="companion-record" onClick={() => stopRecording(true)}><Send size={31}/> Tap to send</button><button className="companion-button companion-secondary" onClick={() => stopRecording(false)}>Cancel recording</button></>}{(phase === 'sending' || phase === 'waiting') && <button className="companion-button companion-secondary" onClick={() => { turnAbort.current?.abort(); setPhase('ready'); setMessage('Check recording later to see whether Parse received it.'); }}>Stop waiting</button>}</div>
        <p className="companion-small">Microphone access starts only when you tap. Recordings stop if you leave this page. Keep this page open for in-page reminders.</p>
      </section>
      {reminder && <section className="companion-reminder" aria-label="Current reminder"><p className="companion-eyebrow">For this moment</p><h2>{reminder.type === 'checkin.play' ? 'A check-in from Parse' : 'A care reminder'}</h2><p>{reminder.payload.greeting_text || 'A reminder is ready to hear.'}</p><p className="companion-small">Available until {stamp(reminder.expires_at)}. Tap to play; browsers may block automatic sound.</p><div className="companion-actions"><button className="companion-button companion-primary" onClick={() => void playReminder()}><Play size={19}/> Play reminder</button><button className="companion-button companion-secondary" onClick={() => void dismissReminder()}>Dismiss</button></div></section>}
      {proposal && <section className="companion-review" aria-label="Review before saving"><p className="companion-eyebrow">Please check this first</p><h2>{kindName(proposal.kind)}</h2><p className="companion-readback">{proposal.readback}</p><div className="companion-facts"><b>Material details</b>{Object.entries(proposal.payload).filter(([key]) => !key.endsWith('_id') && !key.endsWith('_ids') && key !== 'timezone' && key !== 'share_with_names').map(([key,value]) => <p key={key}><span>{key.replaceAll('_',' ')}</span><strong>{Array.isArray(value) ? value.filter(item => typeof item === 'string' && !validId.test(item)).join(', ') || 'See read-back' : String(value ?? 'Not stated')}</strong></p>)}{proposal.kind === 'support_request' && <p><span>Recipient</span><strong>{home?.permitted_recipients.find(item => item.id === proposal.payload.recipient_user_id)?.name as string || 'Review the read-back'}</strong></p>}{proposal.kind === 'health_note' && <p><span>Shared with</span><strong>{Array.isArray(proposal.payload.share_with_user_ids) && proposal.payload.share_with_user_ids.length ? home?.permitted_recipients.filter(item => (proposal.payload.share_with_user_ids as unknown[]).includes(item.id)).map(item => item.name).join(', ') || 'Named recipients in read-back' : 'Only your care space'}</strong></p>}</div>
        {proposal.kind === 'health_note' && <div className="companion-change"><button className="companion-plain" onClick={() => { setWording(field(proposal.payload, 'wording')); setChanging(!changing); }}>Change wording</button>{changing && <div><label htmlFor="companion-wording">How should this note read?</label><textarea id="companion-wording" value={wording} onChange={e => setWording(e.target.value)} rows={3}/><button className="companion-button companion-secondary" disabled={busy || !wording.trim() || wording.trim() === field(proposal.payload, 'wording')} onClick={() => void proposalAction('revise')}>Review changed note</button></div>}</div>}
        <div className="companion-actions"><button className="companion-button companion-primary" disabled={busy || changing} onClick={() => void proposalAction('confirm')}><Check size={20}/> Confirm and save</button><button className="companion-button companion-secondary" disabled={busy} onClick={() => void proposalAction('cancel')}>Cancel</button><button className="companion-button companion-secondary" disabled={busy} onClick={() => void proposalAction('speech')}>Hear read-back</button></div><p className="companion-small">To speak a correction, tap the record button above. Nothing is saved until you confirm this exact read-back. Expires {stamp(proposal.expires_at)}.</p>
      </section>}
      {reply && <section className="companion-reply"><p className="companion-eyebrow">Parse replied</p><h2>{reply.payload.spoken_text || 'Your reply is ready'}</h2><p>Tap Play reply to hear it. Browser sound needs your tap. The written care details above remain available if audio expires.</p><div className="companion-actions"><button className="companion-button companion-primary" disabled={playing || !connected} onClick={() => void play(reply)}><Play size={19}/> {playing ? 'Playing…' : 'Play reply'}</button><button className="companion-button companion-secondary" onClick={() => stopAudio()}><Square size={18}/> Stop</button><button className="companion-button companion-secondary" disabled={playing || !connected} onClick={() => void play(reply)}>Repeat</button></div></section>}
      {home && <div className="companion-care"><div className="companion-care-title"><p className="companion-eyebrow">Your care, in one place</p><h2>Today’s picture</h2><p>Confirmed details from your care space. Refresh if something has just changed.</p><button className="companion-plain" onClick={() => void load()}><RefreshCw size={18}/> Refresh care details</button></div><div className="companion-care-grid"><CareList title="Recent activity" items={[...home.notes, ...home.measurements].slice(0,5)} describe={item => `${sourceName(item)} · ${stamp(item.created_at || item.occurred_at)}`}/><CareList title="Medicines & checked instructions" items={home.medication_plan?.medicines || []} describe={item => `${field(item,'instructions') || 'Instructions unavailable'} · ${field(item,'reference_source') || (home.medication_plan?.medicines.length ? `Checked by ${String((home.medication_plan as unknown as Record<string, unknown>).checked_by || 'care-space owner')}` : 'Checked plan')}`}/><CareList title="Dose updates" items={home.doses} describe={item => `${(field(item,'report_state') || 'No dose update').replaceAll('_',' ')} · Scheduled ${stamp(item.scheduled_at)}`}/><CareList title="Readings" items={home.measurements} describe={item => `${String(item.systolic || '—')}/${String(item.diastolic || '—')} ${field(item,'unit') || 'mmHg'} · ${stamp(item.occurred_at)}`}/><CareList title="Care tasks" items={home.preventive_tasks} describe={item => `${(field(item,'state') || 'Current task').replaceAll('_',' ')} · ${item.due_date ? `Due ${stamp(item.due_date)}` : 'No due date'}`}/><CareList title="Support & follow-ups" items={[...home.support_requests,...home.followups]} describe={item => `${(field(item,'status') || field(item,'resolution_state') || 'Open').replaceAll('_',' ')} · ${item.check_at ? 'Check ' : ''}${stamp(item.check_at || item.created_at)}`}/></div></div>}
      <footer className="companion-footer"><p><ShieldCheck size={21}/> This browser is linked only after owner approval.</p><button className="companion-plain" disabled={busy || !connected} onClick={() => void pauseReminders()}>Pause reminders</button><button className="companion-plain" disabled={busy} onClick={() => void disconnect()}>Disconnect this browser</button><a href="/">Open owner dashboard (separate sign-in)</a></footer>
    </main>}
    {!booting && error && !home && <div className="companion-alert" role="alert">{error}<button onClick={() => void load()}>Try again</button></div>}
  </div></div>;
}
