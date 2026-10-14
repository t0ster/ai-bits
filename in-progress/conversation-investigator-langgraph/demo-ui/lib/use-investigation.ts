import { useEffect, useRef, useState } from "react";
import {
  createInvestigationReference,
  investigationReference,
  loadInvestigationSnapshot,
  streamInvestigationSubmission,
} from "@/lib/investigation-api";
import type {
  InvestigationFailure,
  InvestigationReference,
  InvestigationReport,
  InvestigationSnapshot,
  InvestigationSubmission,
} from "@/lib/investigation-api";

type InvestigationId = InvestigationReference["investigation_id"];

/**
 * Investigation as seen by the page. Actions exist only on states that accept them.
 * `error` on `new`/`awaiting-reply` means the backend rejected the last submission;
 * nothing ran, so the user may submit again.
 */
export type InvestigationState =
  | {
      readonly status: "new";
      readonly submitting: boolean;
      readonly error: InvestigationFailure | null;
      readonly start: (question: string) => void;
    }
  | { readonly status: "loading"; readonly id: InvestigationId }
  | {
      readonly status: "running";
      readonly id: InvestigationId;
      readonly snapshot: InvestigationSnapshot | null;
      /** False when no stream is attached: loaded mid-run, or the stream disconnected. */
      readonly live: boolean;
    }
  | {
      readonly status: "awaiting-reply";
      readonly id: InvestigationId;
      readonly snapshot: InvestigationSnapshot;
      readonly question: string;
      readonly submitting: boolean;
      readonly error: InvestigationFailure | null;
      readonly reply: (text: string) => void;
    }
  | {
      readonly status: "completed";
      readonly id: InvestigationId;
      readonly snapshot: InvestigationSnapshot;
      readonly report: InvestigationReport;
    }
  | {
      readonly status: "failed";
      readonly id: InvestigationId;
      readonly snapshot: InvestigationSnapshot | null;
      readonly error: InvestigationFailure;
    };

type Clarification = { readonly id: string; readonly question: string };

/** Hook state without actions; actions are attached per render. */
type InternalState =
  | Omit<Extract<InvestigationState, { status: "new" }>, "start">
  | (Omit<
      Extract<InvestigationState, { status: "awaiting-reply" }>,
      "question" | "reply"
    > & { readonly clarification: Clarification })
  | Exclude<InvestigationState, { status: "new" | "awaiting-reply" }>;

/**
 * Load or create one Investigation and stream its submissions.
 * `investigationId` is read once at mount; routes are full page loads.
 * `onCreated` fires when the backend accepts a new Investigation, so the page can update its URL.
 */
