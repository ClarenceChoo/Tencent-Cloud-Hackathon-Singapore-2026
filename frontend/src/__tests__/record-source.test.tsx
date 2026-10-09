import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordSource, RecordHistory } from '../RecordSource';
import App from '../App';

afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('labels the recording channel without exposing raw identifiers or claiming a phone measured the reading', () => {
  const {container, rerender} = render(<RecordSource row={{source_description:'Existing home cuff', provenance:{type:'phone', device_id:'private-device-id', turn_id:'private-turn-id', confirmed_at:'2026-09-27T01:00:00Z'}}}/>);
  expect(screen.getByText(/Recorded via Parse phone/)).toBeTruthy();
  expect(container.textContent).not.toMatch(/private-device-id|private-turn-id|measured by/);
  rerender(<RecordSource row={{provenance:{type:'unknown'}}}/>);
  expect(screen.getByText('Source not recorded')).toBeTruthy();
  expect(screen.queryByText(/dashboard/)).toBeNull();
});

it('keeps creation and later transition sources with separate appointment and completion dates', async () => {
  render(<RecordHistory row={{transitions:[
    {id:'due',to_state:'due',provenance:{type:'dashboard'}},
    {id:'arranged',to_state:'arranged',appointment_date:'2026-10-03',provenance:{type:'pendant'}},
    {id:'completed',to_state:'completed',completion_date:'2026-10-04',provenance:{type:'phone'}},
  ]}}/>);
  await userEvent.setup().click(screen.getByText('Confirmed history (3)'));
  expect(screen.getByText('Recorded via care dashboard')).toBeTruthy();
  expect(screen.getByText('Recorded via Parse cardholder')).toBeTruthy();
  expect(screen.getByText('Recorded via Parse phone')).toBeTruthy();
  expect(screen.getByText(/arranged · Appointment/).textContent).toContain('Oct 3');
  expect(screen.getByText(/completed · Completed/).textContent).toContain('Oct 4');
});

it('shows a phone-origin timeline entry and the selected phone instead of the first paired pendant', async () => {
  const patient={id:'patient',name:'Fictional Mei',timezone:'Asia/Singapore'};
  const session={user:{id:'owner',name:'Owner',role:'owner'},patients:[patient],csrf_token:'fixture'};
  const dashboard={patient,devices:[{id:'pendant',device_type:'pendant',status:'connected'},{id:'phone',device_type:'phone',status:'connected'}],active_companion:{device_id:'phone',generation:2},
    medication_plans:[],doses:[],measurements:[],preventive_tasks:[],support_requests:[],followups:[],proposals:[],permissions:['*'],access_grants:[],allowed_recipients:[],summaries:[],
    notes:[{id:'note',wording:'Fictional confirmed note',created_at:'2026-09-27T01:00:00Z',provenance:{type:'phone',confirmed_at:'2026-09-27T01:00:00Z'}}]};
  vi.stubGlobal('scrollTo',vi.fn());
  vi.stubGlobal('fetch',vi.fn(async (url:RequestInfo|URL)=>new Response(JSON.stringify(String(url).endsWith('/auth/session')?session:dashboard),{headers:{'Content-Type':'application/json'}})));
  render(<App/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
  await screen.findByRole('heading',{name:'Fictional confirmed note'});
  expect(screen.getByText(/Recorded via Parse phone/)).toBeTruthy();
  expect(screen.getByRole('button',{name:/Phone connected/})).toBeTruthy();
  expect(screen.queryByText('Cardholder connected')).toBeNull();
});
