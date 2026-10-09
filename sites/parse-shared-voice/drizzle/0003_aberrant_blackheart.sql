CREATE TABLE `voice_relay_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`claim_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `voice_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_voice_relay_commands_room` ON `voice_relay_commands` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `voice_relay_status` (
	`room_id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`status_json` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `voice_rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `voice_recordings` ADD `reply_audio_key` text;