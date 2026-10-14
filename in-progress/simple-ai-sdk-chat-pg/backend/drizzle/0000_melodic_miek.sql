CREATE TABLE "messages" (
	"id" text NOT NULL,
	"thread_id" text NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"metadata" jsonb,
	"parts" jsonb NOT NULL,
	CONSTRAINT "messages_thread_id_id_pk" PRIMARY KEY("thread_id","id"),
	CONSTRAINT "messages_thread_id_position_unique" UNIQUE("thread_id","position")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "threads_user_id_created_at_id_index" ON "threads" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;
