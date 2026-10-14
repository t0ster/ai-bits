import {
  chatCommandSchemas,
  chatModelToolSchemas,
  messageStatusSchema,
} from "@app/shared";
import type { UIMessage } from "ai";
import { z } from "zod";

/** Validates tool parts in UI messages, mirroring the shared `ChatMessage` type. */
export const chatMessageToolPartSchemas = {
  ...chatModelToolSchemas,
  ...chatCommandSchemas,
};

/** Identifies a message within a chat thread. */
export const messageIdSchema = z.string().min(1).brand<"MessageId">();
export type MessageId = z.infer<typeof messageIdSchema>;

export type { MessageStatus } from "@app/shared";
/** Enumerates the durable lifecycle states of a stored chat message. */
export { messageStatusSchema };

/** Supplies the durable conversation and response ID needed for generation. */
export type TurnGenerationInput = {
  messages: UIMessage[];
  assistantMessageId: MessageId;
};

export const userIdSchema = z
  .string()
  .refine(
    (value) => value.trim().length > 0 && !value.startsWith("--"),
    "User ID must not be blank or start with --.",
  );

export const threadIdSchema = z.string().min(1);

const messageTextSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Message must not be blank.");

const uiMessageSchema = z.strictObject({
  id: messageIdSchema,
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const userMessageSchema = uiMessageSchema.refine(
  (message) =>
    message.role === "user" &&
    message.parts.every(
      (part) => part.type === "text" || part.type === "file",
    ) &&
    (message.metadata?.status === undefined ||
      message.metadata.status === "completed") &&
    (message.parts.some((part) => part.type === "file") ||
      messageTextSchema.safeParse(
        message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).success),
  "Message must not be blank.",
);

export const createThreadBodySchema = z.strictObject({
  id: z.uuid(),
  messages: z
    .array(uiMessageSchema)
    .min(1)
    .superRefine((messages, context) => {
      if (messages.at(-1)?.role !== "user") {
        context.addIssue({
          code: "custom",
          message: "Initial history must end with a user message.",
        });
      }
      if (
        new Set(messages.map((message) => message.id)).size !== messages.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Initial message IDs must be unique.",
        });
      }
      for (const [index, message] of messages.entries()) {
        if (message.role !== (index % 2 === 0 ? "user" : "assistant")) {
          context.addIssue({
            code: "custom",
            message: "Initial messages must alternate user and assistant.",
          });
        }
        if (
          message.role === "user" &&
          !userMessageSchema.safeParse(message).success
        ) {
          context.addIssue({
            code: "custom",
            message: "Initial user message is invalid.",
          });
        }
        if (
          message.metadata &&
          "status" in message.metadata &&
          message.metadata.status !== "completed"
        ) {
          context.addIssue({
            code: "custom",
            message: "Initial messages must be completed.",
          });
        }
        if (
          message.role === "assistant" &&
          !message.parts.some(
            (part) =>
              part.type === "text" ||
              part.type === "reasoning" ||
              part.type === "file" ||
              (part.type.startsWith("tool-") &&
                part.state === "output-available"),
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Initial assistant message must have replayable content.",
          });
        }
        if (
          message.role === "assistant" &&
          message.parts.some(
            (part) =>
              part.type.startsWith("tool-") &&
              part.state !== "output-available",
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Initial tool calls must have completed results.",
          });
        }
      }
    }),
});

export const sendMessageSchema = z.strictObject({
  message: userMessageSchema,
});
