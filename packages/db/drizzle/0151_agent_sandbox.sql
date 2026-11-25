ALTER TABLE "online_hosts" ADD COLUMN "sandbox_vms" jsonb;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "sandbox" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sandbox" text;