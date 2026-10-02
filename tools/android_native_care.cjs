/* Native recorder/player/UI care journeys. Interpretation remains explicitly scripted. */
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
module.exports = async function nativeCare({ record, find, tap, screenshot, pass, owner, caregiver, restricted, fixture }) {
  const patient = '/app/patients/' + fixture.patient_id;
  async function waitFor(select, message) {
    for (let i = 0; i < 20; i++) {
      const value = select(await owner.dash());
      if (value) return value;
      await sleep(300);
    }
    throw new Error('Native confirmation did not reach dashboard: ' + message);
  }
  async function propose(name, kind, payload, expected) {
    await record(name, { intent: 'proposal', kind, payload }, expected);
    await find('Have I got that right?');
  }
  async function confirm(select, message) {
    await tap('Confirm and save');
    return waitFor(select, message);
  }
  const source = row => assert.equal(row.provenance.type, 'phone');
  const future = new Date(Date.now() + 3600000).toISOString();
  const day = offset => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });

  // These are fictional, explicitly checked plan entries created by the owner API.
  const states = ['reported_taken', 'reported_skipped', 'reported_not_yet', 'reported_uncertain'];
  await owner.api(patient + '/medication-plans', {
    timezone: 'Asia/Singapore', source: 'Fictional native test label', checked: true,
    medicines: states.map((_, i) => ({ id: 'native_med_' + i, name: 'Fictional DemoMed ' + i,
      instructions: 'Fictional test instruction', reviewed_reference: 'Reviewed fictional reference ' + i,
      reference_source: 'Fictional label v1' })),
    schedule: states.map((_, i) => ({ medicine_id: 'native_med_' + i, local_time: '23:59' })),
  });
  const explanation = await record('checked-medication-explanation', { intent: 'explain',
    payload: { medicine_id: 'native_med_0' }, spoken_text: 'INVENTED INSTRUCTION' }, 'Reviewed fictional reference 0');
  assert(!explanation.includes('INVENTED'));
  pass('Native medication explanation uses reviewed plan text instead of scripted invented instructions');
  for (const [i, state] of states.entries()) {
    const dose = (await owner.dash()).doses.filter(d => d.medicine_id === 'native_med_' + i)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
    assert(dose && dose.report_state === 'unconfirmed');
    await propose('medication-' + state, 'medication_report', { dose_instance_id: dose.id,
      report_state: state, ...(i === 0 ? { taken_time_text: 'with fictional breakfast' } : {}) }, 'Fictional DemoMed ' + i);
    assert.equal((await owner.dash()).doses.find(d => d.id === dose.id).report_state, 'unconfirmed');
    const updated = await confirm(d => d.doses.find(row => row.id === dose.id && row.report_state === state), state);
    source(updated);
    assert.equal(updated.report_history.length, 1);
    pass('Native ' + state + ' remains unsaved until confirmation and preserves phone provenance');
  }
  await propose('external-blood-pressure', 'measurement', { measurement_type: 'blood_pressure', systolic: 125,
    diastolic: 78, unit: 'mmHg', source_description: 'Existing fictional cuff', reporting_actor: 'patient',
    timezone: 'Asia/Singapore', occurrence_text: 'after fictional breakfast' }, '125');
  assert.equal((await owner.dash()).measurements.length, 0);
  const reading = await confirm(d => d.measurements.find(r => r.source_description === 'Existing fictional cuff'), 'external reading');
  assert.equal(reading.unit, 'mmHg'); assert.equal(reading.occurred_at, null); source(reading);
  pass('Native external reading preserves unit, stated occurrence and cuff source separately from phone provenance');

  const draft = await owner.api(patient + '/proposals', { kind: 'preventive_task', payload: { task_type: 'review',
    description: 'Fictional native care review', source: 'Fictional care plan', timezone: 'Asia/Singapore', due_date: day(-3), state: 'due' } });
  await owner.api('/app/proposals/' + draft.id + '/confirm', { confirmed: true });
  const task = (await owner.dash()).preventive_tasks.find(t => t.description === 'Fictional native care review');
  assert(task);
  await propose('preventive-arranged', 'preventive_task', { task_id: task.id, state: 'arranged', appointment_date: day(-2) }, 'arranged');
  await confirm(d => d.preventive_tasks.find(t => t.id === task.id && t.state === 'arranged'), 'arranged task');
  await propose('preventive-completed', 'preventive_task', { task_id: task.id, state: 'completed', completion_date: day(0) }, 'completed');
  const completed = await confirm(d => d.preventive_tasks.find(t => t.id === task.id && t.state === 'completed'), 'completed task');
  assert.deepEqual([completed.due_date, completed.appointment_date, completed.completion_date], [day(-3), day(-2), day(0)]);
  assert.deepEqual(completed.transitions.map(t => t.to_state), ['due', 'arranged', 'completed']); source(completed);
  pass('Native preventive transitions preserve distinct due, appointment and completion dates');

  await propose('support-request', 'support_request', { request_text: 'Please help arrange a fictional refill',
    recipient_user_id: fixture.caregiver_id, barrier_text: 'Fictional transport difficulty', urgency: 'routine' }, 'fictional refill');
  const support = await confirm(d => d.support_requests.find(s => s.request_text.includes('fictional refill')), 'support request');
  source(support);
  assert.equal((await restricted.dash()).support_requests.length, 0);
  const status = { intent: 'support_status', payload: { record_id: support.id }, spoken_text: 'INVENTED RESOLUTION' };
  await record('support-unacknowledged', status, 'has not acknowledged');
  await caregiver.api('/app/support-requests/' + support.id + '/acknowledge', {});
  await record('support-acknowledged', status, 'has acknowledged');
  await propose('followup-create', 'followup', { related_type: 'support_request', related_id: support.id,
    check_at: future, permission_scope: 'related_recipients' }, 'follow');
  const followup = await confirm(d => d.followups.find(f => f.related_id === support.id), 'followup');
  await caregiver.api('/app/support-requests/' + support.id + '/resolve', { outcome: 'A fictional refill was arranged' });
  await record('support-resolved', status, 'A fictional refill was arranged');
  await propose('followup-outcome', 'followup', { followup_id: followup.id, resolution_state: 'resolved',
    reported_outcome: 'The fictional medicine was collected' }, 'The fictional medicine was collected');
  const resolution = await confirm(d => d.followups.find(f => f.id === followup.id && f.resolution_state === 'resolved'), 'followup outcome');
  source(resolution.resolutions[0]);
  await record('followup-status', { intent: 'followup_status', payload: { record_id: followup.id } }, 'The fictional medicine was collected');
  assert.equal((await restricted.dash()).followups.length, 0);
  pass('Native support and followup responses reflect actual caregiver acknowledgement and recorded outcomes with recipient privacy');

  const count = (await owner.dash()).notes.length;
  await record('ordinary-chat', { intent: 'chat', spoken_text: 'Hello Mei. We can talk for a moment.' }, 'Hello Mei');
  assert.equal((await owner.dash()).notes.length, count);
  pass('Native companionship response does not silently create a shared health note');
  await screenshot('native-care-journeys');
};
