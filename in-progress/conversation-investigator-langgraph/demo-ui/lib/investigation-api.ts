import {
  EventSourceParserStream,
  ParseError,
  type EventSourceMessage,
} from "eventsource-parser/stream";
import { z } from "zod";

const investigationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .brand<"InvestigationId">();
const referenceSchema = z.object({
  investigation_id: investigationIdSchema,
});
const citationSchema = z.object({
  conversation_id: z.string(),
  transcript_entry_ids: z.array(z.string()),
  quote: z.string(),
});
const reportSchema = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      citations: z.array(citationSchema),
    }),
  ),
});
const graphSnapshotSchema = z
  .object({
    values: z
      .object({
        question: z.string().optional(),
        scope: z
          .object({
            query: z.string(),
            time_range: z.object({ start: z.string(), end: z.string() }),
            agent_id: z.string().nullable(),
            team_id: z.string().nullable(),
          })
          .nullable()
          .optional(),
        report: reportSchema.nullable().optional(),
        search_history: z.array(z.unknown()).optional(),
        read_conversations: z.array(z.unknown()).optional(),
      })
      .passthrough(),
    next: z
      .enum([
        "initialize",
        "interpret",
        "clarify",
        "investigate",
        "search",
        "read",
        "draft",
        "validate",
      ])
      .nullable(),
    interrupts: z.array(
      z.object({ id: z.string(), value: z.object({ question: z.string() }) }),
    ),
  })
  .passthrough();
const snapshotEventSchema = z.object({ snapshot: graphSnapshotSchema });
const savedSnapshotSchema = graphSnapshotSchema.extend({
  last_request: z
    .object({
      request_id: z.string().brand<"InvestigationRequestId">(),
      status: z.enum(["pending", "running", "completed", "failed"]),
    })
    .nullable(),
});

/** Stable investigation identity; queue lookup belongs to the backend. */
export type InvestigationReference = z.infer<typeof referenceSchema>;
/** Native graph snapshot: state values, next step, and pending clarifications. */
export type InvestigationSnapshot = z.infer<typeof graphSnapshotSchema>;
/** Parsed progress frame containing the native graph snapshot. */
export type InvestigationProgress = z.infer<typeof snapshotEventSchema>;
/** Final validated report; citations retain original transcript entry identifiers. */
export type InvestigationReport = z.infer<typeof reportSchema>;
/** One initial question or clarification reply opens one execution stream. */
export type InvestigationSubmission =
  | {
      readonly operation: "start";
      readonly body: {
        readonly request_id: string;
        readonly investigation_id: InvestigationReference["investigation_id"];
        readonly question: string;
      };
    }
  | {
      readonly operation: "reply";
      readonly body: {
        readonly request_id: string;
        readonly investigation_id: InvestigationReference["investigation_id"];
        readonly clarification_id: string;
        readonly reply: string;
      };
    };

type InvestigationOperation = "load" | InvestigationSubmission["operation"];
/** Why a load or submission stopped; `transport` covers disconnects. */
export type InvestigationFailure =
  | {
      readonly type: "http";
      readonly operation: InvestigationOperation;
      readonly status: number;
      readonly message: string;
    }
  | {
      readonly type: "protocol" | "execution";
      readonly operation: InvestigationOperation;
      readonly message: string;
    }
  | {
      readonly type: "transport";
      readonly operation: InvestigationOperation;
      readonly cause: unknown;
      readonly message: string;
    };
type InvestigationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: InvestigationFailure };

/** Adopt a routed investigation ID as-is; the API reports unknown IDs. */
export function investigationReference(
  investigationId: string,
): InvestigationReference {
  // SAFETY: Routes deliberately skip ID validation. The brand is unchecked here;
  // the API rejects unknown or malformed IDs when the reference is used.
  return {
    investigation_id:
      investigationId as InvestigationReference["investigation_id"],
  };
}

/** Choose investigation identity before submission; retries retain this same value. */
export function createInvestigationReference(): InvestigationReference {
  return referenceSchema.parse({ investigation_id: crypto.randomUUID() });
}

/** Load saved history once; never enqueue or attach to a running execution. */
export async function loadInvestigationSnapshot(
  reference: InvestigationReference,
  signal: AbortSignal,
): Promise<
  InvestigationResult<{
    readonly snapshot: z.infer<typeof savedSnapshotSchema>;
  }>
