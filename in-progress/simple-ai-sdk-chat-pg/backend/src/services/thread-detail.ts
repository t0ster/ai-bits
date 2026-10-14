import {
  type ChatMessage,
  messageStatusSchema,
  type ThreadDetailResponse,
} from "@app/shared";
import { safeValidateUIMessages } from "ai";
import { err, ok } from "neverthrow";
import { z } from "zod";
import type { ChatResult, ThreadNotFound } from "@/errors";
import { chatRepository } from "@/persistence/chat";
import { chatMessageToolPartSchemas } from "@/schemas";

/** Stored thread messages cannot be represented by the chat protocol. */
export type InvalidThreadMessages = { kind: "invalid_thread_messages" };

/** Loads an owned thread, reconciling stale turns and validating stored messages. */
export async function getThreadDetail(
  userId: string,
  threadId: string,
): Promise<
  ChatResult<ThreadDetailResponse, ThreadNotFound | InvalidThreadMessages>
> {
  const result = await chatRepository.loadThread(userId, threadId);
  if (result.isErr()) return err(result.error);
  const messages = await safeValidateUIMessages<ChatMessage>({
    messages: result.value.messages,
    metadataSchema: z.looseObject({ status: messageStatusSchema }),
    tools: chatMessageToolPartSchemas,
  });
  if (!messages.success) return err({ kind: "invalid_thread_messages" });
  return ok({
    id: result.value.thread.id,
    user_id: result.value.thread.userId,
    created_at: result.value.thread.createdAt.toISOString(),
    messages: messages.data,
  });
}