export function useInvestigation(
  investigationId: string | null,
  options?: { readonly onCreated?: (id: InvestigationId) => void },
): InvestigationState {
  const [state, setState] = useState<InternalState>(() =>
    investigationId
      ? {
          status: "loading",
          id: investigationReference(investigationId).investigation_id,
        }
      : { status: "new", submitting: false, error: null },
  );
  const [initialId] = useState(investigationId);
  const onCreated = useRef(options?.onCreated);
  onCreated.current = options?.onCreated;
  const activeStream = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (initialId) {
      const reference = investigationReference(initialId);
      void loadInvestigationSnapshot(reference, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          if (!result.ok) {
            setState({
              status: "failed",
              id: reference.investigation_id,
              snapshot: null,
              error: result.error,
            });
            return;
          }
          const { snapshot } = result.value;
          switch (snapshot.last_request?.status) {
            case "pending":
            case "running":
              setState({
                status: "running",
                id: reference.investigation_id,
                snapshot,
                live: false,
              });
              return;
            case "failed":
              setState({
                status: "failed",
                id: reference.investigation_id,
                snapshot,
                error: {
                  type: "execution",
                  operation: "load",
                  message: "Investigation execution failed.",
                },
              });
              return;
            default:
              setState(
                investigationStateFromSettledSnapshot(
                  reference.investigation_id,
                  snapshot,
                  "load",
                ),
              );
          }
        },
      );
    }
    return () => {
      controller.abort();
      activeStream.current?.abort();
    };
  }, [initialId]);

  /** Run one submission; `rejected` restores the submitting state with the failure. */
  async function submit(
    request: InvestigationSubmission,
    rejected: (error: InvestigationFailure) => InternalState,
    initialSnapshot: InvestigationSnapshot | null,
  ) {
    if (activeStream.current) return;
    const controller = new AbortController();
    activeStream.current = controller;
    const id = request.body.investigation_id;
    let accepted = false;
    // Shown while running; never used to settle, since it predates this submission.
    let snapshot = initialSnapshot;
    let received: InvestigationSnapshot | null = null;
    const result = await streamInvestigationSubmission(request, {
      signal: controller.signal,
      onAccepted: () => {
        accepted = true;
        setState({ status: "running", id, snapshot, live: true });
        if (request.operation === "start") onCreated.current?.(id);
      },
      onProgress: (progress) => {
        snapshot = received = progress.snapshot;
        setState({ status: "running", id, snapshot, live: true });
      },
    });
    activeStream.current = null;
    if (controller.signal.aborted) return;
    if (!result.ok && !accepted) {
      // No acceptance observed: treat as rejected so the user may resubmit.
      setState(rejected(result.error));
      return;
    }
    // Success implies acceptance: `onAccepted` precedes every stream event.
    if (result.ok) {
      setState(
        received
          ? investigationStateFromSettledSnapshot(
              id,
              received,
              request.operation,
            )
          : failedInvestigationState(
              id,
              snapshot,
              request.operation,
              "Investigation finished without progress.",
            ),
      );
    } else if (result.error.type === "transport") {
      // Accepted work continues in the worker without a live stream.
      setState({ status: "running", id, snapshot, live: false });
    } else {
      setState({ status: "failed", id, snapshot, error: result.error });
    }
  }

  switch (state.status) {
    case "new":
      return {
        ...state,
        start: (question) => {
          if (state.submitting) return;
          setState({ status: "new", submitting: true, error: null });
          void submit(
            {
              operation: "start",
              body: {
                request_id: crypto.randomUUID(),
                investigation_id:
                  createInvestigationReference().investigation_id,
                question,
              },
            },
            (error) => ({ status: "new", submitting: false, error }),
            null,
          );
        },
      };
    case "awaiting-reply": {
      const { clarification, ...rest } = state;
      return {
        ...rest,
        question: clarification.question,
        reply: (text) => {
          if (state.submitting) return;
          setState({ ...state, submitting: true, error: null });
          void submit(
            {
              operation: "reply",
              body: {
                request_id: crypto.randomUUID(),
                investigation_id: state.id,
                clarification_id: clarification.id,
                reply: text,
              },
            },
            (error) => ({ ...state, submitting: false, error }),
            state.snapshot,
          );
        },
      };
    }
    default:
      return state;
  }
}

/** Execution ended: the graph either published a report or paused for clarification. */
function investigationStateFromSettledSnapshot(
  id: InvestigationId,
  snapshot: InvestigationSnapshot,
  operation: InvestigationFailure["operation"],
): InternalState {
  const report = snapshot.values.report;
  if (report) return { status: "completed", id, snapshot, report };
  const pending = snapshot.interrupts[0];
  if (pending)
    return {
      status: "awaiting-reply",
      id,
      snapshot,
      clarification: { id: pending.id, question: pending.value.question },
      submitting: false,
      error: null,
    };
  return failedInvestigationState(
    id,
    snapshot,
    operation,
    "Investigation ended without a report or clarification.",
  );
}

function failedInvestigationState(
  id: InvestigationId,
  snapshot: InvestigationSnapshot | null,
  operation: InvestigationFailure["operation"],
  message: string,
): InternalState {
  return {
    status: "failed",
    id,
    snapshot,
    error: { type: "protocol", operation, message },
  };
}
