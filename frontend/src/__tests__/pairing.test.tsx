import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeviceSetup from '../DeviceSetup';
import {Dashboard} from '../api';

afterEach(cleanup);
const data:Dashboard = {
  patient:{id:'p1',name:'Mei Tan',timezone:'Asia/Singapore'},devices:[],medication_plans:[],doses:[],notes:[],measurements:[],preventive_tasks:[],support_requests:[],followups:[],proposals:[],permissions:['*'],access_grants:[],allowed_recipients:[],summaries:[],
  device_setup:{service_address:null,voice_service:'unconfigured',live_voice_verified:false,scheduler_enabled:false},
};

it('retains a failed pairing code and prevents duplicate submissions while pairing', async()=>{
  const user=userEvent.setup();
  let fail!:(reason:Error)=>void;
  const claim=vi.fn(()=>new Promise<void>((_,reject)=>{fail=reject}));
  render(<DeviceSetup data={data} canManage onClaim={claim} onRevoke={vi.fn()}/>);
  await user.type(screen.getByLabelText('One-use device code'),'abcd-1234');
  await user.click(screen.getByRole('button',{name:'Pair cardholder'}));
  expect((screen.getByRole('button',{name:'Pairing…'}) as HTMLButtonElement).disabled).toBe(true);
  expect(claim).toHaveBeenCalledExactlyOnceWith('ABCD-1234');
  fail(new Error('Claim code is expired'));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','Claim code is expired');
  expect((screen.getByLabelText('One-use device code') as HTMLInputElement).value).toBe('abcd-1234');
});

it('shows paired but offline separately from online and never claims live voice is verified',()=>{
  const pending={...data,devices:[{id:'d1',status:'awaiting_connection'}]};
  const props={canManage:true,onClaim:vi.fn(),onRevoke:vi.fn()};
  const {rerender}=render(<DeviceSetup data={pending} {...props}/>);
  expect(screen.getByText('Paired · waiting for connection')).toBeTruthy();
  expect(screen.queryByText('Online',{selector:'.pairing-state'})).toBeNull();
  expect(screen.getByText(/Voice replies are not enabled/)).toBeTruthy();
  rerender(<DeviceSetup data={{...pending,devices:[{id:'d1',status:'connected'}],device_setup:{...data.device_setup!,voice_service:'configured'}}} {...props}/>);
  expect(screen.getByText('Online',{selector:'.pairing-state'})).toBeTruthy();
  expect(screen.getByText(/A successful live conversation still needs to be checked/)).toBeTruthy();
});

it('requires explicit revocation and hides device controls for caregivers',async()=>{
  const user=userEvent.setup();const revoke=vi.fn();
  const pending={...data,devices:[{id:'d1',status:'awaiting_connection'}]};
  const {rerender}=render(<DeviceSetup data={pending} canManage onClaim={vi.fn()} onRevoke={revoke}/>);
  await user.click(screen.getByRole('button',{name:'Revoke device access'}));
  expect(revoke).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Keep connected'}));
  expect(revoke).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Revoke device access'}));
  await user.click(screen.getByRole('button',{name:'Revoke access'}));
  await waitFor(()=>expect(revoke).toHaveBeenCalledExactlyOnceWith('d1'));
  rerender(<DeviceSetup data={pending} canManage={false} onClaim={vi.fn()} onRevoke={revoke}/>);
  expect(screen.queryByLabelText('One-use device code')).toBeNull();
  expect(screen.queryByRole('button',{name:'Revoke device access'})).toBeNull();
});
