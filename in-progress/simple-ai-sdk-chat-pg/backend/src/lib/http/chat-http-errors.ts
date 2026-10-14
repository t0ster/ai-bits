import type { ChatErrorKey } from "@app/shared/i18n";
import { HTTPError } from "h3";
import { type ChatError, Defect } from "@/errors";

/** Creates an HTTP error whose public message is a validated translation key. */
export function createChatHttpError(
  key: ChatErrorKey,
  status: number,
): HTTPError {
  return new HTTPError(key, { status });
}

/** Translates an application chat error into an HTTP response error. */
export function throwHttpChatError(error: ChatError): never {
  switch (error.kind) {
    case "thread_not_found":
      throw createChatHttpError("chat.error.thread_not_found", 404);
    case "thread_id_unavailable":
      throw createChatHttpError("chat.error.thread_id_unavailable", 409);
    case "message_id_conflict":
      throw createChatHttpError("chat.error.message_id_conflict", 409);
    case "generation_in_progress":
      throw createChatHttpError("chat.error.generation_in_progress", 409);
    case "failed_turn_requires_retry":
      throw createChatHttpError("chat.error.failed_turn_requires_retry", 409);
    case "retry_not_allowed":
      throw createChatHttpError("chat.error.retry_not_allowed", 409);
    case "turn_no_longer_pending":
      throw createChatHttpError("chat.error.turn_no_longer_pending", 409);
    case "any_error":
      throw createChatHttpError("chat.error.operation_failed", 503);
    default: {
      const unhandled: never = error;
      throw new Defect(
        `Chat error presentation missing for: ${String(unhandled)}`,
      );
    }
  }
}
