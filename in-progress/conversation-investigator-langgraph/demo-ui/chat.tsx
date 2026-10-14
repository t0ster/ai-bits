import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, validateUIMessages } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { chatPath, investigationPath } from "@/lib/routes";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

const pendingSchema = z.object({
  message_id: z.string(),
  message: z.string(),
});
const chatRequestSchema = z.object({
  request_id: z.string().brand<"ChatRequestId">(),
  status: z.enum(["pending", "running", "completed", "failed"]),
});
const historySchema = z.object({
  last_request: chatRequestSchema.nullable(),
  messages: z.array(z.unknown()),
  pending: pendingSchema.nullable(),
});
type ChatRequest = z.infer<typeof chatRequestSchema>;

function ChatConversation({
  threadId,
  initialMessages,
  lastRequest,
}: {
  threadId: string;
  initialMessages: UIMessage[];
  lastRequest: ChatRequest | null;
}) {
  const [input, setInput] = useState("");
  const lastSavedMessage = initialMessages.at(-1);
  const reconnect =
    lastRequest !== null &&
    lastRequest.status !== "completed" &&
    lastSavedMessage?.role === "user";
  const [transport] = useState(() => {
    const requests = new Map<string, string>();
    if (reconnect && lastRequest && lastSavedMessage)
      requests.set(lastSavedMessage.id, lastRequest.request_id);
    return new DefaultChatTransport({
      api: "/api/chat/send",
      prepareSendMessagesRequest: ({ id, messages }) => {
        const message = messages.at(-1);
        if (!message || message.role !== "user")
          throw new Error("Chat submission requires a user message");
        const requestId = requests.get(message.id) ?? crypto.randomUUID();
        requests.set(message.id, requestId);
        return {
          body: {
            thread_id: id,
            request_id: requestId,
            message_id: message.id,
            message: message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          },
        };
      },
    });
  });
  const { messages, sendMessage, regenerate, status, error } = useChat({
    id: threadId,
    messages: initialMessages,
    transport,
  });
  const resumed = useRef(false);
  useEffect(() => {
    // Failed requests reconnect too, so the stream restores the error after refresh.
    if (reconnect && !resumed.current) {
      resumed.current = true;
      void regenerate();
    }
  }, [reconnect, regenerate]);
  const busy = status === "submitted" || status === "streaming";
  const lastMessage = messages.at(-1);
  const replyVisible =
    lastMessage?.role === "assistant" &&
    lastMessage.parts.some(
      (part) => part.type === "text" && part.text.length > 0,
    );
  return (
    <>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 && (
            <ConversationEmptyState
              title="Start a conversation"
              description="Messages are saved. Refresh to pick up where you left off."
            />
          )}
          {messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                {message.parts.map((part, index) =>
                  part.type === "text" ? (
                    <MessageResponse key={index}>{part.text}</MessageResponse>
                  ) : null,
                )}
              </MessageContent>
            </Message>
          ))}
          {busy && !replyVisible && (
            <p className="text-sm text-muted-foreground">Generating…</p>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {/* TODO: Retry only reattaches/replays; for a failed request it replays the
          same failure instead of re-running the model. */}
      {error && (
        <div role="alert" className="px-6 text-red-700">
          Could not complete the reply.
          <button
            type="button"
            className="ml-3 rounded-lg border px-4 py-2"
            onClick={() => void regenerate()}
          >
            Retry
          </button>
        </div>
      )}
      <form
        className="flex gap-3 border-t p-5"
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || busy) return;
          setInput("");
          void sendMessage({ text });
        }}
      >
        <input
          aria-label="Message"
          className="flex-1 rounded-lg border bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-gray-300"
          placeholder="Ask anything…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
        />
        <button
          className="rounded-lg bg-gray-900 px-5 text-white disabled:opacity-40"
          disabled={busy || !input.trim()}
        >
          Send
        </button>
      </form>
    </>
  );
}

/** Chat screen with saved history and live replies. */
export function Chat({ threadId }: { readonly threadId: string }) {
  const [history, setHistory] = useState<UIMessage[] | null>(null);
  const [error, setError] = useState(false);
  const [lastRequest, setLastRequest] = useState<ChatRequest | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function loadHistory() {
      try {
        const response = await fetch(
          `/api/chat/${encodeURIComponent(threadId)}/history`,
          { signal: controller.signal },
        );
        if (response.status === 404) {
          setLastRequest(null);
          setHistory([]);
          return;
        }
        if (!response.ok) {
          setError(true);
          return;
        }
        const data = historySchema.parse(await response.json());
        const messages =
          data.messages.length === 0
            ? []
            : await validateUIMessages({ messages: data.messages });
        if (
          data.pending &&
          !messages.some((message) => message.id === data.pending?.message_id)
        ) {
          messages.push({
            id: data.pending.message_id,
            role: "user",
            parts: [{ type: "text", text: data.pending.message }],
          });
        }
        setLastRequest(data.last_request);
        setHistory(messages);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void loadHistory();
    return () => controller.abort();
  }, [threadId]);
  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col border-x bg-white">
      <header className="flex items-center justify-between border-b px-6 py-5">
        <div>
          <h1 className="font-semibold">Chat demo</h1>
          <p className="text-sm text-muted-foreground">
            A conversation that stays with you
          </p>
        </div>
        <nav className="flex gap-2" aria-label="Demo navigation">
          <Button variant="ghost" asChild>
            <a href={investigationPath()}>Investigations</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={chatPath()}>New chat</a>
          </Button>
        </nav>
      </header>
      {error ? (
        <p role="alert" className="p-6">
          Could not load history. Check that the demo API is running, then
          refresh.
        </p>
      ) : history === null ? (
        <p className="p-6">Loading conversation…</p>
      ) : (
        <ChatConversation
          threadId={threadId}
          initialMessages={history}
          lastRequest={lastRequest}
        />
      )}
    </main>
  );
}
