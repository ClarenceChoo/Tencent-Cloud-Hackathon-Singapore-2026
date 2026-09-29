import type { ReminderSchedule } from "./contracts";
export const ALERT_TITLE = "Parse";
export const ALERT_BODY = "Open Parse to check your care schedule.";
export type LocalAlert = { id: string; at: number };
export function desiredAlerts(
  schedule: ReminderSchedule,
  now: number,
): LocalAlert[] {
  const serverNow = Date.parse(schedule.server_time),
    validUntil = Date.parse(schedule.valid_until);
  if (
    !Number.isFinite(serverNow) ||
    !Number.isFinite(validUntil) ||
    validUntil - serverNow > 86401000 ||
    validUntil <= serverNow
  )
    throw new Error("Invalid reminder schedule horizon.");
  if (schedule.active_companion.device_id !== schedule.device_id) return [];
  if (schedule.alerts.length > 60) throw new Error("Too many native alerts.");
  const seen = new Set<string>();
  return schedule.alerts.map((alert) => {
    const id = `parse.${schedule.device_id}.${alert.occurrence_id}.g${schedule.active_companion.generation}`;
    const due = Date.parse(alert.due_at);
    if (
      alert.identity !== id ||
      alert.route_generation !== schedule.active_companion.generation ||
      seen.has(id) ||
      !Number.isFinite(due) ||
      due <= serverNow ||
      due > validUntil
    )
      throw new Error("Invalid or duplicated notification identity.");
    seen.add(id);
    return { id, at: now + due - serverNow };
  });
}
export class AlertSerialiser {
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  suspended = false;
  run(work: (current: () => boolean) => Promise<void>): Promise<void> {
    const epoch = this.epoch;
    const task = this.tail
      .catch(() => {})
      .then(() => work(() => !this.suspended && epoch === this.epoch));
    this.tail = task;
    return task;
  }
  clear(work: () => Promise<void>): Promise<void> {
    this.suspended = true;
    this.epoch++;
    const task = this.tail.catch(() => {}).then(work);
    this.tail = task;
    return task;
  }
  resume() {
    this.suspended = false;
  }
}
