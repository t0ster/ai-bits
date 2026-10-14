import { timingSafeEqual } from "node:crypto";
import type { ThreadListItemResponse } from "@app/shared";
import { chatErrorBody, chatErrorKeySchema } from "@app/shared/i18n";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { safeValidateUIMessages, type UIMessage } from "ai";
import {
  getValidatedRouterParams,
  H3,
  type H3Event,
  readValidatedBody,
} from "h3";
import { z } from "zod";
import { config } from "@/config";
import {
  createChatHttpError,
  throwHttpChatError,
} from "@/lib/http/chat-http-errors";
import { createChatStreamResponse } from "@/lib/http/chat-stream";
import { chatRepository } from "@/persistence/chat";
import {
  chatMessageToolPartSchemas,
  createThreadBodySchema,
  sendMessageSchema,
  threadIdSchema,
  userIdSchema,
} from "@/schemas";
import { executeTurn } from "@/services/execute-turn";
import { getThreadDetail } from "@/services/thread-detail";

function requireUserId(event: H3Event): string {
  const parsed = userIdSchema.safeParse(event.req.headers.get("X-User-Id"));
  if (!parsed.success) {
    throw createChatHttpError("chat.error.user_id_required", 400);
  }
  return parsed.data;
}

export const api = new H3({
  // The HTTP span owns error reporting; suppress H3's duplicate raw exception logs.
  silent: true,
  onRequest(event) {
    if (event.req.url.endsWith("/health") && event.req.method === "GET") {
      return;
    }
    const supplied = event.req.headers.get("Authorization");
    const expected = `Bearer ${config.backendApiKey}`;
    const suppliedBytes = Buffer.from(supplied ?? "");
    const expectedBytes = Buffer.from(expected);
    if (
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      throw createChatHttpError("chat.error.unauthorized", 401);
    }
  },
  onError(error) {
    const parsedKey = chatErrorKeySchema.safeParse(error.message);
    if (error.unhandled || error.status >= 500) {
      const span = trace.getActiveSpan();
      // Report once at the HTTP boundary, without serializing arbitrary causes.
      span?.recordException({
        name: "HTTPError",
        message: parsedKey.success
          ? parsedKey.data
          : "Chat backend request failed.",
      });
      span?.setStatus({ code: SpanStatusCode.ERROR });
    }
    if (!error.unhandled) {
      const fallbackKey =
        error.status === 404
          ? "chat.error.not_found"
          : error.status < 500
            ? "chat.error.invalid_request"
            : "chat.error.request_failed";
      return Response.json(
        chatErrorBody(parsedKey.success ? parsedKey.data : fallbackKey),
        { status: error.status },
      );
    }
    return Response.json(chatErrorBody("chat.error.request_failed"), {
      status: 500,
    });
  },
});

async function parseChatMessages(messages: unknown): Promise<UIMessage[]> {
  const parsed = await safeValidateUIMessages({
    messages,
    tools: chatMessageToolPartSchemas,
  });
  if (!parsed.success) {
    throw createChatHttpError("chat.error.invalid_message_history", 400);
  }
  return parsed.data;
}

api.get("/health", () => ({ status: "ok" }));

api.post("/threads", async (event) => {
  const userId = requireUserId(event);
  const { id: threadId, messages } = await readValidatedBody(
    event,
    createThreadBodySchema,
  );
  const validatedMessages = await parseChatMessages(messages);
  const result = await executeTurn({ userId, threadId }).createAndSend(
    validatedMessages,
    (run) => createChatStreamResponse(event, run),
  );
  if (result.isErr()) throwHttpChatError(result.error);
  return result.value;
});

api.get("/threads", async (event) => {
  const ownedThreads = await chatRepository.listThreads(requireUserId(event));
  if (ownedThreads.isErr()) throwHttpChatError(ownedThreads.error);
  return ownedThreads.value.map(
    (thread): ThreadListItemResponse => ({
      id: thread.id,
      user_id: thread.userId,
      created_at: thread.createdAt.toISOString(),
    }),
  );
});

api.get("/threads/:id", async (event) => {
  const { id: threadId } = await getValidatedRouterParams(
    event,
    z.object({ id: threadIdSchema }),
  );
  const result = await getThreadDetail(requireUserId(event), threadId);
  if (result.isErr()) {
    if (result.error.kind === "invalid_thread_messages") {
      throw createChatHttpError("chat.error.stored_messages_invalid", 500);
    }
    throwHttpChatError(result.error);
  }
  return result.value;
});

api.post("/threads/:id/send", async (event) => {
  const userId = requireUserId(event);
  const body = await readValidatedBody(event, sendMessageSchema);
  const [message] = await parseChatMessages([body.message]);
  if (!message)
    throw createChatHttpError("chat.error.user_message_required", 400);
  const { id: threadId } = await getValidatedRouterParams(
    event,
    z.object({ id: threadIdSchema }),
  );
  const result = await executeTurn({ userId, threadId }).send(message, (run) =>
    createChatStreamResponse(event, run),
  );
  if (result.isErr()) throwHttpChatError(result.error);
  return result.value;
});

api.post("/threads/:id/retry", async (event) => {
  const userId = requireUserId(event);
  const { id: threadId } = await getValidatedRouterParams(
    event,
    z.object({ id: threadIdSchema }),
  );
  const result = await executeTurn({ userId, threadId }).retry((run) =>
    createChatStreamResponse(event, run),
  );
  if (result.isErr()) throwHttpChatError(result.error);
  return result.value;
});
