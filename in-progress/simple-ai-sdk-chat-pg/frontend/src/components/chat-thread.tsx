import { useChat } from "@ai-sdk/react";
import type { ThreadDetailResponse } from "@app/shared";
import { type ChatErrorKey, parseChatErrorKey } from "@app/shared/i18n";
import { useRouter } from "@tanstack/react-router";
import { AlertCircleIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStickToBottom } from "use-stick-to-bottom";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message } from "@/components/ai-elements/message";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { ChatMessageView } from "@/components/chat/chat-message-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TypingIndicator } from "@/components/ui/typing-indicator";
import { ChatTransport } from "@/lib/chat/ai-sdk-transport";
import { loadSessionChat, startNewSessionChat } from "@/lib/chat/server";
import { type ChatMessage, getLatestAssistantStatus } from "@/lib/chat/types";
import { i18n } from "@/lib/i18n";

/** Renders the chat using AI SDK messages and the current thread selection. */
export function ChatThread({
	initialThread,
	onNewThread,
}: {
	initialThread: ThreadDetailResponse | null;
	onNewThread: () => void;
}) {
	const { t } = useTranslation("translation", { i18n });
	const conversationScroll = useStickToBottom({
		initial: "smooth",
		resize: "smooth",
	});
	const initialStatus = getLatestAssistantStatus(initialThread?.messages ?? []);
	const threadExists = initialThread !== null;
	const [waitingForPendingResponse, setWaitingForPendingResponse] = useState(
		initialStatus === "pending",
	);
	const [confirmedFailure, setConfirmedFailure] = useState(
		initialStatus === "failed",
	);
	const [failureKey, setFailureKey] = useState<ChatErrorKey>(
		"chat.error.response_failed",
	);
	const [reconnectNeeded, setReconnectNeeded] = useState(false);
	const [startingNewThread, setStartingNewThread] = useState(false);
	const [newThreadError, setNewThreadError] = useState(false);
	const router = useRouter();
	const handleServerFailure = useCallback((key: ChatErrorKey) => {
		setFailureKey(key);
		setConfirmedFailure(true);
	}, []);

	const transport = useMemo(
		() => new ChatTransport(handleServerFailure, threadExists),
		[handleServerFailure, threadExists],
	);
	const {
		clearError,
		error,
		messages,
		regenerate,
		sendMessage,
		setMessages,
		status,
	} = useChat<ChatMessage>({
		messages: initialThread?.messages ?? [],
		transport,
	});

	const reconcileDurableThread = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const thread = await loadSessionChat();
				if (signal?.aborted) {
					return false;
				}
				if (!thread) {
					setReconnectNeeded(true);
					return false;
				}
				setReconnectNeeded(false);
				const durableStatus = getLatestAssistantStatus(thread.messages);
				if (durableStatus === "pending") {
					return false;
				}
				setMessages(thread.messages);
				setConfirmedFailure(durableStatus === "failed");
				setFailureKey("chat.error.response_failed");
				setWaitingForPendingResponse(false);
				clearError();
				return true;
			} catch {
				if (!signal?.aborted) {
					setReconnectNeeded(true);
				}
				return false;
			}
		},
		[clearError, setMessages],
	);

	useEffect(() => {
		if (!waitingForPendingResponse) {
			return;
		}
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			const settled = await reconcileDurableThread(controller.signal);
			if (!controller.signal.aborted && !settled) {
				timer = setTimeout(poll, 1500);
			}
		};
		void poll();
		return () => {
			controller.abort();
			if (timer) {
				clearTimeout(timer);
			}
		};
	}, [reconcileDurableThread, waitingForPendingResponse]);

	const actionsDisabled =
		waitingForPendingResponse ||
		status === "submitted" ||
		status === "streaming";
	const requestFailed = Boolean(error) && !confirmedFailure;
	const assistantIsGenerating =
		!waitingForPendingResponse &&
		(status === "submitted" || status === "streaming") &&
		!confirmedFailure &&
		!error;
	const pendingResponseCard = waitingForPendingResponse ? (
		<Alert>
			<LoaderCircleIcon className="animate-spin" />
			<AlertTitle>Working</AlertTitle>
			<AlertDescription>
				This response is still being generated. Waiting for it to finish…
				{reconnectNeeded && (
					<Button
						className="mt-3"
						onClick={() => void reconcileDurableThread()}
						size="sm"
						variant="outline"
					>
						<RotateCwIcon />
						{t("chat.action.reconnect")}
					</Button>
				)}
			</AlertDescription>
		</Alert>
	) : null;

	async function handleRetry() {
		setConfirmedFailure(false);
		setFailureKey("chat.error.response_failed");
		clearError();
		await regenerate();
	}

	async function handleNewThread() {
		setStartingNewThread(true);
		setNewThreadError(false);
		try {
			await startNewSessionChat();
			onNewThread();
			await router.invalidate();
		} catch {
			setNewThreadError(true);
		} finally {
			setStartingNewThread(false);
		}
	}

	function sendFollowUp(prompt: string) {
		if (
			actionsDisabled ||
			requestFailed ||
			confirmedFailure ||
			startingNewThread
		)
			return;
		void conversationScroll.scrollToBottom();
		setConfirmedFailure(false);
		void sendMessage({
			parts: [{ type: "text", text: prompt }],
			role: "user",
		}).catch(() => {
			// useChat reports request failures through its error state.
		});
	}

	return (
		<PromptInputProvider>
			<div className="flex min-h-0 flex-1 flex-col">
				<header className="mx-auto w-full max-w-3xl shrink-0 border-b py-3">
					<div className="relative mx-auto flex w-full max-w-3xl items-center justify-between px-4">
						<span className="text-lg font-semibold tracking-tight">
							Simple AI SDK Chat
						</span>
						<div className="flex items-center gap-2">
							<Button
								disabled={actionsDisabled || startingNewThread}
								onClick={() => void handleNewThread()}
								size="sm"
								variant="ghost"
							>
								{startingNewThread ? (
									<Spinner />
								) : (
									<RotateCwIcon aria-hidden="true" />
								)}
								Start over
							</Button>
						</div>
					</div>
				</header>
				{newThreadError && (
					<p className="px-4 py-2 text-destructive text-sm" role="alert">
						{t("chat.error.new_thread_failed")}
					</p>
				)}
				<Conversation className="bg-background" instance={conversationScroll}>
					<ConversationContent
						className="mx-auto w-full max-w-3xl"
						scrollClassName="overflow-auto overscroll-y-contain"
					>
						{messages.length === 0 ? (
							<ConversationEmptyState
								description="Send a message, or type /help to see what this demo can do."
								title="New chat"
							/>
						) : (
							messages.map((message, index) => (
								<ChatMessageView
									key={message.id}
									message={message}
									pendingContent={
										index === messages.length - 1 ? pendingResponseCard : null
									}
									isGenerating={
										assistantIsGenerating && index === messages.length - 1
									}
									isStreaming={
										status === "streaming" && index === messages.length - 1
									}
									showFailure={
										confirmedFailure &&
										!messages
											.slice(index + 1)
											.some((later) => later.role === "assistant")
									}
									onFollowUp={sendFollowUp}
									followUpsDisabled={
										actionsDisabled ||
										requestFailed ||
										confirmedFailure ||
										startingNewThread
									}
								/>
							))
						)}

						{messages.at(-1)?.role !== "assistant" &&
							(pendingResponseCard ??
								(assistantIsGenerating && (
									<Message from="assistant">
										<TypingIndicator />
									</Message>
								)))}

						{confirmedFailure && (
							<div
								className="flex min-w-64 items-center gap-2 py-1 text-sm"
								role="alert"
							>
								<AlertCircleIcon className="size-4 shrink-0 text-destructive" />
								<span className="text-muted-foreground">{t(failureKey)}</span>
								<Button
									className="ml-1 h-7"
									disabled={actionsDisabled || startingNewThread}
									onClick={() => void handleRetry()}
									size="sm"
									variant="outline"
								>
									{t("chat.action.retry")}
								</Button>
							</div>
						)}

						{requestFailed && !waitingForPendingResponse && (
							<div
								className="flex flex-wrap items-center gap-3 text-destructive text-sm"
								role="alert"
							>
								<span>
									{t(
										parseChatErrorKey(
											error?.message,
											"chat.error.request_failed",
										),
									)}
								</span>
								<Button
									onClick={() => window.location.reload()}
									size="sm"
									variant="outline"
								>
									{t("chat.action.reload")}
								</Button>
							</div>
						)}
					</ConversationContent>
					<ConversationScrollButton aria-label="Scroll to latest message" />
				</Conversation>

				<div className="mx-auto w-full max-w-3xl shrink-0 border-t bg-background p-4">
					<PromptInput
						className="mx-auto max-w-3xl **:data-[slot=input-group]:flex-row! md:**:data-[slot=input-group]:flex-col!"
						onSubmit={({ text }, event) => {
							if (
								!text.trim() ||
								actionsDisabled ||
								requestFailed ||
								startingNewThread
							) {
								return;
							}
							// Keep focus on the composer when the submit button becomes disabled.
							if (event.target instanceof HTMLFormElement) {
								event.target.querySelector("textarea")?.focus();
							}
							setConfirmedFailure(false);
							void sendMessage({
								parts: [{ text, type: "text" }],
								role: "user",
							}).catch(() => {
								// useChat reports request failures through its error state.
							});
						}}
					>
						<PromptInputBody>
							<PromptInputTextarea
								aria-label="Message"
								className="min-w-0 min-h-0 md:min-h-16"
								readOnly={
									actionsDisabled ||
									startingNewThread ||
									confirmedFailure ||
									requestFailed
								}
								placeholder="Ask anything. Try /help."
								rows={1}
							/>
						</PromptInputBody>
						<PromptInputFooter className="mb-0.5 w-auto self-end pb-1.5 md:mb-0 md:w-full md:self-auto md:pb-3">
							<span className="hidden text-muted-foreground text-xs md:inline">
								Enter to send · Shift+Enter for a new line
							</span>
							<PromptInputSubmit
								disabled={
									actionsDisabled ||
									startingNewThread ||
									confirmedFailure ||
									requestFailed
								}
								status={status}
							>
								{status === "submitted" ? <Spinner /> : undefined}
							</PromptInputSubmit>
						</PromptInputFooter>
					</PromptInput>
				</div>
			</div>
		</PromptInputProvider>
	);
}
