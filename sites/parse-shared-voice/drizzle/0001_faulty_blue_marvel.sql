CREATE TABLE `care_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`user_email` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `care_workspaces`(`owner_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_care_grants_email` ON `care_grants` (`user_email`);--> statement-breakpoint
CREATE TABLE `care_summary_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`summary_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `care_workspaces`(`owner_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `care_voice_jobs` (
	`recording_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`result_json` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `voice_recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `care_workspaces` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`patient_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `care_workspaces_patient_id_unique` ON `care_workspaces` (`patient_id`);