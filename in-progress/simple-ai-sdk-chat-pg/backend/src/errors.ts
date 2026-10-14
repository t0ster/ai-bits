import type { Result, ResultAsync } from "neverthrow";

export type ThreadNotFound = { kind: "thread_not_found" };
export type ThreadIdUnavailable = { kind: "thread_id_unavailable" };
export type MessageIdConflict = { kind: "message_id_conflict" };
export type GenerationInProgress = { kind: "generation_in_progress" };
export type FailedTurnRequiresRetry = { kind: "failed_turn_requires_retry" };
export type RetryNotAllowed = { kind: "retry_not_allowed" };
export type TurnNoLongerPending = { kind: "turn_no_longer_pending" };
export type AnyError = {
  kind: "any_error";
  cause: unknown;
};

export type ChatError =
  | ThreadNotFound
  | ThreadIdUnavailable
  | MessageIdConflict
  | GenerationInProgress
  | FailedTurnRequiresRetry
  | RetryNotAllowed
  | TurnNoLongerPending
  | AnyError;

export type ChatResult<T, E = never> = Result<T, E | AnyError>;
export type ChatResultAsync<T, E = never> = ResultAsync<T, E | AnyError>;

export class Defect extends Error {}

export const chatError = {
  threadNotFound: (): ThreadNotFound => ({ kind: "thread_not_found" }),
  threadIdUnavailable: (): ThreadIdUnavailable => ({
    kind: "thread_id_unavailable",
  }),
  messageIdConflict: (): MessageIdConflict => ({ kind: "message_id_conflict" }),
  generationInProgress: (): GenerationInProgress => ({
    kind: "generation_in_progress",
  }),
  failedTurnRequiresRetry: (): FailedTurnRequiresRetry => ({
    kind: "failed_turn_requires_retry",
  }),
  retryNotAllowed: (): RetryNotAllowed => ({ kind: "retry_not_allowed" }),
  turnNoLongerPending: (): TurnNoLongerPending => ({
    kind: "turn_no_longer_pending",
  }),
  anyError: (cause: unknown): AnyError => {
    if (cause instanceof Defect) throw cause;
    return { kind: "any_error", cause };
  },
};