> {
  try {
    const response = await fetch(
      `/api/investigations/${encodeURIComponent(reference.investigation_id)}`,
      { signal },
    );
    if (!response.ok)
      return {
        ok: false,
        error: {
          type: "http",
          operation: "load",
          status: response.status,
          message: `Investigation load failed (${response.status}).`,
        },
      };
    const parsed = savedSnapshotSchema.safeParse(await response.json());
    return parsed.success
      ? { ok: true, value: { snapshot: parsed.data } }
      : {
          ok: false,
          error: {
            type: "protocol",
            operation: "load",
            message: "Investigation snapshot was invalid.",
          },
        };
  } catch (cause) {
    if (cause instanceof SyntaxError)
      return investigationProtocolFailure(
        "load",
        "Investigation snapshot JSON was invalid.",
      );
    return {
      ok: false,
      error: {
        type: "transport",
        operation: "load",
        cause,
        message: "Investigation snapshot could not be loaded.",
      },
    };
  }
}

function investigationProtocolFailure(
  operation: InvestigationOperation,
  message: string,
): InvestigationResult<never> {
  return { ok: false, error: { type: "protocol", operation, message } };
}

function investigationTransportFailure(
  operation: InvestigationOperation,
  cause: unknown,
  message = "Investigation stream disconnected. Work may continue in the background.",
): InvestigationResult<never> {
  return { ok: false, error: { type: "transport", operation, cause, message } };
}

/**
 * Submit and consume snapshots until an explicit terminal event; never reconnect or retry.
 * `onAccepted` fires once the backend accepts the submission, before any progress.
 */
export async function streamInvestigationSubmission(
  request: InvestigationSubmission,
  options: {
    readonly signal: AbortSignal;
    readonly onAccepted: () => void;
    readonly onProgress: (progress: InvestigationProgress) => void;
  },
): Promise<InvestigationResult<null>> {
  let response: Response;
  try {
    response = await fetch(`/api/investigations/${request.operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
      signal: options.signal,
    });
  } catch (cause) {
    return investigationTransportFailure(
      request.operation,
      cause,
      "Investigation submission could not reach the server.",
    );
  }
  if (!response.ok)
    return {
      ok: false,
      error: {
        type: "http",
        operation: request.operation,
        status: response.status,
        message: `Investigation submission failed (${response.status}).`,
      },
    };
  // The backend accepts the request before sending response headers.
  options.onAccepted();
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return investigationProtocolFailure(
      request.operation,
      "Investigation stream response was invalid.",
    );
  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onError: "terminate" }))
    .getReader();
  try {
    while (true) {
      let frame: ReadableStreamReadResult<EventSourceMessage>;
      try {
        frame = await reader.read();
      } catch (cause) {
        return cause instanceof ParseError
          ? investigationProtocolFailure(
              request.operation,
              "Investigation event framing was invalid.",
            )
          : investigationTransportFailure(request.operation, cause);
      }
      if (frame.done)
        return investigationTransportFailure(
          request.operation,
          new Error("Investigation connection ended before completion."),
        );
      let payload: unknown;
      try {
        payload = JSON.parse(frame.value.data);
      } catch {
        return investigationProtocolFailure(
          request.operation,
          "Investigation event JSON was invalid.",
        );
      }
      switch (frame.value.event) {
        case "snapshot": {
          const parsed = snapshotEventSchema.safeParse(payload);
          if (!parsed.success)
            return investigationProtocolFailure(
              request.operation,
              "Investigation progress was invalid.",
            );
          // Caller defects propagate; only transport and decoding failures become results.
          options.onProgress(parsed.data);
          break;
        }
        case "done":
          return z.object({}).strict().safeParse(payload).success
            ? { ok: true, value: null }
            : investigationProtocolFailure(
                request.operation,
                "Investigation completion event was invalid.",
              );
        case "error": {
          const parsed = z.object({ message: z.string() }).safeParse(payload);
          return parsed.success
            ? {
                ok: false,
                error: {
                  type: "execution",
                  operation: request.operation,
                  message: parsed.data.message,
                },
              }
            : investigationProtocolFailure(
                request.operation,
                "Investigation failure event was invalid.",
              );
        }
        default:
          return investigationProtocolFailure(
            request.operation,
            "Investigation stream contained an unknown event.",
          );
      }
    }
  } finally {
    // Cancellation may reject after a read error; preserve the original outcome.
    try {
      await reader.cancel();
    } catch {
      /* Already failed or disconnected. */
    }
    reader.releaseLock();
  }
}
