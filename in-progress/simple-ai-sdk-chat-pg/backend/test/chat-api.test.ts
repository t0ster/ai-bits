import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { messageIdSchema } from "@/schemas";

const backendApiKey = process.env.BACKEND_API_KEY;
if (!backendApiKey) {
  throw new Error("Backend test prerequisite missing: set BACKEND_API_KEY.");
}

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error(
    "Backend test prerequisite missing: set DATABASE_URL to an existing PostgreSQL test database.",
  );
}

let parsedDatabaseUrl: URL;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error(
    "Backend test prerequisite invalid: DATABASE_URL must be a valid PostgreSQL URL.",
  );
}

const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
if (!databaseName.toLowerCase().includes("test")) {
  throw new Error(
    "Backend test safety check failed: the DATABASE_URL database name must contain “test”.",
  );
}

const ownerHeaders = {
  Authorization: `Bearer ${backendApiKey}`,
  "Content-Type": "application/json",
  "X-User-Id": "owner",
};
const otherUserHeaders = {
  Authorization: `Bearer ${backendApiKey}`,
  "Content-Type": "application/json",
  "X-User-Id": "other-user",
};

const threadIds = {
  lifecycle: "00000000-0000-4000-8000-000000000001",
  validation: "00000000-0000-4000-8000-000000000002",
  success: "00000000-0000-4000-8000-000000000003",
  conflicts: "00000000-0000-4000-8000-000000000004",
  failure: "00000000-0000-4000-8000-000000000005",
  stale: "00000000-0000-4000-8000-000000000006",
  concurrent: "00000000-0000-4000-8000-000000000007",
  older: "00000000-0000-4000-8000-000000000008",
  newer: "00000000-0000-4000-8000-000000000009",
  tool: "00000000-0000-4000-8000-00000000000a",
} as const;

type ChatApi = Awaited<typeof import("@/app")>["api"];
type ChatDatabase = Awaited<typeof import("@/db/connection")>;

