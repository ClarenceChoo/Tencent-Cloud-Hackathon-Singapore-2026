import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(permissions = ['*']) {
  const patient = { id:'patient-1', name:'Mei Tan', timezone:'Asia/Singapore' };
  const session = { user:{id:'owner',name:'Alex Tan',role:'owner'}, patients:[patient], csrf_token:'test' };
  const dashboard = {
    patient, permissions, devices:[], access_grants:[], allowed_recipients:[], summaries:[], proposals:[], followups:[], support_requests:[],
    medication_plans:[{id:'plan',active:true,version:2}],
    doses:[
      {id:'reported',medicine_name:'Morning medicine',report_state:'reported_taken',report_time:'2026-01-01T16:05:00Z'},
      {id:'future',medicine_name:'Upcoming medicine',plan_version:2,scheduled_at:'2030-01-10T00:00:00Z',report_state:'unconfirmed'},
      {id:'old-plan',medicine_name:'Retired medicine',plan_version:1,scheduled_at:'2030-01-10T00:00:00Z',report_state:'unconfirmed'},
    ],
    notes:[{id:'note',wording:'Knee discomfort after walking',created_at:'2026-01-01T16:15:00Z',shared_with_user_ids:[]}],
    measurements:[{id:'reading',systolic:126,diastolic:76,unit:'mmHg',occurred_at:'2026-01-01T16:20:00Z',source_description:'Home cuff'}],
    preventive_tasks:[{id:'task',description:'Discuss next review',due_date:'2030-01-11',state:'due'}],
  };
  vi.stubGlobal('scrollTo',vi.fn());
  vi.stubGlobal('fetch',vi.fn(async (input:RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/auth/session') ? session : dashboard),{headers:{'Content-Type':'application/json'}})));
  render(<App/>);
  return userEvent.setup();
}

it('filters the timeline, uses the patient timezone and keeps scheduled doses outside reported history',async () => {
  const user = mount();
  await screen.findByRole('heading',{name:'Mei Tan’s care timeline'});
  const timeline = within(await screen.findByRole('region',{name:'Care timeline'}));
  const day = within(timeline.getByRole('region',{name:'2026-01-02'}));
  expect(day.getAllByRole('heading',{level:3}).map(node=>node.textContent)).toEqual(['Morning medicine','Knee discomfort after walking','126 / 76 mmHg']);
  expect(day.getByText('00:05')).toBeTruthy();
  expect(timeline.queryByText('Upcoming medicine')).toBeNull();
  expect(within(screen.getByRole('complementary',{name:'Care at a glance'})).getByText('Upcoming medicine')).toBeTruthy();
  expect(screen.queryByText('Retired medicine')).toBeNull();
  expect(within(timeline.getByRole('region',{name:'Date not recorded'})).getByText('Discuss next review')).toBeTruthy();
  expect(screen.getByText('No arranged visit recorded.')).toBeTruthy();
  const filters = within(screen.getByRole('group',{name:'Filter timeline'}));
  await user.click(filters.getByRole('button',{name:'Notes'}));
  expect(timeline.getAllByRole('article')).toHaveLength(1);
  expect(timeline.queryByText('Morning medicine')).toBeNull();
  await user.click(timeline.getByRole('button',{name:'View'}));
  expect(timeline.getByRole('button',{name:'Manage sharing →'})).toBeTruthy();
  expect(timeline.getByRole('button',{name:'Delete note'})).toBeTruthy();
  await user.click(filters.getByRole('button',{name:'Readings'}));
  await user.click(timeline.getByRole('button',{name:'View'}));
  expect(timeline.getByRole('button',{name:'Correct this reading →'})).toBeTruthy();
});

it('lets a read-only viewer expand entries without exposing write or sharing controls',async () => {
  const user = mount(['read:dashboard']);
  const timeline = within(await screen.findByRole('region',{name:'Care timeline'}));
  expect(screen.queryByRole('button',{name:'Add entry'})).toBeNull();
  await user.click(within(screen.getByRole('group',{name:'Filter timeline'})).getByRole('button',{name:'Notes'}));
  await user.click(timeline.getByRole('button',{name:'View'}));
  expect(timeline.queryByRole('button',{name:'Manage sharing →'})).toBeNull();
  expect(timeline.queryByRole('button',{name:'Delete note'})).toBeNull();
  await user.click(within(screen.getByRole('group',{name:'Filter timeline'})).getByRole('button',{name:'Readings'}));
  await user.click(timeline.getByRole('button',{name:'View'}));
  expect(timeline.queryByRole('button',{name:'Correct this reading →'})).toBeNull();
});
