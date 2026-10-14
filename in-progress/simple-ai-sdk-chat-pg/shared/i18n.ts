import { createInstance, type i18n } from "i18next";
import { z } from "zod";

const chatErrorMessages = {
	"chat.error.overloaded":
		"The AI service is currently overloaded. Please try again later.",
	"chat.error.response_failed": "Assistant response failed. Please try again.",
	"chat.error.request_failed":
		"Request failed. Reload chat before sending again.",
	"chat.error.thread_not_found": "Thread not found.",
	"chat.error.thread_id_unavailable": "This thread ID is unavailable.",
	"chat.error.message_id_conflict": "This message ID is already in use.",
	"chat.error.generation_in_progress":
		"This response is already being generated.",
	"chat.error.failed_turn_requires_retry":
		"The last response failed. Please try again.",
	"chat.error.retry_not_allowed":
		"Only the latest failed response can be retried.",
	"chat.error.turn_no_longer_pending":
		"This response is no longer pending. Reload chat.",
	"chat.error.operation_failed":
		"Chat is temporarily unavailable. Please try again later.",
	"chat.error.user_id_required": "Your chat session is missing. Reload chat.",
	"chat.error.unauthorized": "You do not have access to this chat.",
	"chat.error.invalid_message_history":
		"The message history is invalid. Reload chat.",
	"chat.error.stored_messages_invalid":
		"The saved conversation could not be loaded.",
	"chat.error.user_message_required": "Enter a message before sending.",
	"chat.error.not_found": "The requested chat resource was not found.",
	"chat.error.invalid_request": "The chat request is invalid. Reload chat.",
	"chat.error.unknown_session": "Your chat session was not found. Reload chat.",
	"chat.error.invalid_thread_creation":
		"The new chat request is invalid. Please try again.",
	"chat.error.new_thread_failed":
		"Could not start a new chat. Please try again.",
	"chat.error.stream_interrupted":
		"The connection was interrupted. Reload chat to check the response.",
} as const;

/** English chat resources are the source of truth for translation keys. */
export const chatTranslationResources = {
	en: {
		translation: {
			...chatErrorMessages,
			"chat.action.retry": "Try again",
			"chat.action.reload": "Reload chat",
			"chat.action.reconnect": "Attempt to reconnect",
			"chat.message.response_unavailable": "Unable to generate a response.",
		},
	},
} as const;

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		keySeparator: false;
		strictKeyChecks: true;
		resources: typeof chatTranslationResources.en;
	}
}

/** Only error keys, not arbitrary translation keys, may cross error boundaries. */
export type ChatErrorKey = keyof typeof chatErrorMessages;

/** Validates untrusted keys without admitting raw provider messages. */
export const chatErrorKeySchema = z.custom<ChatErrorKey>(
	(value) =>
		typeof value === "string" && Object.hasOwn(chatErrorMessages, value),
);

/** HTTP error payload shared by the backend, frontend proxy, and CLI. */
export const chatErrorResponseSchema = z.object({ error: chatErrorKeySchema });

/** AI SDK error event constrained to the shared error-key vocabulary. */
export type ChatStreamError = {
	readonly type: "error";
	readonly errorText: ChatErrorKey;
};

/** Constructs an HTTP error body with a compile-time checked translation key. */
export function chatErrorBody(
	error: ChatErrorKey,
): z.infer<typeof chatErrorResponseSchema> {
	return { error };
}

/** Constructs an AI SDK error event with a compile-time checked translation key. */
export function chatStreamError(errorText: ChatErrorKey): ChatStreamError {
	return { type: "error", errorText };
}

/** Unknown or malformed stream errors always fall back to safe generic copy. */
export function parseChatErrorKey(
	value: unknown,
	fallback: ChatErrorKey = "chat.error.response_failed",
): ChatErrorKey {
	const parsed = chatErrorKeySchema.safeParse(value);
	return parsed.success ? parsed.data : fallback;
}

/** Reads an HTTP error key; invalid JSON and unrecognized payloads remain private. */
export async function readChatErrorKey(
	response: Response,
): Promise<ChatErrorKey> {
	const body: unknown = await response.json().catch(() => null);
	const parsed = chatErrorResponseSchema.safeParse(body);
	return parsed.success ? parsed.data.error : "chat.error.request_failed";
}

/** Creates isolated language state; bundled resources need no asynchronous loading. */
export function createAppI18n(
	language: keyof typeof chatTranslationResources,
): i18n {
	const instance = createInstance();
	void instance.init({
		lng: language,
		fallbackLng: "en",
		resources: chatTranslationResources,
		keySeparator: false,
		initAsync: false,
		interpolation: { escapeValue: false },
	});
	return instance;
}
