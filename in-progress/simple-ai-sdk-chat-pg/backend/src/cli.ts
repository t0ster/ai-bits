import {
  createAppI18n,
  parseChatErrorKey,
  readChatErrorKey,
} from "@app/shared/i18n";
import {
  convertToModelMessages,
  safeValidateUIMessages,
  type UIMessageChunk,
} from "ai";
import { defineCommand, runMain } from "citty";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { z } from "zod";
import { closeChatDatabase } from "@/db/connection";
import type { ChatError, ChatResult } from "@/errors";
import { chatSystemPrompt } from "@/lib/generation/chat-system-prompt";
import {
  chatMessageToolPartSchemas,
  createThreadBodySchema,
  sendMessageSchema,
  threadIdSchema,
  userIdSchema,
} from "@/schemas";
import { executeTurn } from "@/services/execute-turn";
import { getThreadDetail } from "@/services/thread-detail";

const i18n = createAppI18n("en");

let cliUserId: string | undefined;

const userArgs = {
  "user-id": { type: "string", description: "Thread owner (required)" },
} as const;
const threadArgs = {
  ...userArgs,
  threadId: { type: "positional", required: true, description: "Thread ID" },
} as const;
const bodyArg = {
  type: "positional",
  required: true,
  description: "JSON request body",
} as const;

const chatCli = defineCommand({
  meta: { name: "chat", description: "Chat backend commands" },
  args: userArgs,
  setup({ args }) {
    cliUserId = args["user-id"];
  },
  subCommands: {
    thread: defineCommand({
      meta: { name: "thread", description: "Create or inspect threads" },
      args: userArgs,
      subCommands: {
        create: defineCommand({
          meta: {
            name: "create",
            description: "Create and stream the first response",
          },
          args: { ...userArgs, body: bodyArg },
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const body = createThreadBodySchema.parse(JSON.parse(args.body));
            await printChatStream(
              await requestChat(userId, "/threads", "POST", body),
            );
          },
        }),
        "create-raw": defineCommand({
          meta: {
            name: "create-raw",
            description: "Create and export model messages",
          },
          args: { ...userArgs, body: bodyArg },
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const body = createThreadBodySchema.parse(JSON.parse(args.body));
            const messages = await validateChatMessages(body.messages);
            await completeRawTurn((start) =>
              executeTurn({ userId, threadId: body.id }).createAndSend(
                messages,
                start,
              ),
            );
            await printRawThread(userId, body.id);
          },
        }),
        show: defineCommand({
          meta: { name: "show", description: "Show stored thread messages" },
          args: { ...threadArgs },
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const threadId = threadIdSchema.parse(args.threadId);
            const response = await requestChat(
              userId,
              `/threads/${threadId}`,
              "GET",
            );
            await printChatCliValue(await response.json());
          },
        }),
        "show-raw": defineCommand({
          meta: {
            name: "show-raw",
            description: "Export the full model context",
          },
          args: { ...threadArgs },
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const threadId = threadIdSchema.parse(args.threadId);
            await printRawThread(userId, threadId);
          },
        }),
        send: defineCommand({
          meta: {
            name: "send",
            description: "Send a message and stream its response",
          },
          args: { ...threadArgs, body: bodyArg },
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const threadId = threadIdSchema.parse(args.threadId);
            const body = sendMessageSchema.parse(JSON.parse(args.body));
            await printChatStream(
              await requestChat(
                userId,
                `/threads/${threadId}/send`,
                "POST",
                body,
              ),
            );
          },
        }),
        "send-raw": defineCommand({
          meta: {
            name: "send-raw",
            description: "Send and export the updated model context",
          },
          args: { ...threadArgs, body: bodyArg },
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const threadId = threadIdSchema.parse(args.threadId);
            const body = sendMessageSchema.parse(JSON.parse(args.body));
            const [message] = await validateChatMessages([body.message]);
            if (!message)
              throw new Error(i18n.t("chat.error.user_message_required"));
            await completeRawTurn((start) =>
              executeTurn({ userId, threadId }).send(message, start),
            );
            await printRawThread(userId, threadId);
          },
        }),
        retry: defineCommand({
          meta: {
            name: "retry",
            description: "Retry the latest failed response",
          },
          args: threadArgs,
          async run({ args }) {
            const userId = userIdSchema.parse(args["user-id"] ?? cliUserId);
            const threadId = threadIdSchema.parse(args.threadId);
            await printChatStream(
              await requestChat(userId, `/threads/${threadId}/retry`, "POST"),
            );
          },
        }),
      },
    }),
  },
});

