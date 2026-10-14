import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import { db, query, transaction } from "@/db/connection";
import { messages, threads } from "@/db/schema";
import {
  type ChatResultAsync,
  chatError,
  type FailedTurnRequiresRetry,
  type GenerationInProgress,
  type MessageIdConflict,
  type RetryNotAllowed,
  type ThreadIdUnavailable,
  type ThreadNotFound,
  type TurnNoLongerPending,
} from "@/errors";
import {
  type MessageId,
  type MessageStatus,
  messageIdSchema,
  type TurnGenerationInput,
} from "@/schemas";
import {
  failStalePendingMessages,
  toStoredMessageContent,
  toUIMessage,
} from "./helpers";

/** Represents a claimed turn and its pending persistence operations. */
export type BoundTurn = TurnGenerationInput & {
  readonly threadId: string;
  readonly userId: string;
  complete: (
    message: Pick<UIMessage, "parts" | "metadata">,
  ) => ChatResultAsync<void, TurnNoLongerPending>;
  fail: () => ChatResultAsync<void, TurnNoLongerPending>;
  heartbeat: () => ChatResultAsync<boolean>;
};

/** A durable message supplied to application-level turn policy. */
export type DurableTurnMessage = Readonly<{
  id: MessageId;
  position: number;
  role: UIMessage["role"];
  status: MessageStatus;
  message: UIMessage;
}>;

/** The durable state needed to decide whether a new turn may begin. */
export type BeginTurnState = Readonly<{
  messages: ReadonlyArray<DurableTurnMessage>;
}>;

/** The generation context selected by new-turn policy. */
export type BeginTurnDecision = Readonly<{
  priorMessages: ReadonlyArray<UIMessage>;
}>;

/** Decides whether persisted state permits a new turn. */
export type DecideBeginTurn = (
  state: BeginTurnState,
) => Result<BeginTurnDecision, GenerationInProgress | FailedTurnRequiresRetry>;

/** The durable state needed to decide whether a response may be retried. */
export type RetryTurnState = Readonly<{
  messages: ReadonlyArray<DurableTurnMessage>;
}>;

/** The assistant response and generation context selected by retry policy. */
export type RetryTurnDecision = Readonly<{
  assistantMessageId: MessageId;
  generationMessages: ReadonlyArray<UIMessage>;
}>;

/** Decides whether persisted state permits retrying an assistant response. */
export type DecideRetryTurn = (
  state: RetryTurnState,
) => Result<RetryTurnDecision, RetryNotAllowed>;

