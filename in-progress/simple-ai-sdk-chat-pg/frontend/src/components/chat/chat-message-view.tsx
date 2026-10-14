import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { HelpCommand } from "@/components/chat/help-command";
import { ModelToolCall } from "@/components/chat/model-tool-call";
import { TypingIndicator } from "@/components/ui/typing-indicator";
import type { ChatMessage } from "@/lib/chat/types";
import { i18n } from "@/lib/i18n";

/** Renders resolved chat content with streaming and failure presentation. */
export function ChatMessageView({
	message,
	pendingContent,
	isStreaming,
	isGenerating,
	showFailure,
	onFollowUp,
	followUpsDisabled,
}: {
	message: ChatMessage;
	pendingContent: ReactElement | null;
	isStreaming: boolean;
	isGenerating: boolean;
	showFailure: boolean;
	onFollowUp: (prompt: string) => void;
	followUpsDisabled: boolean;
}): ReactElement | null {
	const { t } = useTranslation("translation", { i18n });
	const content = resolveChatMessageContent(message);
	const hasText = message.parts.some(
		(part) => part.type === "text" && part.text.trim().length > 0,
	);
	const hasReasoning = message.parts.some(
		(part) => part.type === "reasoning" && part.text.trim().length > 0,
	);
	const hasToolCall = message.parts.some(isModelToolPart);
	if (
		pendingContent &&
		message.role === "assistant" &&
		!showFailure &&
		(content.kind === "pending" ||
			(content.kind === "standard" &&
				!hasText &&
				!hasReasoning &&
				!hasToolCall))
	) {
		return pendingContent;
	}
	if (
		isGenerating &&
		!showFailure &&
		message.role === "assistant" &&
		(content.kind === "pending" ||
			(content.kind === "standard" &&
				!hasText &&
				!hasReasoning &&
				!hasToolCall))
	) {
		return (
			<Message from="assistant">
				<TypingIndicator />
			</Message>
		);
	}
	if (content.kind === "pending" && !showFailure) return null;

	if (content.kind === "help") {
		return (
			<Message from={message.role}>
				<div className="w-fit min-w-0 max-w-full text-sm text-foreground">
					<HelpCommand onFollowUp={onFollowUp} disabled={followUpsDisabled} />
				</div>
			</Message>
		);
	}

	return (
		<Message from={message.role}>
			<MessageContent>
				{showFailure && !hasText && !hasToolCall ? (
					<span className="text-muted-foreground italic">
						{t("chat.message.response_unavailable")}
					</span>
				) : (
					message.parts.map((part, index) => {
						if (part.type === "reasoning")
							return (
								<Reasoning
									className="w-full"
									// biome-ignore lint/suspicious/noArrayIndexKey: AI SDK parts are append-only and have no IDs; positional keys stay stable while text streams.
									key={`${message.id}-${index}`}
									isStreaming={
										isStreaming && index === message.parts.length - 1
									}
								>
									<ReasoningTrigger />
									<ReasoningContent>{part.text}</ReasoningContent>
								</Reasoning>
							);
						if (isModelToolPart(part))
							return (
								<ModelToolCall
									// biome-ignore lint/suspicious/noArrayIndexKey: AI SDK parts are append-only and have no IDs.
									key={`${message.id}-${index}`}
									part={part}
								/>
							);
						if (part.type !== "text") return null;
						const key = `${message.id}-${index}`;
						return message.role === "assistant" ? (
							<MessageResponse key={key} isAnimating={isStreaming}>
								{part.text}
							</MessageResponse>
						) : (
							<span key={key}>{part.text}</span>
						);
					})
				)}
			</MessageContent>
		</Message>
	);
}

type ChatMessagePart = ChatMessage["parts"][number];
type ModelToolPart = Extract<
	ChatMessagePart,
	{ type: "tool-getCurrentTime" | "tool-rollDice" }
>;

function isModelToolPart(part: ChatMessagePart): part is ModelToolPart {
	return part.type === "tool-getCurrentTime" || part.type === "tool-rollDice";
}

type ChatMessageContent =
	| { readonly kind: "standard" }
	| { readonly kind: "pending" }
	| { readonly kind: "help" };

// A command display part replaces the whole message; model tool parts render inline.
function resolveChatMessageContent(message: ChatMessage): ChatMessageContent {
	const helpPart = message.parts.find((part) => part.type === "tool-help");
	if (!helpPart) return { kind: "standard" };
	if (helpPart.state !== "output-available") return { kind: "pending" };
	return { kind: "help" };
}
