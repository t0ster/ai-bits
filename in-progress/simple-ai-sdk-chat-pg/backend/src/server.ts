import { config } from "@/config";
import { startBackendTelemetry } from "@/lib/telemetry/backend-telemetry";
import { traceHttpRequest } from "@/lib/telemetry/http-request-tracing";

// Instrumentation must be registered before pg or Drizzle are loaded.
const telemetry = startBackendTelemetry(process.env);
const pendingTasks = new Set<Promise<unknown>>();

async function startChatServer() {
  let database: typeof import("./db/connection") | undefined;
  try {
    database = await import("./db/connection");
    const { api } = await import("./app");
    const { chatRepository } = await import("./persistence/chat");
    const staleMessagesResult = await chatRepository.failStalePendingMessages();
    if (staleMessagesResult.isErr()) {
      const cause = staleMessagesResult.error.cause;
      console.error(`Chat stale-turn recovery failed: ${String(cause)}`);
      throw new Error("Chat backend startup failed.", { cause });
    }
    if (staleMessagesResult.value.length > 0) {
      console.error(
        `Marked ${staleMessagesResult.value.length} stale chat generations as failed.`,
      );
    }

    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: config.backendPort,
      // Chat streams can wait on model output longer than Bun's default idle timeout.
      idleTimeout: 0,
      fetch(request) {
        // H3's waitUntil needs a runtime owner, especially after an SSE disconnect.
        const serverRequest = Object.assign(request, {
          waitUntil(task: Promise<unknown>) {
            pendingTasks.add(task);
            void task.then(
              () => pendingTasks.delete(task),
              // Turn tracing reports defects. Observe rejection without changing
              // the original task into a successful one or crashing other requests.
              () => pendingTasks.delete(task),
            );
          },
        });
        return traceHttpRequest(serverRequest, () => api.fetch(serverRequest));
      },
    });
    return { server, closeDatabase: database.closeChatDatabase };
  } catch (cause) {
    try {
      await database?.closeChatDatabase();
    } finally {
      await telemetry.shutdown();
    }
    throw cause;
  }
}

const { server: chatServer, closeDatabase: closeChatDatabase } =
  await startChatServer();
console.info(`Chat backend listening on ${chatServer.url}`);

let chatShutdownStartedAt: number | undefined;

async function shutdownChatServer() {
  if (chatShutdownStartedAt !== undefined) {
    // bun run can forward the same terminal signal the child already received.
    if (performance.now() - chatShutdownStartedAt < 100) return;
    console.error("Chat backend shutdown forced by second signal.");
    process.exit(1);
  }
  chatShutdownStartedAt = performance.now();
  console.info("Chat backend stopping; send another signal to force exit.");
  // Explicit exit also terminates Bun's watcher and any remaining runtime handles.
  setTimeout(() => {
    console.error("Chat backend shutdown timed out after 5 seconds.");
    process.exit(1);
  }, 5_000);

  try {
    await chatServer.stop();
    await Promise.allSettled(pendingTasks);
    const closed = await closeChatDatabase();
    await telemetry.shutdown();
    if (closed.isErr()) {
      console.error(
        `Chat backend database shutdown failed: ${String(closed.error.cause)}`,
      );
      process.exit(1);
    }
    console.info("Chat backend stopped.");
    process.exit(0);
  } catch (cause) {
    console.error(`Chat backend shutdown failed: ${String(cause)}`);
    process.exit(1);
  }
}

process.on("SIGINT", shutdownChatServer);
process.on("SIGTERM", shutdownChatServer);
