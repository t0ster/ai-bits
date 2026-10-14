import { createOpenAI } from "@ai-sdk/openai";
import type { ChatMessage, messageStatusSchema } from "@app/shared";
import {
  type ChatErrorKey,
  type ChatStreamError,
  chatStreamError,
  parseChatErrorKey,
} from "@app/shared/i18n";
import { trace as traceApi } from "@opentelemetry/api";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
  type UIMessageChunk,
  wrapLanguageModel,
} from "ai";
import { err, ok, ResultAsync } from "neverthrow";
import { z } from "zod";
import { config } from "@/config";
import {
  type AnyError,
  type ChatResult,
  chatError,
  type FailedTurnRequiresRetry,
  type TurnNoLongerPending,
} from "@/errors";
import { chatSystemPrompt } from "@/lib/generation/chat-system-prompt";
import { chatModelTools } from "@/lib/generation/chat-tools";
import { traceChatTurn } from "@/lib/telemetry/chat-turn-tracing";
import { type BoundTurn, turns } from "@/persistence/turns";

/** Publishes response chunks independently of the transport. */
type TurnStream = { readonly publish: (event: UIMessageChunk) => void };

type StartTurnStream<T> = (run: (stream: TurnStream) => Promise<void>) => T;

/** Describes the durable outcome and terminal event of assistant generation. */
type AssistantGeneration =
  | Readonly<{
      kind: "completed";
      message: UIMessage;
      finishEvent: UIMessageChunk & { type: "finish" };
    }>
  | Readonly<{
      kind: "failed";
      errorEvents: ReadonlyArray<ChatStreamError>;
      cause?: unknown;
    }>;

function toUIMessageMetadata(
  status: z.infer<typeof messageStatusSchema>,
  metadata: UIMessage["metadata"],
): UIMessage["metadata"] {
  return {
    ...z.looseObject({}).parse(metadata ?? {}),
    status,
  };
}

const openai = createOpenAI({
  ...(config.openAiApiKey === undefined ? {} : { apiKey: config.openAiApiKey }),
  ...(config.openAiBaseUrl === undefined
    ? {}
    : { baseURL: config.openAiBaseUrl }),
});

