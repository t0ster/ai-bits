import type { UIMessage } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { err, ok } from "neverthrow";
import { db, query, transaction } from "@/db/connection";
import { messages, type Thread, threads } from "@/db/schema";
import { type ChatResultAsync, chatError, type ThreadNotFound } from "@/errors";
import { failStalePendingMessages, toUIMessage } from "./helpers";

/** CRUD operations for durable chat threads. */
export const chatRepository = {
  listThreads(userId: string): ChatResultAsync<Thread[]> {
    return query(() =>
      db
        .select()
        .from(threads)
        .where(eq(threads.userId, userId))
        .orderBy(desc(threads.createdAt), desc(threads.id)),
    );
  },

  loadThread(
    userId: string,
    threadId: string,
  ): ChatResultAsync<
    { thread: Thread; messages: UIMessage[] },
    ThreadNotFound
  > {
    return transaction(async (transaction) => {
      const threadResult = await query(() =>
        transaction
          .select()
          .from(threads)
          .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
          .limit(1),
      );
      if (threadResult.isErr()) return err(threadResult.error);
      const [thread] = threadResult.value;
      if (!thread) return err(chatError.threadNotFound());

      const staleResult = await failStalePendingMessages(
        transaction,
        thread.id,
      );
      if (staleResult.isErr()) return err(staleResult.error);
      const messagesResult = await query(() =>
        transaction
          .select()
          .from(messages)
          .where(eq(messages.threadId, thread.id))
          .orderBy(messages.position),
      );
      if (messagesResult.isErr()) return err(messagesResult.error);
      return ok({
        thread,
        messages: messagesResult.value.map(toUIMessage),
      });
    });
  },

  failStalePendingMessages: () => failStalePendingMessages(db),
};
