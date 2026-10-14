import { chatErrorBody } from "@app/shared/i18n";
import { createFileRoute } from "@tanstack/react-router";
import {
	fetchChatBackend,
	forwardChatBackendResponse,
} from "@/lib/chat/api-client.server";
import { getSessionThreadId } from "@/lib/session.server";

export const Route = createFileRoute("/api/threads/send")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const threadId = await getSessionThreadId();
				if (!threadId) {
					return Response.json(chatErrorBody("chat.error.unknown_session"), {
						status: 403,
					});
				}
				const body = await request.arrayBuffer();
				const contentType = request.headers.get("content-type");
				const response = await fetchChatBackend(
					`/threads/${encodeURIComponent(threadId)}/send`,
					{
						body,
						headers: contentType ? { "Content-Type": contentType } : undefined,
						method: "POST",
					},
				);
				return forwardChatBackendResponse(response);
			},
		},
	},
});
