import {
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { tracer } from "./backend-tracer";

/** Traces request handling through response-body completion, cancellation, or failure. */
export function traceHttpRequest(
  request: Request,
  handle: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const parentContext = propagation.extract(ROOT_CONTEXT, request.headers, {
    keys: (headers) => [...headers.keys()],
    get: (headers, key) => headers.get(key) ?? undefined,
  });
  const url = new URL(request.url);
  return tracer.startActiveSpan(
    request.method,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": request.method,
        "url.path": url.pathname,
        "url.scheme": url.protocol.slice(0, -1),
      },
    },
    parentContext,
    async (span) => {
      let ended = false;
      const finish = (errorType?: string) => {
        if (ended) return;
        ended = true;
        request.signal.removeEventListener("abort", onAbort);
        if (errorType) {
          span.setAttribute("error.type", errorType);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end();
      };
      const onAbort = () => {
        span.setAttribute("http.request.cancelled", true);
        finish();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();

      try {
        const response = await handle(request);
        span.setAttribute("http.response.status_code", response.status);
        if (response.status >= 500) {
          span.setAttribute("error.type", String(response.status));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        if (!response.body) {
          finish();
          return response;
        }

        const reader = response.body.getReader();
        let cancelled = false;
        // Pull only when the runtime requests bytes: do not buffer or consume SSE eagerly.
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const result = await reader.read();
                if (cancelled) return;
                if (result.done) {
                  reader.releaseLock();
                  controller.close();
                  finish();
                } else {
                  controller.enqueue(result.value);
                }
              } catch (cause) {
                if (cancelled) return;
                reader.releaseLock();
                controller.error(cause);
                finish("response_stream_error");
              }
            },
            async cancel(reason) {
              cancelled = true;
              span.setAttribute("http.request.cancelled", true);
              finish();
              try {
                await reader.cancel(reason);
              } finally {
                reader.releaseLock();
              }
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (cause) {
        finish("request_handler_error");
        throw cause;
      }
    },
  );
}
