import { parseChatErrorKey } from "@app/shared/i18n";
import {
	createFileRoute,
	type ErrorComponentProps,
} from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatThread } from "@/components/chat-thread";
import { Button } from "@/components/ui/button";
import { loadSessionChat } from "@/lib/chat/server";
import { i18n } from "@/lib/i18n";

/** Chat page; visitor-specific thread data must never be cached. */
export const Route = createFileRoute("/")({
	loader: () => loadSessionChat(),
	headers: () => ({ "Cache-Control": "private, no-store" }),
	gcTime: 0,
	component: SessionChat,
	errorComponent: ChatPageError,
});

function ChatPageError({ error }: ErrorComponentProps) {
	const { t } = useTranslation("translation", { i18n });
	const errorKey = parseChatErrorKey(
		error instanceof Error ? error.message : undefined,
		"chat.error.request_failed",
	);
	return (
		<main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-4 text-foreground">
			<p role="alert">{t(errorKey)}</p>
			<Button onClick={() => window.location.reload()}>
				{t("chat.action.reload")}
			</Button>
		</main>
	);
}

function SessionChat() {
	const thread = Route.useLoaderData();
	const [newChatVersion, setNewChatVersion] = useState(0);
	return (
		// Suppress page bounce so scroll gestures stay with the messages.
		<main className="disable-page-overscroll flex h-dvh min-h-0 flex-col bg-background text-foreground">
			<ChatThread
				initialThread={thread}
				key={thread?.id ?? newChatVersion}
				onNewThread={() => setNewChatVersion((version) => version + 1)}
			/>
		</main>
	);
}
