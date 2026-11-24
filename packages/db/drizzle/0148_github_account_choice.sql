CREATE TABLE "project_user_settings" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"github_account_id" uuid,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "project_user_settings_pk" PRIMARY KEY("organization_id","user_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "task_user_settings" ADD COLUMN "github_account_id" uuid;--> statement-breakpoint
ALTER TABLE "task_user_settings" ADD COLUMN "github_use_host_login" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_user_settings" ADD CONSTRAINT "project_user_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_settings" ADD CONSTRAINT "project_user_settings_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_user_settings" ADD CONSTRAINT "project_user_settings_github_account_id_github_accounts_id_fk" FOREIGN KEY ("github_account_id") REFERENCES "public"."github_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_user_settings" ADD CONSTRAINT "task_user_settings_github_account_id_github_accounts_id_fk" FOREIGN KEY ("github_account_id") REFERENCES "public"."github_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_user_settings" ADD CONSTRAINT "task_user_settings_github_choice_check" CHECK ("task_user_settings"."github_account_id" IS NULL OR NOT "task_user_settings"."github_use_host_login");