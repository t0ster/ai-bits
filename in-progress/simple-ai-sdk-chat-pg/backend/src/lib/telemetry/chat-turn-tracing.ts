import { propagateAttributes } from "@langfuse/tracing";
import { SpanStatusCode } from "@opentelemetry/api";
import { type Result, ResultAsync } from "neverthrow";
import { tracer } from "./backend-tracer";

type AsyncTurnOperation =
  | "generate_response"
  | "heartbeat"
  | "save_response"
  | "save_failure";
type PublicationOperation = "publish_finish" | "publish_error";
type TurnOperation = AsyncTurnOperation | PublicationOperation | "setup";

type ChatTurnContext = {
  readonly userId: string;
  readonly threadId: string;
  readonly assistantMessageId: string;
  readonly inputMessageCount: number;
};

interface ChatTurnTrace {
  /** Observe sequential turn operations without creating child spans. */
  run<T, E extends { kind: string; cause?: unknown }>(
    operation: AsyncTurnOperation,
    work: () => PromiseLike<Result<T, E>>,
  ): Promise<Result<T, E>>;
  run(operation: PublicationOperation, work: () => void): void;
  fail(operation: TurnOperation, errorType: string, cause?: unknown): void;
}

/**
 * Own one chat turn span; retain only the final failure, with raw cause details.
 * Successful recovery does not clear failure; unexpected throws propagate unchanged.
 * Await all contributing work before returning from the callback.
 */
export function traceChatTurn<T, E extends { kind: string; cause?: unknown }>(
  input: ChatTurnContext,
  work: (trace: ChatTurnTrace) => Promise<Result<T, E>>,
): ResultAsync<T, E> {
  const result = tracer.startActiveSpan(
    "chat.turn",
    {
      attributes: {
        "chat.thread.id": input.threadId,
        "chat.assistant_message.id": input.assistantMessageId,
        "chat.input_message_count": input.inputMessageCount,
        "chat.user.id": input.userId,
      },
    },
    async (span) => {
      let currentOperation: TurnOperation = "setup";
      let failure:
        | { operation: TurnOperation; errorType: string; cause: unknown }
        | undefined;

      const fail = (
        operation: TurnOperation,
        errorType: string,
        cause?: unknown,
      ) => {
        currentOperation = operation;
        failure = { operation, errorType, cause };
      };

      function run<Value, ErrorType extends { kind: string; cause?: unknown }>(
        operation: AsyncTurnOperation,
        execute: () => PromiseLike<Result<Value, ErrorType>>,
      ): Promise<Result<Value, ErrorType>>;
      function run(operation: PublicationOperation, execute: () => void): void;
      function run<Value, ErrorType extends { kind: string; cause?: unknown }>(
        operation: AsyncTurnOperation | PublicationOperation,
        execute: (() => PromiseLike<Result<Value, ErrorType>>) | (() => void),
      ): Promise<Result<Value, ErrorType>> | undefined {
        currentOperation = operation;
        try {
          const result = execute();
          if (result === undefined) return;
          return Promise.resolve(result).then(
            (settled) => {
              if (settled.isErr())
                fail(operation, settled.error.kind, settled.error.cause);
              return settled;
            },
            (cause: unknown) => {
              fail(operation, "unexpected_exception", cause);
              throw cause;
            },
          );
        } catch (cause) {
          fail(operation, "unexpected_exception", cause);
          throw cause;
        }
      }

      try {
        const result = await propagateAttributes(
          { userId: input.userId, sessionId: input.threadId },
          () => work({ run, fail }),
        );
        if (result.isErr() && !failure)
          fail(currentOperation, result.error.kind, result.error.cause);
        return result;
      } catch (cause) {
        fail(currentOperation, "unexpected_exception", cause);
        throw cause;
      } finally {
        span.setAttribute("chat.outcome", failure ? "failed" : "succeeded");
        if (failure) {
          span.setAttributes({
            "chat.failure.operation": failure.operation,
            "error.type": failure.errorType,
          });
          span.setStatus({ code: SpanStatusCode.ERROR });
          const cause = failure.cause;
          if (cause instanceof Error) {
            span.setAttributes({
              "error.cause.name": cause.name,
              "error.cause.message": cause.message,
            });
          } else if (
            cause !== undefined &&
            (cause === null ||
              (typeof cause !== "object" && typeof cause !== "function"))
          ) {
            span.setAttributes({
              "error.cause.name": cause === null ? "null" : typeof cause,
              "error.cause.message": String(cause),
            });
          }
        }
        span.end();
      }
    },
  );
  return ResultAsync.fromSafePromise(result).andThen((result) => result);
}
