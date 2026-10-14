import type { ChatMessage, ChatMessageMetadata } from "@app/shared";

/** Durable lifecycle metadata attached to messages returned by the backend. */
export type { ChatMessage, ChatMessageMetadata } from "@app/shared";

/** Returns the durable state of the latest assistant response, when present. */
export function getLatestAssistantStatus(
	messages: ChatMessage[],
): ChatMessageMetadata["status"] | undefined {
	const latestMessage = messages.at(-1);
	return latestMessage?.role === "assistant"
		? latestMessage.metadata?.status
		: undefined;
}
