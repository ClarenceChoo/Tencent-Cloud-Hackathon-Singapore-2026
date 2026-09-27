export type Installation = {
  version: 1;
  service: string;
  credential: string;
  enrollmentKey: string;
  platform: "ios" | "android";
  displayName: string;
};
export type Enrollment = {
  status: "awaiting_approval" | "paired";
  device_id: string;
  code?: string;
  expires_at?: string;
  patient?: { id: string; name: string };
};
export type Proposal = {
  id: string;
  context_id: string;
  kind: string;
  readback: string;
  status: string;
  payload: Record<string, unknown>;
  expires_at: string;
};
export type CareRow = { id: string; [key: string]: unknown };
export type Home = {
  device_id: string;
  patient: {
    id: string;
    name: string;
    preferred_name: string | null;
    timezone: string;
    calling_route: string | null;
  };
  active_companion: { device_id: string | null; generation: number };
  voice: { voice_service: string; scheduler_enabled: boolean };
  current_proposal: Proposal | null;
  medication_plan: { medicines: CareRow[]; version: number } | null;
  doses: CareRow[];
  notes: CareRow[];
  measurements: CareRow[];
  preventive_tasks: CareRow[];
  support_requests: CareRow[];
  followups: CareRow[];
  permitted_recipients: CareRow[];
};
export type Receipt = { turn_id: string; status: string; received_at: string };
export type TurnEvent = {
  expires_at: string;
  payload: {
    status: string;
    spoken_text?: string;
    context_id?: string;
    audio_paths?: string[];
    record_id?: string;
  };
};
export type TurnStatus = Receipt & {
  error: string | null;
  event: TurnEvent | null;
};
export type PendingTurn = {
  key: string;
  context: string | null;
  turnId?: string;
  createdAt: number;
};
