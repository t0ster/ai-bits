import type { ThreadDetailResponse, ThreadListItemResponse } from "@app/shared";
import { readChatErrorKey } from "@app/shared/i18n";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getSessionThreadId, setSessionThreadId } from "../session.server";
import { fetchChatBackend, readChatBackendJson } from "./api-client.server";

/** Lists durable threads owned by the current local user. */
export const listThreads = createServerFn({ method: "GET" }).handler(
	async (): Promise<ThreadListItemResponse[]> => {
		return readChatBackendJson<ThreadListItemResponse[]>("/threads");
	},
);

/** Loads the selected thread, or returns null without creating a thread. */
export const loadSessionChat = createServerFn({
	method: "GET",
	strict: { output: false },
}).handler(async (): Promise<ThreadDetailResponse | null> => {
	setResponseHeader("Cache-Control", "private, no-store");
	const threadId = await getSessionThreadId();
	if (!threadId) return null;
	const response = await fetchChatBackend(
		`/threads/${encodeURIComponent(threadId)}`,
	);
	if (response.status === 404) {
		await setSessionThreadId(null);
		return null;
	}
	if (!response.ok) {
		throw new Error(await readChatErrorKey(response));
	}
	// SAFETY: The authenticated chat backend owns this JSON contract.
	return (await response.json()) as ThreadDetailResponse;
});

/** Clears the selected thread without creating a replacement. */
export const startNewSessionChat = createServerFn({ method: "POST" }).handler(
	async (): Promise<void> => {
		setResponseHeader("Cache-Control", "private, no-store");
		await setSessionThreadId(null);
	},
);
