import type { Dashboard, Row } from './api';

const initialLabels: Record<string, string> = {
  'Maya Tan (sample)': 'Maya Tan',
  'Alex Tan (sample)': 'Alex Tan',
  'Sample daily medicine': 'Daily medicine',
  'One tablet after breakfast (fictional example)': 'One tablet after breakfast',
  'Fictional sample plan': 'Entered medication plan',
  'Fictional care plan': 'Entered care plan',
  'Sample caregiver report': 'Caregiver report',
  'Sample home monitor': 'Home monitor',
};

/** Update only known starter labels; preserve IDs, facts, permissions and provenance. */
export function presentCareLabels(state: Dashboard): Dashboard {
  function fields(row: Row, keys: string[]) {
    for (const key of keys) {
      const value = row[key];
      if (typeof value === 'string' && initialLabels[value]) row[key] = initialLabels[value];
    }
  }
  fields(state.patient as unknown as Row, ['name']);
  for (const plan of state.medication_plans) {
    fields(plan, ['source']);
    if (Array.isArray(plan.medicines)) for (const medicine of plan.medicines as Row[]) fields(medicine, ['name', 'instructions', 'reviewed_reference', 'reference_source']);
  }
  for (const dose of state.doses) fields(dose, ['medicine_name', 'instructions']);
  for (const note of state.notes) fields(note, ['source']);
  for (const reading of state.measurements) fields(reading, ['source_description']);
  for (const task of state.preventive_tasks) fields(task, ['source']);
  for (const person of state.allowed_recipients) fields(person, ['name']);
  for (const request of state.support_requests) fields(request, ['recipient_name']);
  return state;
}