let database: ChatDatabase;
let messageTable: Awaited<typeof import("@/db/schema")>["messages"];
let threadTable: Awaited<typeof import("@/db/schema")>["threads"];
let api: ChatApi;
const providerMessageSchema = z.object({
  role: z.string(),
  content: z.union([
    z.string().transform((text) => [{ type: "input_text", text }]),
    z.array(z.object({ type: z.string(), text: z.string().optional() })),
  ]),
});
const providerToolOutputSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
});
// Messages and tool outputs share the Responses API input array.
const providerRequestSchema = z
  .object({ input: z.array(z.looseObject({})) })
  .transform(({ input }) => ({
    input: input.flatMap((item) => {
      const parsed = providerMessageSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
    toolOutputs: input.flatMap((item) => {
      const parsed = providerToolOutputSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  }));
type ProviderRequest = z.output<typeof providerRequestSchema>;
type ProviderReply = {
  text: string;
  fail?: boolean;
  httpError?: boolean;
  toolCall?: { name: string; input: unknown };
};
let respond: (
  request: ProviderRequest,
) => ProviderReply | Promise<ProviderReply>;
const providerRequests: ProviderRequest[] = [];
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const parsed = providerRequestSchema.parse(await request.json());
    providerRequests.push(parsed);
    const reply = await respond(parsed);
    if (reply.httpError)
      return Response.json(
        {
          error: {
            message: "private provider error",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );
    if (reply.toolCall) return toolCallResponse(reply.toolCall);
    const item = {
      type: "message",
      id: "msg_test",
      role: "assistant",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    };
    const events = [
      {
        type: "response.created",
        response: { id: "resp_test", created_at: 1, model: "test-model" },
      },
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        delta: reply.text,
      },
      ...(reply.fail
        ? [
            {
              type: "response.failed",
              sequence_number: 3,
              response: {
                error: {
                  code: "server_error",
                  message: "private provider error",
                },
              },
            },
          ]
        : [
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]),
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});

/** Streams one Responses API function call; the AI SDK then runs the tool. */
function toolCallResponse(toolCall: { name: string; input: unknown }) {
  const item = {
    type: "function_call",
    id: "fc_test",
    call_id: "call_test",
    name: toolCall.name,
    arguments: JSON.stringify(toolCall.input),
  };
  const events = [
    {
      type: "response.created",
      response: { id: "resp_tool", created_at: 1, model: "test-model" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, status: "completed" },
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
process.env.OPENAI_BASE_URL = provider.url.toString();
process.env.OPENAI_API_KEY = "local-test-key";
process.env.OPENAI_MODEL = "test-model";
delete process.env.OPENAI_REASONING_EFFORT;
process.env.CHAT_VERIFICATION_STREAM_ERROR_RATE = "0";

function completedReply(
  text = "Deterministic assistant response",
): typeof respond {
  return () => ({ text });
}

function jsonRequest(
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return Promise.resolve(
    api.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function durableStatus(message: UIMessage | undefined): string | undefined {
  return z
    .object({ status: z.string().optional() })
    .parse(message?.metadata ?? {}).status;
}

function createThread(id: string, headers = ownerHeaders): Promise<Response> {
  return jsonRequest("/threads", "POST", headers, {
    id,
    messages: [
      {
        id: `${id}-first`,
        role: "user",
        parts: [{ type: "text", text: "First" }],
      },
    ],
  });
}

function sendMessage(
  threadId: string,
  messageId: string,
  text: string,
): Promise<Response> {
  return jsonRequest(`/threads/${threadId}/send`, "POST", ownerHeaders, {
    message: {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text }],
    },
  });
}

function retryThread(threadId: string): Promise<Response> {
  return jsonRequest(`/threads/${threadId}/retry`, "POST", ownerHeaders);
}

async function loadThread(threadId: string): Promise<{
  id: string;
  user_id: string;
  created_at: string;
  messages: UIMessage[];
}> {
  const response = await jsonRequest(
    `/threads/${threadId}`,
    "GET",
    ownerHeaders,
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function readSseEvents(response: Response): Promise<UIMessageChunk[]> {
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

beforeAll(async () => {
  const [{ migrate }, appModule, connectionModule, schemaModule] =
    await Promise.all([
      import("drizzle-orm/node-postgres/migrator"),
      import("@/app"),
      import("@/db/connection"),
      import("@/db/schema"),
    ]);
  api = appModule.api;
  database = connectionModule;
  messageTable = schemaModule.messages;
  threadTable = schemaModule.threads;

  await migrate(database.db, {
    migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
  });
});

beforeEach(async () => {
  await database.db.execute(sql`TRUNCATE TABLE ${threadTable} CASCADE`);
  providerRequests.length = 0;
  respond = completedReply();
});

afterAll(async () => {
  provider.stop(true);
  if (database !== undefined) {
    const closeResult = await database.closeChatDatabase();
    if (closeResult.isErr()) throw closeResult.error.cause;
  }
});

describe.serial("chat API integration", () => {
  test("creation stores completed initial history and only answers its final user message", async () => {
    const id = threadIds.lifecycle;
    respond = completedReply("Fresh response");
    const response = await jsonRequest("/threads", "POST", ownerHeaders, {
      id,
      messages: [
        {
          id: "seed-user",
          role: "user",
          parts: [{ type: "text", text: "/help" }],
        },
        {
          id: "seed-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Help text" }],
        },
        {
          id: "new-user",
          role: "user",
          parts: [{ type: "text", text: "Follow up" }],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(
      (await readSseEvents(response)).some((event) => event.type === "finish"),
    ).toBe(true);
    expect(
      providerRequests
        .at(-1)
        ?.input.filter(
          (message) =>
            message.role !== "system" && message.role !== "developer",
        )
        .map((message) => message.content.map((part) => part.text).join("")),
    ).toEqual(["/help", "Help text", "Follow up"]);
    const thread = await loadThread(id);
    expect(thread.messages.map((message) => message.id).slice(0, 3)).toEqual([
      "seed-user",
      "seed-assistant",
      "new-user",
    ]);
    expect(
      thread.messages[1]?.parts.filter((part) => part.type === "text"),
    ).toMatchObject([{ type: "text", text: "Help text" }]);
    expect(
      thread.messages[3]?.parts.filter((part) => part.type === "text"),
    ).toMatchObject([{ type: "text", text: "Fresh response" }]);
  });

  test("creation rejects malformed initial history without storing a thread", async () => {
    const id = threadIds.validation;
    for (const messages of [
      [],
      [
        {
          id: "only-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Wrong" }],
        },
      ],
      [
        { id: "same", role: "user", parts: [{ type: "text", text: "One" }] },
        {
          id: "same",
          role: "assistant",
          parts: [{ type: "text", text: "Two" }],
        },
        { id: "last", role: "user", parts: [{ type: "text", text: "Three" }] },
      ],
      [
        {
          id: "first-user",
          role: "user",
          parts: [{ type: "text", text: "Hi" }],
        },
        {
          id: "empty-assistant",
          role: "assistant",
          parts: [{ type: "step-start" }],
        },
        {
          id: "next-user",
          role: "user",
          parts: [{ type: "text", text: "Next" }],
        },
      ],
    ]) {
      expect(
        (await jsonRequest("/threads", "POST", ownerHeaders, { id, messages }))
          .status,
      ).toBe(400);
    }
    expect(
      (await jsonRequest(`/threads/${id}`, "GET", ownerHeaders)).status,
    ).toBe(404);
  });

  test("a failed first answer keeps initial history and can be retried", async () => {
    const id = threadIds.failure;
    respond = () => ({ text: "", fail: true });
    const events = await readSseEvents(await createThread(id));
    expect(events.some((event) => event.type === "error")).toBe(true);
    const failed = await loadThread(id);
    expect(failed.messages.map(durableStatus)).toEqual(["completed", "failed"]);
    respond = completedReply("Recovered");
    expect(
      (await readSseEvents(await retryThread(id))).some(
        (event) => event.type === "finish",
      ),
    ).toBe(true);
    const recovered = await loadThread(id);
    expect(recovered.messages[1]?.id).toBe(failed.messages[1]?.id);
    expect(
      recovered.messages[1]?.parts.filter((part) => part.type === "text"),
    ).toMatchObject([{ type: "text", text: "Recovered" }]);
  });

  test("generation errors publish a retryable failure after persisting the turn", async () => {
    const id = threadIds.failure;
    respond = () => ({ text: "", httpError: true });
    const events = await readSseEvents(await createThread(id));
    expect(events.at(-1)).toEqual({
      type: "error",
      errorText: "chat.error.response_failed",
    });
    expect((await loadThread(id)).messages.map(durableStatus)).toEqual([
      "completed",
      "failed",
    ]);
    respond = completedReply("Recovered");
    expect(
      (await readSseEvents(await retryThread(id))).some(
        (event) => event.type === "finish",
      ),
    ).toBe(true);
  });

  test("every backend route rejects missing and incorrect credentials", async () => {
    for (const [method, path] of [
      ["GET", "/threads"],
      ["POST", "/threads"],
      ["GET", `/threads/${threadIds.lifecycle}`],
      ["POST", `/threads/${threadIds.lifecycle}/send`],
      ["POST", `/threads/${threadIds.lifecycle}/retry`],
    ] as const) {
      for (const authorization of [
        undefined,
        "Bearer wrong-key",
        backendApiKey,
      ]) {
        const headers = { ...ownerHeaders };
        if (authorization === undefined) {
          delete (headers as Partial<typeof headers>).Authorization;
        } else {
          headers.Authorization = authorization;
        }
        const response = await jsonRequest(path, method, headers);
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain(backendApiKey);
      }
    }
  });

  test("a user can create, reopen, and exclusively own a thread", async () => {
    const id = threadIds.lifecycle;
    const createResponse = await createThread(id);
    expect(createResponse.status).toBe(200);
    expect(
      (await readSseEvents(createResponse)).some(
        (event) => event.type === "finish",
      ),
    ).toBe(true);
    const createdThread = await loadThread(id);
    expect(createdThread).toMatchObject({ id, user_id: "owner" });
    expect(Date.parse(createdThread.created_at)).not.toBeNaN();
    expect((await createThread(id)).status).toBe(409);

    const ownerList = await jsonRequest("/threads", "GET", ownerHeaders);
    expect(await ownerList.json()).toEqual([
      { id, user_id: "owner", created_at: createdThread.created_at },
    ]);
    const loadedThread = await loadThread(id);
    expect(loadedThread.created_at).toBe(createdThread.created_at);
    expect(loadedThread.messages).toHaveLength(2);

    const otherList = await jsonRequest("/threads", "GET", otherUserHeaders);
    expect(await otherList.json()).toEqual([]);
    const otherLoad = await jsonRequest(
      `/threads/${id}`,
      "GET",
      otherUserHeaders,
    );
    expect(otherLoad.status).toBe(404);
  });

  test("threads are listed by creation time, newest first", async () => {
    const olderResponse = await createThread(threadIds.older);
    await readSseEvents(olderResponse);
    const olderThread = await loadThread(threadIds.older);
    await Bun.sleep(10);
    const newerResponse = await createThread(threadIds.newer);
    await readSseEvents(newerResponse);
    const newerThread = await loadThread(threadIds.newer);

    expect(Date.parse(newerThread.created_at)).toBeGreaterThan(
      Date.parse(olderThread.created_at),
    );
    const ownerList = await jsonRequest("/threads", "GET", ownerHeaders);
    expect(
      (await ownerList.json()).map((thread: { id: string }) => thread.id),
    ).toEqual([threadIds.newer, threadIds.older]);
  });

  test("invalid user, thread, and user message input is rejected", async () => {
    expect(
      (
        await api.request("/threads", {
          headers: { Authorization: ownerHeaders.Authorization },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await createThread(threadIds.validation, {
          ...ownerHeaders,
          "X-User-Id": "  ",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await jsonRequest("/threads", "POST", ownerHeaders, {
          id: "not-a-uuid",
        })
      ).status,
    ).toBe(400);

    await readSseEvents(await createThread(threadIds.validation));
    expect(
      (
        await jsonRequest(
          `/threads/${threadIds.validation}/send`,
          "POST",
          ownerHeaders,
          { message: { id: "missing-parts", role: "user" } },
        )
      ).status,
    ).toBe(400);
    expect(
      (await sendMessage(threadIds.validation, "blank-message", " \n\t"))
        .status,
    ).toBe(400);
  });

  test("a successful turn streams content then persists ordered completed messages", async () => {
    const id = threadIds.success;
    await readSseEvents(await createThread(id));
    const response = await sendMessage(id, "success-user-message", "Hello");
    expect(response.status).toBe(200);
    const events = await readSseEvents(response);
    const contentIndex = events.findIndex(
      (event) => event.type === "text-delta",
    );
    const finishIndex = events.findIndex((event) => event.type === "finish");
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(finishIndex).toBeGreaterThan(contentIndex);

    const thread = await loadThread(id);
    expect(thread.messages).toHaveLength(4);
    expect(thread.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(thread.messages.map(durableStatus)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(thread.messages[3]?.metadata).toMatchObject({
      status: "completed",
    });
  });

  test("a model tool call runs over two steps and persists its result", async () => {
    const id = threadIds.tool;
    respond = (request) =>
      request.toolOutputs.length === 0
        ? {
            text: "",
            toolCall: { name: "getCurrentTime", input: { timeZone: "UTC" } },
          }
        : { text: "It is now in UTC." };
    const events = await readSseEvents(await createThread(id));
    expect(events.at(-1)?.type).toBe("finish");
    expect(providerRequests.map((request) => request.toolOutputs)).toEqual([
      [],
      [expect.objectContaining({ call_id: "call_test" })],
    ]);

    const assistant = (await loadThread(id)).messages[1];
    expect(durableStatus(assistant)).toBe("completed");
    expect(
      assistant?.parts.filter(
        (part) => part.type === "tool-getCurrentTime" || part.type === "text",
      ),
    ).toMatchObject([
      {
        type: "tool-getCurrentTime",
        state: "output-available",
        input: { timeZone: "UTC" },
        output: { timeZone: "UTC" },
      },
      { type: "text", text: "It is now in UTC." },
    ]);
  });

  test("thread and message identity conflicts do not corrupt durable chat state", async () => {
    const id = threadIds.conflicts;
    await readSseEvents(await createThread(id));
    expect((await createThread(id, otherUserHeaders)).status).toBe(409);

    expect((await sendMessage(id, "duplicate-message", "First")).status).toBe(
      200,
    );
    expect(
      (await sendMessage(id, "duplicate-message", "Different")).status,
    ).toBe(409);
    const thread = await loadThread(id);
    expect(thread.user_id).toBe("owner");
    expect(thread.messages).toHaveLength(4);
    expect(
      thread.messages[2]?.parts.filter((part) => part.type === "text"),
    ).toMatchObject([{ type: "text", text: "First" }]);
  });

  test("a failed assistant response blocks new sends and retry reuses the turn", async () => {
    const id = threadIds.failure;
    await readSseEvents(await createThread(id));
    respond = () => ({ text: "Partial response", fail: true });
    const failedResponse = await sendMessage(id, "failed-user-message", "Fail");
    const failedEvents = await readSseEvents(failedResponse);
    expect(
      failedEvents
        .filter((event) =>
          ["text-start", "text-delta", "error", "finish"].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual(["text-start", "text-delta", "error"]);

    const failedThread = await loadThread(id);
    const assistantId = failedThread.messages[3]?.id;
    expect(durableStatus(failedThread.messages[3])).toBe("failed");
    expect((await sendMessage(id, "blocked-message", "Blocked")).status).toBe(
      409,
    );

    respond = (request) => ({
      text:
        "Context: " +
        request.input
          .filter(
            (message) =>
              message.role !== "system" && message.role !== "developer",
          )
          .flatMap((message) => message.content)
          .map((part) => part.text ?? "")
          .join(""),
    });
    const retryEvents = await readSseEvents(await retryThread(id));
    expect(retryEvents.some((event) => event.type === "finish")).toBe(true);
    const recoveredThread = await loadThread(id);
    expect(recoveredThread.messages).toHaveLength(4);
    expect(recoveredThread.messages[3]?.id).toBe(assistantId);
    expect(durableStatus(recoveredThread.messages[3])).toBe("completed");
    expect(
      recoveredThread.messages[3]?.parts.filter((part) => part.type === "text"),
    ).toMatchObject([
      {
        type: "text",
        text: "Context: FirstDeterministic assistant responseFail",
      },
    ]);
  });

  test("an expired pending assistant response becomes failed and retryable", async () => {
    const id = threadIds.stale;
    await database.db.insert(threadTable).values({ id, userId: "owner" });
    await database.db.insert(messageTable).values([
      {
        id: messageIdSchema.parse("stale-user-message"),
        threadId: id,
        position: 0,
        role: "user",
        status: "completed",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        id: messageIdSchema.parse("stale-assistant-response"),
        threadId: id,
        position: 1,
        role: "assistant",
        status: "pending",
        heartbeatAt: new Date(0),
        parts: [],
      },
    ]);

    const recovered = await loadThread(id);
    expect(durableStatus(recovered.messages[1])).toBe("failed");
    const retryResponse = await retryThread(id);
    expect(retryResponse.status).toBe(200);
    await readSseEvents(retryResponse);
    const completed = await loadThread(id);
    expect(completed.messages[1]?.id).toBe("stale-assistant-response");
    expect(durableStatus(completed.messages[1])).toBe("completed");
  });

  test("only one concurrent send claims a thread while generation is pending", async () => {
    let signalStarted: (() => void) | undefined;
    let releaseGeneration: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const id = threadIds.concurrent;
    respond = completedReply();
    await readSseEvents(await createThread(id));
    respond = async () => {
      signalStarted?.();
      await released;
      return { text: "Concurrent winner" };
    };
    const firstResponsePromise = sendMessage(id, "winning-message", "First");
    await started;
    const competingResponse = await sendMessage(
      id,
      "competing-message",
      "Second",
    );
    expect(competingResponse.status).toBe(409);
    releaseGeneration?.();

    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(200);
    await readSseEvents(firstResponse);
    const thread = await loadThread(id);
    expect(thread.messages).toHaveLength(4);
    expect(thread.messages[2]?.id).toBe("winning-message");
  });
});
