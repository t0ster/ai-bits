import {
	type ChatErrorKey,
	chatStreamError,
	parseChatErrorKey,
	readChatErrorKey,
} from "@app/shared/i18n";
import { DefaultChatTransport, type UIMessageChunk } from "ai";
import type { ChatMessage } from "./types";

/** Parses HTTP/SSE error keys and reports confirmed generation failures to the UI. */
export class ChatTransport extends DefaultChatTransport<ChatMessage> {
	constructor(
		private readonly onServerFailure: (key: ChatErrorKey) => void,
		initiallyCreated = true,
	) {
		let created = initiallyCreated;
		super({
			fetch: Object.assign(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const response = await fetch(input, init);
					if (!response.ok) throw new Error(await readChatErrorKey(response));
					return response;
				},
				// Bun's fetch type requires this property; browsers leave it unused.
				{ preconnect: fetch.preconnect },
			),
			api: "/api/threads/send",
			prepareSendMessagesRequest: ({ messages, trigger }) => {
				if (trigger === "regenerate-message") {
					return {
						api: "/api/threads/retry",
						body: {},
					};
				}
				if (!created) {
					return {
						api: "/api/threads/",
						body: { messages },
					};
				}
				return {
					api: "/api/threads/send",
					body: { message: messages.at(-1) },
				};
			},
		});
		this.markCreated = () => {
			created = true;
		};
	}

	private readonly markCreated: () => void;

	protected override processResponseStream(
		stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
	): ReadableStream<UIMessageChunk> {
		this.markCreated();
		let finished = false;
		const reader = super.processResponseStream(stream).getReader();
		const onServerFailure = this.onServerFailure;

		return new ReadableStream<UIMessageChunk>({
			async pull(controller) {
				try {
					const { done, value: chunk } = await reader.read();
					if (done) {
						if (!finished) {
							controller.error(
								new Error(
									"chat.error.stream_interrupted" satisfies ChatErrorKey,
								),
							);
							return;
						}
						controller.close();
						return;
					}
					if (chunk.type === "finish") {
						finished = true;
					} else if (chunk.type === "error") {
						finished = true;
						const key = parseChatErrorKey(chunk.errorText);
						onServerFailure(key);
						controller.enqueue(chatStreamError(key));
						return;
					}
					controller.enqueue(chunk);
				} catch (error) {
					controller.error(error);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		});
	}
}
