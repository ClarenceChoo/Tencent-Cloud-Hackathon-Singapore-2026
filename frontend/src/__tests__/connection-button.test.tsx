import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionButton } from '../ConnectionButton';
import { Dashboard } from '../api';

afterEach(cleanup);
const data: Dashboard = { patient: { id: 'p', name: 'Mei', timezone: 'Asia/Singapore' }, permissions: ['*'],
  devices: [], active_companion: { device_id: null, generation: 0 }, medication_plans: [], doses: [], notes: [],
  measurements: [], preventive_tasks: [], support_requests: [], followups: [], proposals: [], access_grants: [], allowed_recipients: [], summaries: [] };
const props = { stale: false, preview: false, active: false, onOpen: vi.fn() };

it('tracks the selected companion from paired to live to offline without counting a different online device', () => {
  const selected = { ...data, active_companion: { device_id: 'selected', generation: 1 },
    devices: [{ id: 'other', status: 'connected' }, { id: 'selected', status: 'awaiting_connection' }] };
  const { rerender } = render(<ConnectionButton data={selected} {...props}/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Waiting for connection' })).toBeTruthy();
  rerender(<ConnectionButton data={{ ...selected, devices: [{ id: 'selected', status: 'connected' }] }} {...props}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Companion connection: Connected' }));
  expect(props.onOpen).toHaveBeenCalledOnce();
  rerender(<ConnectionButton data={{ ...selected, devices: [{ id: 'selected', status: 'stale' }] }} {...props}/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Offline' })).toBeTruthy();
});

it('does not claim a revoked, unselected or stale cached connection is live', () => {
  const live = { ...data, active_companion: { device_id: 'd', generation: 1 }, devices: [{ id: 'd', status: 'connected' }] };
  const { rerender } = render(<ConnectionButton data={live} {...props} stale/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Status unavailable' })).toBeTruthy();
  rerender(<ConnectionButton data={{ ...live, devices: [{ id: 'd', status: 'connected', revoked_at: '2026-10-09T00:00:00Z' }] }} {...props}/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Connect' })).toBeTruthy();
  rerender(<ConnectionButton data={{ ...live, active_companion: { device_id: null, generation: 2 } }} {...props}/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Connect' })).toBeTruthy();
});

it('keeps missing patient data and the fictional preview distinct from a live connection', () => {
  const { rerender } = render(<ConnectionButton data={null} {...props}/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Checking connection' }).hasAttribute('disabled')).toBe(true);
  rerender(<ConnectionButton data={{ ...data, active_companion: { device_id: 'd', generation: 1 }, devices: [{ id: 'd', status: 'connected' }] }} {...props} preview/>);
  expect(screen.getByRole('button', { name: 'Companion connection: Connection demo' }).title).toContain('no live companion');
  expect(screen.queryByRole('button', { name: 'Companion connection: Connected' })).toBeNull();
});
