import { chatErrorBody, readChatErrorKey } from "@app/shared/i18n";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getOrCreateChatUserId } from "../session.server";

const backendApiKey = process.env.BACKEND_API_KEY;
if (!backendApiKey || backendApiKey.trim() !== backendApiKey) {
	throw new Error(
		"Chat frontend configuration invalid: set a nonempty BACKEND_API_KEY without surrounding whitespace.",
	);
}
function getBackendUrl(): string {
	const url = process.env.BACKEND_URL;
	if (!url || !/^https?:\/\/[^/]+\/?$/.test(url)) {
		throw new Error(
			"Chat frontend configuration invalid: set BACKEND_URL to an HTTP(S) backend origin.",
		);
	}
	return url.replace(/\/$/, "");
}

/** Proxies an owned-thread request from TanStack Start to the chat backend. */
export async function fetchChatBackend(
	path: string,
	init?: RequestInit,
): Promise<Response> {
	setResponseHeader("Cache-Control", "private, no-store");
	return fetch(`${getBackendUrl()}${path}`, {
		...init,
		headers: {
			...Object.fromEntries(new Headers(init?.headers)),
			Authorization: `Bearer ${backendApiKey}`,
			"X-User-Id": await getOrCreateChatUserId(),
		},
	}).catch(() => {
		console.error("Chat backend connection failed.");
		return Response.json(chatErrorBody("chat.error.request_failed"), {
			status: 503,
		});
	});
}

/** Preserves a backend response status, headers, and body stream verbatim. */
export function forwardChatBackendResponse(response: Response): Response {
	return new Response(response.body, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
}

/** Reads a successful backend JSON response or raises its HTTP failure details. */
export async function readChatBackendJson<T>(
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetchChatBackend(path, init);
	if (!response.ok) {
		throw new Error(await readChatErrorKey(response));
	}
	return response.json() as Promise<T>;
}
