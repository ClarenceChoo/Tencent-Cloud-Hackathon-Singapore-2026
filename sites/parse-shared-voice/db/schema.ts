import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const voiceRooms = sqliteTable("voice_rooms", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  invitationHash: text("invitation_hash").notNull(), phoneHash: text("phone_hash"), deviceHash: text("device_hash"),
  approvalCode: text("approval_code"), state: text("state").notNull(),
  clientType: text("client_type").notNull().default("phone"),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [index("idx_voice_rooms_owner_created").on(table.ownerId, table.createdAt), uniqueIndex("idx_voice_rooms_device_hash").on(table.deviceHash)]);

export const voiceRecordings = sqliteTable("voice_recordings", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull().references(() => voiceRooms.id),
  ownerId: text("owner_id").notNull(), state: text("state").notNull(),
  clientType: text("client_type").notNull().default("phone"),
  nextSequence: integer("next_sequence").notNull().default(0), frames: integer("frames").notNull().default(0),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
  audioKey: text("audio_key"), replyAudioKey: text("reply_audio_key"), transcript: text("transcript"), errorCode: text("error_code"),
}, table => [index("idx_voice_recordings_owner_created").on(table.ownerId, table.createdAt)]);

export const voiceChunks = sqliteTable("voice_chunks", {
  recordingId: text("recording_id").notNull().references(() => voiceRecordings.id),
  sequence: integer("sequence").notNull(), objectKey: text("object_key").notNull(),
  digest: text("digest").notNull(), frames: integer("frames").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [primaryKey({columns:[table.recordingId, table.sequence]})]);

export const careWorkspaces = sqliteTable("care_workspaces", {
  ownerId:text("owner_id").primaryKey(), ownerEmail:text("owner_email").notNull(),
  patientId:text("patient_id").notNull().unique(), version:integer("version").notNull().default(1),
  stateJson:text("state_json").notNull(), updatedAt:integer("updated_at").notNull(),
});

export const careGrants = sqliteTable("care_grants", {
  id:text("id").primaryKey(), ownerId:text("owner_id").notNull().references(()=>careWorkspaces.ownerId),
  userEmail:text("user_email").notNull(), scopesJson:text("scopes_json").notNull(),
  createdAt:integer("created_at").notNull(), revokedAt:integer("revoked_at"),
},table=>[index("idx_care_grants_email").on(table.userEmail)]);

export const careSummaryLinks = sqliteTable("care_summary_links", {
  tokenHash:text("token_hash").primaryKey(), ownerId:text("owner_id").notNull().references(()=>careWorkspaces.ownerId),
  summaryId:text("summary_id").notNull(), expiresAt:integer("expires_at").notNull(), revokedAt:integer("revoked_at"),
});

export const careVoiceJobs = sqliteTable("care_voice_jobs", {
  recordingId:text("recording_id").primaryKey().references(()=>voiceRecordings.id),
  ownerId:text("owner_id").notNull(), state:text("state").notNull(),
  resultJson:text("result_json"), updatedAt:integer("updated_at").notNull(),
});

export const voiceTtsJobs = sqliteTable("voice_tts_jobs", {
  recordingId:text("recording_id").primaryKey().references(()=>voiceRecordings.id),
  ownerId:text("owner_id").notNull(), state:text("state").notNull(), errorCode:text("error_code"),
  updatedAt:integer("updated_at").notNull(),
});

export const voiceRelayStatus = sqliteTable("voice_relay_status", {
  roomId:text("room_id").primaryKey().references(()=>voiceRooms.id),
  lastSeen:integer("last_seen").notNull(), statusJson:text("status_json").notNull(),
});
export const voiceRelayCommands = sqliteTable("voice_relay_commands", {
  id:text("id").primaryKey(), roomId:text("room_id").notNull().references(()=>voiceRooms.id),
  kind:text("kind").notNull(), state:text("state").notNull(), claimId:text("claim_id"),
  createdAt:integer("created_at").notNull(), expiresAt:integer("expires_at").notNull(), updatedAt:integer("updated_at").notNull(),
},table=>[index("idx_voice_relay_commands_room").on(table.roomId,table.createdAt)]);
