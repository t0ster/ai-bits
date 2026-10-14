import type { UIMessage } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/config";
import { type db, query } from "@/db/connection";
import { messages, type StoredMessage } from "@/db/schema";
import type { ChatResultAsync } from "@/errors";

/** Maps a stored message row to its UI representation. */
export function toUIMessage(row: StoredMessage): UIMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.parts,
    metadata: {
      ...(row.metadata ?? {}),
      status: row.status,
    },
  };
}

/** Removes durable status metadata before storing generated content. */
export function toStoredMessageContent(
  message: Pick<UIMessage, "parts" | "metadata">,
) {
  const { status: _status, ...metadata } = z
    .looseObject({
      status: z.unknown().optional(),
    })
    .parse(message.metadata ?? {});
  return {
    parts: message.parts,
    metadata: Object.keys(metadata).length === 0 ? null : metadata,
  };
}

type MessageDatabase = Pick<typeof db, "update">;

/** Marks abandoned pending messages as failed. */
export function failStalePendingMessages(
  database: MessageDatabase,
  threadId?: string,
): ChatResultAsync<Array<{ id: string }>> {
  const staleHeartbeat = sql`(
    ${messages.heartbeatAt} IS NULL OR
    ${messages.heartbeatAt} < NOW() - (${config.turnStaleAfterMs} * INTERVAL '1 millisecond')
  )`;
  return query(() =>
    database
      .update(messages)
      .set({ status: "failed", heartbeatAt: null })
      .where(
        and(
          eq(messages.status, "pending"),
          staleHeartbeat,
          threadId === undefined ? undefined : eq(messages.threadId, threadId),
        ),
      )
      .returning({ id: messages.id }),
  );
}
