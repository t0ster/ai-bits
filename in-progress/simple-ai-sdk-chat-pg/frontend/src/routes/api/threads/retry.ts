import { chatErrorBody } from "@app/shared/i18n";
import { createFileRoute } from "@tanstack/react-router";
import {
	fetchChatBackend,
	forwardChatBackendResponse,
} from "@/lib/chat/api-client.server";
import { getSessionThreadId } from "@/lib/session.server";

export const Route = createFileRoute("/api/threads/retry")({
	server: {
		handlers: {
			POST: async () => {
				const threadId = await getSessionThreadId();
				if (!threadId) {
					return Response.json(chatErrorBody("chat.error.unknown_session"), {
						status: 403,
					});
				}
				const response = await fetchChatBackend(
					`/threads/${encodeURIComponent(threadId)}/retry`,
					{ method: "POST" },
				);
				return forwardChatBackendResponse(response);
			},
		},
	},
});
