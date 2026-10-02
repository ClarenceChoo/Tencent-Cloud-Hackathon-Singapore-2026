import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProposalCorrection from '../ProposalCorrection';
import ProposalDetails from '../ProposalDetails';
import type { Home, Proposal } from '../companionApi';

const home: Home = {
  device_id: 'phone_123', patient: { id: 'p1', name: 'Mei', preferred_name: 'Mei', timezone: 'Asia/Singapore', calling_route: null },
  active_companion: { device_id: null, generation: 1 }, voice: { voice_service: 'simulated', scheduler_enabled: false },
  current_proposal: null, medication_plan: null,
  doses: [{ id: 'dose_one', medicine_name: 'Fictional A', scheduled_at: '2026-10-02T08:00:00Z' }, { id: 'dose_two', medicine_name: 'Fictional B', scheduled_at: '2026-10-02T09:00:00Z' }],
  notes: [], measurements: [], preventive_tasks: [], support_requests: [], followups: [],
  permitted_recipients: [{ id: 'person_a', name: 'Alex' }, { id: 'person_b', name: 'Jo' }],
};
const proposal = (kind: string, payload: Record<string, unknown>): Proposal => ({ id: 'prop_1', context_id: 'ctx_1', kind, payload, readback: 'Read back', status: 'pending', expires_at: '2099-01-01T00:00:00Z' });
afterEach(() => cleanup());

async function edit(item: Proposal, change: (user: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  const user = userEvent.setup();
  const revise = vi.fn(async (_payload: Record<string, unknown>) => {});
  const editing = vi.fn();
  render(<><ProposalDetails proposal={item} home={home}/><ProposalCorrection proposal={item} home={home} busy={false} onEditingChange={editing} onRevise={revise}/></>);
  await user.click(screen.getByRole('button', { name: item.kind === 'health_note' ? 'Change wording' : 'Correct details' }));
  await change(user);
  expect(editing).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole('button', { name: item.kind === 'health_note' ? 'Review changed note' : 'Review corrected details' }));
  expect(revise).toHaveBeenCalledOnce();
  return revise.mock.calls[0][0] as Record<string, unknown>;
}

it('preserves required note fields when wording and sharing change', async () => {
  const payload = { wording: 'Sore knee', symptom: 'pain', occurrence_text: 'yesterday', timezone: 'Asia/Singapore', share_with_user_ids: [] };
  const revised = await edit(proposal('health_note', payload), async user => {
    await user.clear(screen.getByLabelText('How should this note read?'));
    await user.type(screen.getByLabelText('How should this note read?'), 'Sore left knee');
    await user.click(screen.getByRole('checkbox', { name: 'Alex' }));
  });
  expect(revised).toEqual({ ...payload, wording: 'Sore left knee', share_with_user_ids: ['person_a'] });
  expect(screen.queryByText('person_a')).toBeNull();
});

it('corrects a dose choice and reported status through visible choices', async () => {
  const payload = { dose_instance_id: 'dose_one', report_state: 'reported_taken', taken_time_text: '8 am', plan_version: 1 };
  const revised = await edit(proposal('medication_report', payload), async user => {
    await user.selectOptions(screen.getByLabelText('Scheduled medicine'), 'dose_two');
    await user.selectOptions(screen.getByLabelText('Your report'), 'reported_uncertain');
  });
  expect(revised).toEqual({ ...payload, dose_instance_id: 'dose_two', report_state: 'reported_uncertain', taken_time_text: null });
  expect(screen.queryByText('dose_one')).toBeNull();
});

it('corrects blood pressure and stated time while retaining its source', async () => {
  const payload = { measurement_type: 'blood_pressure', systolic: 120, diastolic: 80, unit: 'mmHg', source_description: 'Home cuff', reporting_actor: 'patient', timezone: 'Asia/Singapore', occurred_at: '2026-10-02T08:00:00Z' };
  const revised = await edit(proposal('measurement', payload), async user => {
    await user.clear(screen.getByLabelText('Top number'));
    await user.type(screen.getByLabelText('Top number'), '126');
    await user.clear(screen.getByLabelText('When measured'));
    await user.type(screen.getByLabelText('When measured'), 'this morning');
  });
  expect(screen.getByText('120')).toBeTruthy();
  expect(screen.getByText('80')).toBeTruthy();
  expect(revised).toEqual({ ...payload, systolic: 126, occurred_at: null, occurrence_text: 'this morning' });
});

it('corrects support recipient using the permitted names', async () => {
  const payload = { request_text: 'Need groceries', recipient_user_id: 'person_a', urgency: 'routine' };
  const revised = await edit(proposal('support_request', payload), async user => {
    await user.selectOptions(screen.getByLabelText('Recipient'), 'person_b');
  });
  expect(revised).toEqual({ ...payload, recipient_user_id: 'person_b' });
  expect(screen.queryByText('person_b')).toBeNull();
});