async function validateChatMessages(messages: unknown) {
  const validated = await safeValidateUIMessages({
    messages,
    tools: chatMessageToolPartSchemas,
  });
  if (!validated.success)
    throw new Error(i18n.t("chat.error.invalid_message_history"));
  return validated.data;
}

type StartRawStream = (
  run: (stream: { publish: (event: UIMessageChunk) => void }) => Promise<void>,
) => Promise<void>;

async function completeRawTurn(
  invoke: (
    start: StartRawStream,
  ) => Promise<ChatResult<Promise<void>, ChatError>>,
): Promise<void> {
  let finished = false;
  let streamError: string | undefined;
  const sent = await invoke((run) =>
    run({
      publish(event) {
        if (event.type === "finish") finished = true;
        if (event.type === "error")
          streamError = i18n.t(parseChatErrorKey(event.errorText));
      },
    }),
  );
  if (sent.isErr()) {
    const key =
      sent.error.kind === "any_error"
        ? "chat.error.operation_failed"
        : parseChatErrorKey(`chat.error.${sent.error.kind}`);
    throw new Error(i18n.t(key));
  }
  await sent.value;
  if (streamError) throw new Error(streamError);
  if (!finished) throw new Error(i18n.t("chat.error.response_failed"));
}

async function printRawThread(userId: string, threadId: string): Promise<void> {
  const result = await getThreadDetail(userId, threadId);
  if (result.isErr()) {
    const key =
      result.error.kind === "thread_not_found"
        ? "chat.error.thread_not_found"
        : result.error.kind === "invalid_thread_messages"
          ? "chat.error.stored_messages_invalid"
          : "chat.error.operation_failed";
    throw new Error(i18n.t(key));
  }
  await printChatCliValue([
    { role: "system", content: chatSystemPrompt },
    ...(await convertToModelMessages(result.value.messages)),
  ]);
}

async function requestChat(
  userId: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> {
  const backendUrl = z
    .url()
    .parse(process.env.BACKEND_URL ?? "http://localhost:4000");
  const backendApiKey = z.string().min(1).parse(process.env.BACKEND_API_KEY);
  const response = await fetch(new URL(path, backendUrl), {
    method,
    headers: {
      Authorization: `Bearer ${backendApiKey}`,
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(i18n.t(await readChatErrorKey(response)));
  }
  return response;
}

async function printChatStream(response: Response): Promise<void> {
  if (
    !response.body ||
    !response.headers.get("Content-Type")?.startsWith("text/event-stream")
  ) {
    throw new Error(i18n.t("chat.error.request_failed"));
  }
  let finished = false;
  for await (const frame of response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())) {
    if (frame.data === "[DONE]") {
      if (!finished) {
        console.error(
          "Live stream ended without a final message. Use thread show to check pending/completed/failed status.",
        );
      }
      return;
    }
    const event = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(frame.data));
    await printChatCliValue(event);
    if (event.type === "finish") finished = true;
    if (event.type === "error") {
      throw new Error(i18n.t(parseChatErrorKey(event.errorText)));
    }
  }
  throw new Error(
    "Chat stream ended before completion. Use thread show to reconcile durable state.",
  );
}

async function printChatCliValue(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function reportChatCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/[\r\n]+/g, " "));
  process.exitCode = 1;
}

if (import.meta.main) {
  runMain(chatCli)
    .finally(async () => {
      const closed = await closeChatDatabase();
      if (closed.isErr())
        reportChatCliError(new Error(i18n.t("chat.error.operation_failed")));
    })
    .catch(reportChatCliError);
}
