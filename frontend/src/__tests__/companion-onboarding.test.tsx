import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompanionOnboarding from '../CompanionOnboarding';
import type { SetupProgress } from '../setupJourney';

afterEach(cleanup);
const progress: SetupProgress = {
  step: 'speaker', completed: ['approve', 'connection', 'reminders'],
  voiceMode: 'live', reminderAvailability: 'Selected browser reminders can play only while this companion page is open and visible.',
  liveVoiceVerified: false,
};

it('requires explicit gestures and keeps the static tutorial inert', async () => {
  const user = userEvent.setup();
  const speaker = vi.fn(), microphone = vi.fn(), first = vi.fn(), dismiss = vi.fn();
  const { rerender } = render(<CompanionOnboarding progress={progress} onSpeakerCheck={speaker} onMicrophoneCheck={microphone} onStartFirstUpdate={first} onDismiss={dismiss}/>);
  expect(speaker).not.toHaveBeenCalled();
  expect(microphone).not.toHaveBeenCalled();
  await user.click(screen.getByText('See a static example first'));
  expect(screen.getByText(/does not use the microphone/)).toBeTruthy();
  expect(speaker).not.toHaveBeenCalled();
  expect(microphone).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Play speaker check' }));
  expect(speaker).toHaveBeenCalledOnce();
  rerender(<CompanionOnboarding progress={{ ...progress, step: 'microphone', completed: [...progress.completed, 'speaker'] }} working onSpeakerCheck={speaker} onMicrophoneCheck={microphone} onCancelMicrophoneCheck={dismiss} onStartFirstUpdate={first} onDismiss={dismiss}/>);
  await user.click(screen.getByRole('button', { name: 'Cancel microphone check' }));
  expect(dismiss).toHaveBeenCalledOnce();
  expect(microphone).not.toHaveBeenCalled();
  rerender(<CompanionOnboarding progress={{ ...progress, step: 'first_update', completed: [...progress.completed, 'speaker', 'microphone'] }} onSpeakerCheck={speaker} onMicrophoneCheck={microphone} onStartFirstUpdate={first} onDismiss={dismiss}/>);
  await user.click(screen.getByRole('button', { name: 'Start first update' }));
  expect(first).toHaveBeenCalledOnce();
});
