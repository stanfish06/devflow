CREATE TABLE "github_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"noreply_email" text NOT NULL,
	"token_iv" "bytea" NOT NULL,
	"token_ciphertext" "bytea" NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "github_accounts_status_check" CHECK ("github_accounts"."status" IN ('ok', 'needs_token'))
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "default_github_account_id" uuid;--> statement-breakpoint
ALTER TABLE "github_accounts" ADD CONSTRAINT "github_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_accounts_org_user_github_user_idx" ON "github_accounts" USING btree ("organization_id","user_id","github_user_id");--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_default_github_account_id_github_accounts_id_fk" FOREIGN KEY ("default_github_account_id") REFERENCES "public"."github_accounts"("id") ON DELETE set null ON UPDATE no action;