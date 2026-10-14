import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import type { H3Event } from "h3";

export type ChatStream = {
  readonly publish: (event: UIMessageChunk) => void;
};

/**
 * Streams a turn to the client while letting it finish if the client disconnects.
 */
export function createChatStreamResponse(
  event: H3Event,
  invoke: (stream: ChatStream) => Promise<void>,
): Response {
  let cleanup = () => {};
  let cancelled = false;
  const stream = new ReadableStream<UIMessageChunk>(
    {
      start: (controller) => {
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          event.req.signal.removeEventListener("abort", finish);
          if (!cancelled) controller.close();
        };
        const publish = (event: UIMessageChunk) => {
          if (closed) return;
          // Drop slow readers without failing the durable turn.
          if ((controller.desiredSize ?? 0) <= 0) {
            controller.error(new Error("Chat stream reader is too slow."));
            cancelled = true;
            finish();
            return;
          }
          controller.enqueue(event);
        };
        cleanup = finish;
        event.req.signal.addEventListener("abort", finish, { once: true });
        if (event.req.signal.aborted) {
          finish();
        }
        const task = (async () => {
          try {
            await invoke({ publish });
          } catch (cause) {
            if (!closed && !cancelled) {
              controller.error(new Error("Chat turn execution failed."));
              cancelled = true;
            }
            // The turn span owns diagnostics; the runtime must observe a rejected task.
            throw cause;
          } finally {
            finish();
          }
        })();
        event.waitUntil(task);
      },
      cancel: () => {
        cancelled = true;
        cleanup();
      },
    },
    {
      highWaterMark: 1024 * 1024,
      size: (chunk) => JSON.stringify(chunk).length,
    },
  );
  return createUIMessageStreamResponse({ stream });
}