/** Binds persistent turn lifecycle operations to one chat thread. */
export function turns(threadId: string) {
  function toDurableTurnMessages(
    rows: ReadonlyArray<typeof messages.$inferSelect>,
  ): ReadonlyArray<DurableTurnMessage> {
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      role: row.role,
      status: row.status,
      message: toUIMessage(row),
    }));
  }

  function begin(input: {
    userId: string;
    message: UIMessage;
    decideBeginTurn: DecideBeginTurn;
  }): ChatResultAsync<
    BoundTurn,
    | ThreadNotFound
    | MessageIdConflict
    | GenerationInProgress
    | FailedTurnRequiresRetry
  > {
    const assistantMessageId = messageIdSchema.parse(randomUUID());
    const userMessage = input.message;
    return transaction(
      async (tx) => {
        const ownedThreadResult = await query(() =>
          tx
            .select({ id: threads.id })
            .from(threads)
            .where(
              and(eq(threads.id, threadId), eq(threads.userId, input.userId)),
            )
            .for("update"),
        );
        if (ownedThreadResult.isErr()) return err(ownedThreadResult.error);
        const [ownedThread] = ownedThreadResult.value;
        if (!ownedThread) return err(chatError.threadNotFound());

        const rowsResult = await query(() =>
          tx
            .select()
            .from(messages)
            .where(eq(messages.threadId, threadId))
            .orderBy(messages.position),
        );
        if (rowsResult.isErr()) return err(rowsResult.error);
        const rows = rowsResult.value;
        const existingMessage = rows.find((row) => row.id === input.message.id);
        if (existingMessage) return err(chatError.messageIdConflict());

        const decision = input.decideBeginTurn({
          messages: toDurableTurnMessages(rows),
        });
        if (decision.isErr()) return err(decision.error);

        const nextPosition = (rows.at(-1)?.position ?? -1) + 1;
        const messagesResult = await query(() =>
          tx.insert(messages).values([
            {
              id: messageIdSchema.parse(input.message.id),
              threadId,
              position: nextPosition,
              role: userMessage.role,
              status: "completed",
              ...toStoredMessageContent(userMessage),
            },
            {
              id: assistantMessageId,
              threadId,
              position: nextPosition + 1,
              role: "assistant",
              status: "pending",
              heartbeatAt: sql`NOW()`,
              parts: [],
            },
          ]),
        );
        if (messagesResult.isErr()) return err(messagesResult.error);
        return ok(
          bindTurn(input.userId, {
            messages: [...decision.value.priorMessages, userMessage],
            assistantMessageId,
          }),
        );
      },
      { isolationLevel: "read committed" },
    );
  }

  function create(input: {
    userId: string;
    messages: UIMessage[];
  }): ChatResultAsync<BoundTurn, ThreadIdUnavailable> {
    const assistantMessageId = messageIdSchema.parse(randomUUID());
    return transaction(
      async (tx) => {
        const insertedThread = await query(() =>
          tx
            .insert(threads)
            .values({ id: threadId, userId: input.userId })
            .onConflictDoNothing({ target: threads.id })
            .returning({ id: threads.id }),
        );
        if (insertedThread.isErr()) return err(insertedThread.error);
        if (insertedThread.value.length === 0)
          return err(chatError.threadIdUnavailable());
        const persisted = await query(() =>
          tx.insert(messages).values([
            ...input.messages.map((message, position) => ({
              id: messageIdSchema.parse(message.id),
              threadId,
              position,
              role: message.role,
              status: "completed" as const,
              ...toStoredMessageContent(message),
            })),
            {
              id: assistantMessageId,
              threadId,
              position: input.messages.length,
              role: "assistant" as const,
              status: "pending" as const,
              heartbeatAt: sql`NOW()`,
              parts: [],
            },
          ]),
        );
        if (persisted.isErr()) return err(persisted.error);
        return ok(
          bindTurn(input.userId, {
            messages: input.messages,
            assistantMessageId,
          }),
        );
      },
      { isolationLevel: "read committed" },
    );
  }

  function retry(input: {
    userId: string;
    decideRetryTurn: DecideRetryTurn;
  }): ChatResultAsync<
    BoundTurn,
    ThreadNotFound | RetryNotAllowed | TurnNoLongerPending
  > {
    return transaction(
      async (tx) => {
        const threadResult = await query(() =>
          tx
            .select()
            .from(threads)
            .where(
              and(eq(threads.id, threadId), eq(threads.userId, input.userId)),
            )
            .for("update"),
        );
        if (threadResult.isErr()) return err(threadResult.error);
        const [thread] = threadResult.value;
        if (!thread) return err(chatError.threadNotFound());

        const staleResult = await failStalePendingMessages(tx, threadId);
        if (staleResult.isErr()) return err(staleResult.error);
        const rowsResult = await query(() =>
          tx
            .select()
            .from(messages)
            .where(eq(messages.threadId, threadId))
            .orderBy(messages.position),
        );
        if (rowsResult.isErr()) return err(rowsResult.error);

        const decision = input.decideRetryTurn({
          messages: toDurableTurnMessages(rowsResult.value),
        });
        if (decision.isErr()) return err(decision.error);
        const { assistantMessageId } = decision.value;
        const updateResult = await query(() =>
          tx
            .update(messages)
            .set({ status: "pending", heartbeatAt: sql`NOW()` })
            .where(
              and(
                eq(messages.threadId, threadId),
                eq(messages.id, assistantMessageId),
                eq(messages.status, "failed"),
              ),
            )
            .returning({ id: messages.id }),
        );
        if (updateResult.isErr()) return err(updateResult.error);
        if (!updateResult.value[0]) {
          return err(chatError.turnNoLongerPending());
        }
        return ok(
          bindTurn(input.userId, {
            assistantMessageId,
            messages: [...decision.value.generationMessages],
          }),
        );
      },
      { isolationLevel: "read committed" },
    );
  }

  function bindTurn(userId: string, turn: TurnGenerationInput): BoundTurn {
    return {
      ...turn,
      threadId,
      userId,
      complete: (message) => complete(turn.assistantMessageId, message),
      fail: () => fail(turn.assistantMessageId),
      heartbeat: () => heartbeat(turn.assistantMessageId),
    };
  }

  function complete(
    assistantMessageId: MessageId,
    message: Pick<UIMessage, "parts" | "metadata">,
  ): ChatResultAsync<void, TurnNoLongerPending> {
    return query(() =>
      db
        .update(messages)
        .set({
          status: "completed",
          heartbeatAt: null,
          ...toStoredMessageContent(message),
        })
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.id, assistantMessageId),
            eq(messages.status, "pending"),
          ),
        )
        .returning({ id: messages.id }),
    ).andThen(([updated]) =>
      updated ? ok() : err(chatError.turnNoLongerPending()),
    );
  }

  function fail(
    assistantMessageId: MessageId,
  ): ChatResultAsync<void, TurnNoLongerPending> {
    return query(() =>
      db
        .update(messages)
        .set({ status: "failed", heartbeatAt: null })
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.id, assistantMessageId),
            eq(messages.status, "pending"),
          ),
        )
        .returning({ id: messages.id }),
    ).andThen(([updated]) =>
      updated ? ok() : err(chatError.turnNoLongerPending()),
    );
  }

  function heartbeat(assistantMessageId: MessageId): ChatResultAsync<boolean> {
    return query(() =>
      db
        .update(messages)
        .set({ heartbeatAt: sql`NOW()` })
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.id, assistantMessageId),
            eq(messages.status, "pending"),
          ),
        )
        .returning({ id: messages.id }),
    ).map(([updated]) => updated !== undefined);
  }

  return { begin, create, retry };
}