/** Binds a user's thread context for creation, sending, and retrying turns. */
export function executeTurn(context: { userId: string; threadId: string }) {
  const persistence = turns(context.threadId);

  async function createAndSend<T>(
    messages: UIMessage[],
    startStream: StartTurnStream<T>,
  ) {
    const claimed = await persistence.create({
      userId: context.userId,
      messages,
    });
    if (claimed.isErr()) return err(claimed.error);
    return run(claimed.value, startStream);
  }

  async function send<T>(message: UIMessage, startStream: StartTurnStream<T>) {
    const claimed = await persistence.begin({
      userId: context.userId,
      message,
      decideBeginTurn: (state) => {
        const latestMessage = state.messages.at(-1);
        if (latestMessage?.role === "assistant") {
          if (latestMessage.status === "pending") {
            return err(chatError.generationInProgress());
          }
          if (latestMessage.status === "failed") {
            return err(chatError.failedTurnRequiresRetry());
          }
        }
        return ok({
          priorMessages: state.messages
            .filter((message) => message.status === "completed")
            .map((message) => message.message),
        });
      },
    });
    if (claimed.isErr()) return err(claimed.error);
    return run(claimed.value, startStream);
  }

  async function retry<T>(startStream: StartTurnStream<T>) {
    const claimed = await persistence.retry({
      userId: context.userId,
      decideRetryTurn: (state) => {
        const assistant = state.messages.at(-1);
        if (assistant?.role !== "assistant" || assistant.status !== "failed") {
          return err(chatError.retryNotAllowed());
        }
        return ok({
          assistantMessageId: assistant.id,
          generationMessages: state.messages
            .filter(
              (message) =>
                message.position < assistant.position &&
                message.status === "completed",
            )
            .map((message) => message.message),
        });
      },
    });
    if (claimed.isErr()) return err(claimed.error);
    return run(claimed.value, startStream);
  }

  function run<T>(turn: BoundTurn, startStream: StartTurnStream<T>) {
    return ok(
      startStream(async (liveStream) => {
        await traceChatTurn(
          {
            userId: turn.userId,
            threadId: turn.threadId,
            assistantMessageId: turn.assistantMessageId,
            inputMessageCount: turn.messages.length,
          },
          async (
            trace,
          ): Promise<
            ChatResult<void, FailedTurnRequiresRetry | TurnNoLongerPending>
          > => {
            const abort = new AbortController();
            type HeartbeatFailure =
              | { kind: "error"; error: AnyError | TurnNoLongerPending }
              | { kind: "defect"; cause: unknown };
            const heartbeat: {
              task: Promise<void> | undefined;
              failure: HeartbeatFailure | undefined;
            } = { task: undefined, failure: undefined };
            const stopHeartbeat = (failure: HeartbeatFailure) => {
              heartbeat.failure = failure;
              clearInterval(heartbeatTimer);
              abort.abort();
            };
            const heartbeatTimer = setInterval(() => {
              if (heartbeat.task) return;
              heartbeat.task = (async () => {
                const result = await turn.heartbeat();
                if (result.isErr()) {
                  stopHeartbeat({ kind: "error", error: result.error });
                } else if (!result.value) {
                  stopHeartbeat({
                    kind: "error",
                    error: chatError.turnNoLongerPending(),
                  });
                }
              })()
                .catch((cause: unknown) => {
                  // Defer propagation only long enough to cancel and join generation.
                  stopHeartbeat({ kind: "defect", cause });
                })
                .finally(() => {
                  heartbeat.task = undefined;
                });
            }, config.turnHeartbeatIntervalMs);

            let generated: PromiseSettledResult<
              ChatResult<AssistantGeneration>
            >;
            try {
              [generated] = await Promise.allSettled([
                trace.run(
                  "generate_response",
                  async (): Promise<ChatResult<AssistantGeneration>> => {
                    const lastMessage = turn.messages.at(-1);
                    let command: "help" | undefined;
                    if (
                      lastMessage?.role === "user" &&
                      lastMessage.parts.every((part) => part.type === "text")
                    ) {
                      const text = lastMessage.parts
                        .map((part) => (part.type === "text" ? part.text : ""))
                        .join("");
                      if (text.trim() === "/help") command = "help";
                    }
                    // Enrich the active turn span without passing a logging context down the tree.
                    traceApi.getActiveSpan()?.setAttributes(
                      command === undefined
                        ? {
                            "chat.response.source": "model",
                            "chat.model": config.openAiModel,
                          }
                        : {
                            "chat.response.source": "command",
                            "chat.command": command,
                          },
                    );
                    if (command !== undefined) {
                      if (abort.signal.aborted) {
                        return err(
                          chatError.anyError(
                            new Error("Chat command response was aborted."),
                          ),
                        );
                      }
                      // One display call per assistant turn; retries retain that turn's identity.
                      const toolCallId = turn.assistantMessageId;
                      const input = {};
                      const output = { status: "ok" } as const;
                      const type = `tool-${command}` as const;
                      const message: ChatMessage = {
                        id: turn.assistantMessageId,
                        role: "assistant",
                        parts: [
                          {
                            type,
                            toolCallId,
                            state: "output-available",
                            input,
                            output,
                          },
                        ],
                      };
                      liveStream.publish({
                        type: "start",
                        messageId: turn.assistantMessageId,
                      });
                      liveStream.publish({
                        type: "tool-input-available",
                        toolCallId,
                        toolName: command,
                        input,
                      });
                      liveStream.publish({
                        type: "tool-output-available",
                        toolCallId,
                        output,
                      });
                      // executeTurn persists this message before publishing the terminal finish.
                      return ok({
                        kind: "completed",
                        message,
                        finishEvent: { type: "finish", finishReason: "stop" },
                      });
                    }
                    const modelMessages = await convertToModelMessages(
                      turn.messages,
                    );
                    let streamFailure: AnyError | undefined;
                    let response: UIMessage | undefined;
                    let finishEvent:
                      | (UIMessageChunk & { type: "finish" })
                      | undefined;
                    const errorEvents: ChatStreamError[] = [];
                    const injectStreamError =
                      Math.random() < config.chatVerificationStreamErrorRate;
                    const textDeltaLimit = Math.floor(Math.random() * 3) + 1;
                    if (config.chatVerificationStreamErrorRate > 0) {
                      console.info(
                        injectStreamError
                          ? `Chat verification stream error selected after ${textDeltaLimit} text delta(s).`
                          : "Chat verification stream completion selected.",
                      );
                    }
                    const providerModel = openai.responses(config.openAiModel);
                    const model = wrapLanguageModel({
                      model: providerModel,
                      middleware: {
                        wrapStream: async ({ doStream }) => {
                          const providerStream = await doStream();
                          if (!injectStreamError) return providerStream;
                          const { stream, ...result } = providerStream;
                          let textDeltaCount = 0;
                          return {
                            ...result,
                            stream: stream.pipeThrough(
                              new TransformStream({
                                transform(part, controller) {
                                  controller.enqueue(part);
                                  if (
                                    part.type === "text-delta" &&
                                    ++textDeltaCount >= textDeltaLimit
                                  ) {
                                    controller.enqueue({
                                      type: "error",
                                      error: new Error(
                                        "Chat verification injected model stream failure.",
                                      ),
                                    });
                                    controller.terminate();
                                  }
                                },
                              }),
                            ),
                          };
                        },
                      },
                    });
                    const result = streamText({
                      model,
                      system: chatSystemPrompt,
                      tools: chatModelTools,
                      // Allow tool calls followed by a final text answer.
                      stopWhen: stepCountIs(5),
                      ...{ abortSignal: abort.signal },
                      providerOptions: {
                        openai: {
                          store: false,
                          ...(config.openAiReasoningEffort === undefined
                            ? {}
                            : {
                                reasoningEffort: config.openAiReasoningEffort,
                              }),
                        },
                      },
                      messages: modelMessages,
                      onError: ({ error }) => {
                        streamFailure ??= chatError.anyError(error);
                      },
                    });

                    const stream = toUIMessageStream({
                      stream: result.stream,
                      onError: (error): ChatErrorKey =>
                        error instanceof Error &&
                        error.message.includes("currently overloaded")
                          ? "chat.error.overloaded"
                          : "chat.error.response_failed",
                      originalMessages: turn.messages,
                      generateMessageId: () => turn.assistantMessageId,
                      onFinish: ({ responseMessage, isAborted }) => {
                        if (streamFailure || isAborted) {
                          streamFailure ??= chatError.anyError(
                            new Error("Chat model stream was aborted."),
                          );
                          return;
                        }
                        response = responseMessage;
                      },
                    });
                    const iterator = stream[Symbol.asyncIterator]();
                    while (true) {
                      const nextEvent = await ResultAsync.fromPromise(
                        iterator.next(),
                        chatError.anyError,
                      );
                      if (nextEvent.isErr()) return err(nextEvent.error);
                      if (nextEvent.value.done) break;
                      const event = nextEvent.value.value;
                      if (event.type === "error") {
                        errorEvents.push(
                          chatStreamError(parseChatErrorKey(event.errorText)),
                        );
                        streamFailure ??= chatError.anyError(
                          new Error(
                            "Chat model stream returned an error event.",
                          ),
                        );
                        continue;
                      }
                      // The coordinator emits the final finish/error only after persisting the outcome.
                      if (event.type === "finish") {
                        finishEvent = event;
                      } else {
                        liveStream.publish(event);
                      }
                    }
                    if (errorEvents.length > 0) {
                      return ok({
                        kind: "failed",
                        errorEvents,
                        cause: streamFailure?.cause,
                      });
                    }
                    if (streamFailure) return err(streamFailure);
                    return response && finishEvent
                      ? ok({
                          kind: "completed",
                          message: response,
                          finishEvent,
                        })
                      : err(
                          chatError.anyError(
                            new Error(
                              "Chat model stream completed without a response or finish event.",
                            ),
                          ),
                        );
                  },
                ),
              ]);
              if (generated.status === "rejected") abort.abort();
            } finally {
              clearInterval(heartbeatTimer);
              // A late heartbeat failure is terminal too; never race it with persistence.
              await heartbeat.task;
            }

            const heartbeatFailure = heartbeat.failure;
            if (heartbeatFailure?.kind === "defect") {
              trace.fail(
                "heartbeat",
                "unexpected_exception",
                heartbeatFailure.cause,
              );
              throw heartbeatFailure.cause;
            }
            if (generated.status === "rejected") throw generated.reason;
            if (heartbeatFailure?.kind === "error") {
              trace.fail(
                "heartbeat",
                heartbeatFailure.error.kind,
                "cause" in heartbeatFailure.error
                  ? heartbeatFailure.error.cause
                  : undefined,
              );
              trace.run("publish_error", () =>
                liveStream.publish(
                  chatStreamError("chat.error.response_failed"),
                ),
              );
              return err(heartbeatFailure.error);
            }
            const generationResult = generated.value;
            if (
              generationResult.isErr() ||
              generationResult.value.kind === "failed"
            ) {
              if (
                generationResult.isOk() &&
                generationResult.value.kind === "failed"
              ) {
                trace.fail(
                  "generate_response",
                  "stream_error",
                  generationResult.value.cause,
                );
              }
              const failureResult = await trace.run("save_failure", () =>
                turn.fail(),
              );
              if (failureResult.isErr()) {
                trace.run("publish_error", () =>
                  liveStream.publish(
                    chatStreamError("chat.error.response_failed"),
                  ),
                );
                return failureResult;
              }

              trace.run("publish_error", () => {
                if (generationResult.isErr()) {
                  liveStream.publish(
                    chatStreamError("chat.error.response_failed"),
                  );
                } else if (generationResult.value.kind === "failed") {
                  for (const errorEvent of generationResult.value.errorEvents) {
                    liveStream.publish(errorEvent);
                  }
                }
              });
              return ok();
            }

            const generation = generationResult.value;
            const completionResult = await trace.run("save_response", () =>
              turn.complete(generation.message),
            );
            if (completionResult.isErr()) {
              trace.run("publish_error", () =>
                liveStream.publish(
                  chatStreamError("chat.error.response_failed"),
                ),
              );
              return completionResult;
            }

            trace.run("publish_finish", () =>
              liveStream.publish({
                ...generation.finishEvent,
                messageMetadata: toUIMessageMetadata(
                  "completed",
                  generation.message.metadata,
                ),
              }),
            );
            return ok();
          },
        );
      }),
    );
  }

  return { createAndSend, send, retry };
}
