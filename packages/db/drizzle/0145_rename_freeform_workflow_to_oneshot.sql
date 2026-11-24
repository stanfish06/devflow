UPDATE "tasks" SET "workflow_type" = 'oneshot' WHERE "workflow_type" = 'freeform';--> statement-breakpoint
UPDATE "sessions" SET "workflow_type" = 'oneshot' WHERE "workflow_type" = 'freeform';
