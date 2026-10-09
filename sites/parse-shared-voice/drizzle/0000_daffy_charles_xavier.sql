CREATE TABLE `voice_chunks` (
	`recording_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`object_key` text NOT NULL,
	`digest` text NOT NULL,
	`frames` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`recording_id`, `sequence`),
	FOREIGN KEY (`recording_id`) REFERENCES `voice_recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `voice_recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`next_sequence` integer DEFAULT 0 NOT NULL,
	`frames` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`audio_key` text,
	`transcript` text,
	`error_code` text,
	FOREIGN KEY (`room_id`) REFERENCES `voice_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_voice_recordings_owner_created` ON `voice_recordings` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `voice_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`invitation_hash` text NOT NULL,
	`phone_hash` text,
	`approval_code` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_voice_rooms_owner_created` ON `voice_rooms` (`owner_id`,`created_at`);