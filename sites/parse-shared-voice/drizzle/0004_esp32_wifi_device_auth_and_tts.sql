CREATE TABLE `voice_tts_jobs` (
	`recording_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`error_code` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `voice_recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `voice_rooms` ADD `device_hash` text;
