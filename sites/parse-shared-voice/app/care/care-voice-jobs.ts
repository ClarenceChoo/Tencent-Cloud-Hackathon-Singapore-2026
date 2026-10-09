import type { CareContext } from "./care-backend";
import { requireCare } from "./care-state";

export const VOICE_JOB_LEASE_MS = 90_000;
export const MAX_VOICE_JOB_ATTEMPTS = 3;
const MAX_CARE_STATE_JSON = 900_000;
const ATTEMPTS_EXHAUSTED = "This clip could not be interpreted after three attempts. Record again or enter the update in the dashboard.";
const attemptsExpression = "COALESCE(CAST(json_extract(CASE WHEN json_valid(care_voice_jobs.result_json) THEN care_voice_jobs.result_json ELSE '{}' END, '$.attempts') AS INTEGER), 0)";

/**
 * Atomically acquire the per-recording job and enforce one fresh job per room.
 * updated_at doubles as the fencing token; monotonically increasing it also
 * makes two quick retries distinguishable when the wall clock has not ticked.
 */
export async function acquireVoiceJob(
  db: D1Database,
  ownerId: string,
  recordingId: string,
  roomId: string,
): Promise<number> {
  const now = Date.now();
  const staleBefore = now - VOICE_JOB_LEASE_MS;
  const leaseAt = now;
  const existing = await db
    .prepare("SELECT state, updated_at, result_json FROM care_voice_jobs WHERE recording_id = ? AND owner_id = ?")
    .bind(recordingId, ownerId)
    .first<{ state: string; updated_at: number; result_json: string | null }>();
  if (existing && (existing.state === "failed" || (existing.state === "processing" && existing.updated_at < staleBefore))) {
    let attempts = 0;
    try {
      const parsed = JSON.parse(existing.result_json ?? "null") as { attempts?: unknown } | null;
      if (typeof parsed?.attempts === "number" && Number.isInteger(parsed.attempts) && parsed.attempts > 0) attempts = parsed.attempts;
    } catch {
      // Legacy rows have no attempt metadata and receive the conservative default below.
    }
    requireCare(attempts < MAX_VOICE_JOB_ATTEMPTS, 429, ATTEMPTS_EXHAUSTED);
  }
  const result = await db
    .prepare(
      `INSERT INTO care_voice_jobs (recording_id, owner_id, state, result_json, updated_at)
       SELECT ?, ?, 'processing', json_object('attempts', 1), ?
       WHERE EXISTS (
         SELECT 1 FROM voice_recordings r
         WHERE r.id = ? AND r.owner_id = ? AND r.room_id = ?
       )
       AND NOT EXISTS (
         SELECT 1
         FROM care_voice_jobs active
         JOIN voice_recordings r ON r.id = active.recording_id
         WHERE active.owner_id = ? AND r.room_id = ?
           AND active.recording_id <> ?
           AND active.state = 'processing' AND active.updated_at >= ?
       )
       ON CONFLICT(recording_id) DO UPDATE SET
         state = 'processing', result_json = json_object('attempts', ${attemptsExpression} + 1),
         updated_at = MAX(?, care_voice_jobs.updated_at + 1)
       WHERE care_voice_jobs.owner_id = excluded.owner_id
         AND (care_voice_jobs.state = 'failed'
           OR (care_voice_jobs.state = 'processing' AND care_voice_jobs.updated_at < ?))
         AND ${attemptsExpression} < ?`,
    )
    .bind(
      recordingId,
      ownerId,
      leaseAt,
      recordingId,
      ownerId,
      roomId,
      ownerId,
      roomId,
      recordingId,
      staleBefore,
      leaseAt,
      staleBefore,
      MAX_VOICE_JOB_ATTEMPTS,
    )
    .run();

  requireCare(result.meta.changes === 1, 409, "This recording is already being interpreted. Try again shortly.");
  const acquired = await db
    .prepare("SELECT updated_at FROM care_voice_jobs WHERE recording_id = ? AND owner_id = ? AND state = 'processing'")
    .bind(recordingId, ownerId)
    .first<{ updated_at: number }>();
  requireCare(acquired, 409, "This recording could not be locked for interpretation.");
  return acquired.updated_at;
}

/** Save the proposal state and ready result only while this invocation owns the lease. */
export async function finishVoiceJob(
  db: D1Database,
  context: CareContext,
  ownerId: string,
  recordingId: string,
  leaseAt: number,
  result: unknown,
): Promise<void> {
  const stateJson = JSON.stringify(context.state);
  const resultJson = JSON.stringify(result);
  requireCare(stateJson.length <= MAX_CARE_STATE_JSON, 413, "This care space is full.");
  requireCare(resultJson.length <= 32_000, 413, "The voice interpretation result is too large.");

  // D1 batch runs transactionally. The job transition is fenced by the lease
  // and workspace version; the state write is conditional on that exact ready
  // result, so a stale invocation cannot commit after a lease has been taken.
  const statements = [
    db
      .prepare(
        `UPDATE care_voice_jobs SET state = 'ready', result_json = ?
         WHERE recording_id = ? AND owner_id = ? AND state = 'processing' AND updated_at = ?
           AND EXISTS (SELECT 1 FROM care_workspaces WHERE owner_id = ? AND version = ?)`,
      )
      .bind(resultJson, recordingId, ownerId, leaseAt, ownerId, context.workspace.version),
    db
      .prepare(
        `UPDATE care_workspaces SET state_json = ?, version = version + 1, updated_at = ?
         WHERE owner_id = ? AND version = ?
           AND EXISTS (
             SELECT 1 FROM care_voice_jobs
             WHERE recording_id = ? AND owner_id = ? AND state = 'ready'
               AND updated_at = ? AND result_json = ?
           )`,
      )
      .bind(stateJson, Date.now(), ownerId, context.workspace.version, recordingId, ownerId, leaseAt, resultJson),
  ];
  const outcomes = await db.batch(statements);
  requireCare(
    outcomes[0]?.meta.changes === 1 && outcomes[1]?.meta.changes === 1,
    409,
    "The care space changed while the recording was being interpreted. Refresh and review again.",
  );
  context.workspace.version++;
  context.workspace.state_json = stateJson;
}

/** A late error may release only the lease held by that same invocation. */
export async function failVoiceJob(
  db: D1Database,
  ownerId: string,
  recordingId: string,
  leaseAt: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE care_voice_jobs SET state = 'failed', updated_at = MAX(updated_at, ?) WHERE recording_id = ? AND owner_id = ? AND state = 'processing' AND updated_at = ?",
    )
    .bind(Date.now(), recordingId, ownerId, leaseAt)
    .run();
}
