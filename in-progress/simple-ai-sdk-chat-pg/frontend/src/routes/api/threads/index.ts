import { chatErrorBody } from "@app/shared/i18n";
import { createFileRoute } from "@tanstack/react-router";
import {
	fetchChatBackend,
	forwardChatBackendResponse,
} from "@/lib/chat/api-client.server";
import { setSessionThreadId } from "@/lib/session.server";

export const Route = createFileRoute("/api/threads/")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const body = await request.json().catch(() => null);
				if (
					typeof body !== "object" ||
					body === null ||
					!Array.isArray(body.messages)
				) {
					return Response.json(
						chatErrorBody("chat.error.invalid_thread_creation"),
						{ status: 400 },
					);
				}
				const createdThreadId = crypto.randomUUID();
				const response = await fetchChatBackend("/threads", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: createdThreadId,
						messages: body.messages,
					}),
				});
				// The backend requires a caller-supplied ID; Start owns it, not the browser.
				if (response.ok) {
					// Keep the generated ID available for the session's next send or retry.
					await setSessionThreadId(createdThreadId);
				}
				return forwardChatBackendResponse(response);
			},
		},
	},
});
