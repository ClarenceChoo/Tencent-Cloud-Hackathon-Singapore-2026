import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CompanionSelection from '../CompanionSelection';
import {Dashboard} from '../api';
afterEach(cleanup);
const data:Dashboard={patient:{id:'p',name:'Mei',timezone:'Asia/Singapore'},devices:[{id:'pendant',device_type:'pendant'},{id:'phone',device_type:'phone',display_name:'Mei iPhone'}],active_companion:{device_id:'pendant',generation:3},medication_plans:[],doses:[],notes:[],measurements:[],preventive_tasks:[],support_requests:[],followups:[],proposals:[],permissions:['*'],access_grants:[],allowed_recipients:[],summaries:[]};
it('requires physical power-off acknowledgement and sends the observed generation',async()=>{
 const user=userEvent.setup(),onSelect=vi.fn(async()=>{});
 render(<CompanionSelection data={data} canManage onSelect={onSelect}/>);
 await user.selectOptions(screen.getByLabelText('Send reminders to'),'phone');
 const button=screen.getByRole('button',{name:'Save reminder companion'}) as HTMLButtonElement;
 expect(button.disabled).toBe(true);
 await user.click(screen.getByRole('checkbox'));
 await user.click(button);
 expect(onSelect).toHaveBeenCalledExactlyOnceWith('phone',3,true);
});
it('requires cleanup on the old phone even after revocation and hides caregiver controls',()=>{
 const selected={...data,active_companion:{device_id:'phone',generation:4},devices:[data.devices[0],{...data.devices[1],revoked_at:'2026-09-27T00:00:00Z'}]};
 const {rerender}=render(<CompanionSelection data={selected} canManage onSelect={vi.fn()}/>);
 expect((screen.getByLabelText('Send reminders to') as HTMLSelectElement).disabled).toBe(true);
 expect(screen.getByText(/including after its access is revoked/)).toBeTruthy();
 rerender(<CompanionSelection data={selected} canManage={false} onSelect={vi.fn()}/>);
 expect(screen.queryByLabelText('Send reminders to')).toBeNull();
});
it('surfaces a stale-selection failure without claiming success',async()=>{
 const user=userEvent.setup();
 render(<CompanionSelection data={data} canManage onSelect={vi.fn(async()=>{throw new Error('Selection changed. Refresh.');})}/>);
 await user.selectOptions(screen.getByLabelText('Send reminders to'),'phone');
 await user.click(screen.getByRole('checkbox'));
 await user.click(screen.getByRole('button',{name:'Save reminder companion'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Selection changed. Refresh.');
});
it('requires removal acknowledgement for the exact revoked phone and keeps selection separate',async()=>{
 const user=userEvent.setup(),onReleaseRemoved=vi.fn(async()=>{}),onSelect=vi.fn(async()=>{});
 const selected={...data,active_companion:{device_id:'phone',generation:4},devices:[data.devices[0],{...data.devices[1],revoked_at:'2026-09-27T00:00:00Z'}]};
 const {rerender}=render(<CompanionSelection data={selected} canManage onSelect={onSelect} onReleaseRemoved={onReleaseRemoved}/>);
 const button=screen.getByRole('button',{name:'Finish removing this phone'}) as HTMLButtonElement;
 expect(button.disabled).toBe(true);
 await user.click(screen.getByLabelText('I have uninstalled Parse or cleared its app data on the old phone.'));
 await user.click(button);
 expect(onReleaseRemoved).toHaveBeenCalledExactlyOnceWith('phone',4);
 expect(onSelect).not.toHaveBeenCalled();
 expect((screen.getByLabelText('Send reminders to') as HTMLSelectElement).disabled).toBe(true);
 rerender(<CompanionSelection data={{...selected,active_companion:{device_id:null,generation:5}}} canManage onSelect={onSelect} onReleaseRemoved={onReleaseRemoved}/>);
 expect(screen.queryByRole('button',{name:'Finish removing this phone'})).toBeNull();
 expect(screen.getByText(/Reminders are paused/)).toBeTruthy();
});
it('hides removal recovery from caregivers and unrevoked phones',()=>{
 const selected={...data,active_companion:{device_id:'phone',generation:4}};
 const {rerender}=render(<CompanionSelection data={selected} canManage onSelect={vi.fn()} onReleaseRemoved={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:'Finish removing this phone'})).toBeNull();
 rerender(<CompanionSelection data={{...selected,devices:[{...data.devices[1],revoked_at:'2026-09-27T00:00:00Z'}]}} canManage={false} onSelect={vi.fn()} onReleaseRemoved={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:'Finish removing this phone'})).toBeNull();
});
it('shows recovery failures and resets the acknowledgement when the observed route changes',async()=>{
 const user=userEvent.setup(),onReleaseRemoved=vi.fn(async()=>{throw new Error('Selection changed. Refresh.');});
 const selected={...data,active_companion:{device_id:'phone',generation:4},devices:[{...data.devices[1],revoked_at:'2026-09-27T00:00:00Z'}]};
 const {rerender}=render(<CompanionSelection data={selected} canManage onSelect={vi.fn()} onReleaseRemoved={onReleaseRemoved}/>);
 await user.click(screen.getByRole('checkbox'));
 await user.click(screen.getByRole('button',{name:'Finish removing this phone'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Selection changed. Refresh.');
 rerender(<CompanionSelection data={{...selected,active_companion:{device_id:'phone',generation:6}}} canManage onSelect={vi.fn()} onReleaseRemoved={onReleaseRemoved}/>);
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 expect((screen.getByRole('button',{name:'Finish removing this phone'}) as HTMLButtonElement).disabled).toBe(true);
});
