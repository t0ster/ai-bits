import type { UIMessage } from "ai";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { MessageId, MessageStatus } from "@/schemas";

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("threads_user_id_created_at_id_index").on(
      table.userId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").$type<MessageId>().notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    role: text("role").$type<UIMessage["role"]>().notNull(),
    status: text("status")
      .$type<MessageStatus>()
      .notNull()
      .default("completed"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    parts: jsonb("parts").$type<UIMessage["parts"]>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.id] }),
    unique().on(table.threadId, table.position),
  ],
);

export type Thread = typeof threads.$inferSelect;
export type StoredMessage = typeof messages.$inferSelect;
