ALTER TABLE `voice_recordings` ADD `client_type` text DEFAULT 'phone' NOT NULL;--> statement-breakpoint
ALTER TABLE `voice_rooms` ADD `client_type` text DEFAULT 'phone' NOT NULL;