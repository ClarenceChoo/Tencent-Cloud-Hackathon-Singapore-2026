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
