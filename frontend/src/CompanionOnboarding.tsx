import { useState } from 'react';
import type { SetupProgress, SetupStep } from './setupJourney';

const labels: Record<SetupStep, string> = {
  approve: 'Owner approval', connection: 'Current connection', reminders: 'Reminder destination',
  speaker: 'Speaker check', microphone: 'Microphone exercise', first_update: 'First confirmed update', done: 'Ready',
};

export default function CompanionOnboarding({
  progress, onSpeakerCheck, onMicrophoneCheck, onCancelMicrophoneCheck, onStartFirstUpdate, onDismiss, working = false,
}: {
  progress: SetupProgress;
  onSpeakerCheck: () => void | Promise<void>;
  onMicrophoneCheck: () => void | Promise<void>;
  onCancelMicrophoneCheck?: () => void;
  onStartFirstUpdate: () => void;
  onDismiss: () => void;
  working?: boolean;
}) {
  const [tutorialOpen, setTutorialOpen] = useState(false);
  return <section className="companion-onboarding" aria-label="First-use guide">
    <div className="companion-onboarding-head"><div><p className="companion-eyebrow">First-use guide</p><h2>{progress.step === 'done' ? 'Your first update is saved' : 'Let’s get ready together'}</h2></div><button className="companion-plain" onClick={onDismiss}>Close guide</button></div>
    <p role="status" aria-live="polite">{progress.step === 'done' ? 'A record was confirmed in this browser session.' : `Next: ${labels[progress.step]}`}</p>
    <ol className="companion-onboarding-steps">{(Object.keys(labels) as SetupStep[]).filter(step => step !== 'done').map(step =>
      <li key={step} className={progress.completed.includes(step) ? 'is-done' : progress.step === step ? 'is-current' : ''}>
        <strong>{labels[step]}</strong><span>{progress.completed.includes(step) ? 'Checked in this session' : progress.step === step ? 'Current step' : 'Waiting'}</span>
      </li>)}</ol>
    {progress.step === 'approve' && <p>Ask the care-space owner to approve the code shown on this browser for the right person. The owner signs in separately.</p>}
    {progress.step === 'connection' && <p>Check that this browser is connected to the intended person, then refresh this page. Pairing alone does not prove a current connection.</p>}
    {(progress.step === 'reminders' || progress.completed.includes('reminders')) && <p>{progress.reminderAvailability}</p>}
    {progress.step === 'reminders' && <p>Ask the owner to select this browser under Reminder companion in Settings. Return here and refresh after selection.</p>}
    {progress.step === 'speaker' && <div><p>Tap to play a short setup message. Check that you can hear it. This checks the speaker only.</p><button className="companion-button companion-secondary" disabled={working || progress.voiceMode === 'unavailable'} onClick={() => void onSpeakerCheck()}>{working ? 'Checking speaker…' : 'Play speaker check'}</button>{progress.voiceMode === 'unavailable' && <p>Voice service is unavailable. Ask the owner to check the service setup before retrying.</p>}{progress.voiceMode === 'simulated' && <p>This is simulated speech for testing. It does not verify live voice service.</p>}</div>}
    {progress.step === 'microphone' && <div><p>Tap to request microphone permission. This exercise releases the microphone immediately and sends no audio.</p><button className="companion-button companion-secondary" disabled={working} onClick={() => void onMicrophoneCheck()}>{working ? 'Waiting for permission…' : 'Check microphone permission'}</button>{working && onCancelMicrophoneCheck && <button className="companion-plain" onClick={onCancelMicrophoneCheck}>Cancel microphone check</button>}</div>}
    {progress.step === 'first_update' && <div><p>Record a real update below. Review the exact read-back, then choose Confirm and save or Cancel. Nothing is saved by this guide.</p><button className="companion-button companion-primary" onClick={onStartFirstUpdate}>Start first update</button></div>}
    {progress.step === 'done' && <div><p>{progress.liveVoiceVerified ? 'A completed live voice turn was checked in this session.' : 'Live voice has not been verified. A tutorial or simulated response cannot verify it.'}</p><p>To check caregiver visibility, ask the intended recipient to sign in to their own account and view an explicitly shared update. This page cannot prove that they saw it.</p></div>}
    <details className="companion-tutorial" open={tutorialOpen} onToggle={event => setTutorialOpen(event.currentTarget.open)}><summary>See a static example first</summary><p><strong>Demonstration only.</strong> Example: “I walked around the garden today.” Parse might show a read-back for review. You would then choose whether to save it.</p><p>This example does not use the microphone, contact a provider, create a care record, or count as a successful voice check.</p></details>
  </section>;
}
