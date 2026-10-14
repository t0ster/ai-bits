import type { InferUITools, UIMessage } from "ai";
import { z } from "zod";

/** Durable lifecycle states of a stored chat message. */
export const messageStatusSchema = z.enum(["pending", "completed", "failed"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** Metadata on a durable chat message. */
export type ChatMessageMetadata = { status: MessageStatus };

/** Wire representation of a listed chat thread. */
export type ThreadListItemResponse = {
	id: string;
	user_id: string;
	created_at: string;
};

/** Tools the model may call; the backend binds their execute functions. */
export const chatModelToolSchemas = {
	getCurrentTime: {
		inputSchema: z.object({
			timeZone: z
				.string()
				.describe(
					"IANA time zone, for example Europe/Kyiv. Use UTC if unknown.",
				),
		}),
		outputSchema: z.object({
			timeZone: z.string(),
			iso: z.string(),
			formatted: z.string(),
		}),
	},
	rollDice: {
		inputSchema: z.object({
			count: z.number().int().min(1).max(20).describe("Number of dice."),
			sides: z.number().int().min(2).max(100).describe("Sides per die."),
		}),
		outputSchema: z.object({
			rolls: z.array(z.number().int()),
			total: z.number().int(),
		}),
	},
};

/** Deterministic slash-command display parts; never advertised to the model. */
export const chatCommandSchemas = {
	help: {
		inputSchema: z.object({}),
		outputSchema: z.object({ status: z.literal("ok") }),
	},
};

/** Chat messages returned by the backend with validated status and tool parts. */
export type ChatMessage = UIMessage<
	ChatMessageMetadata,
	never,
	InferUITools<typeof chatModelToolSchemas> &
		InferUITools<typeof chatCommandSchemas>
>;

/** Wire representation of a loaded chat thread. */
export type ThreadDetailResponse = ThreadListItemResponse & {
	messages: ChatMessage[];
};
