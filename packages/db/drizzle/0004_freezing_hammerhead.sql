CREATE TABLE "transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text DEFAULT 'rendering' NOT NULL,
	"error" text,
	"clip_key" text,
	"clip" jsonb,
	"metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fallback_tracks" ADD COLUMN "features" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "features" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "transitions_pair_idx" ON "transitions" USING btree ("from_id","to_id","plan_hash");