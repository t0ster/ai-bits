import { z } from "zod";

const configSchema = z
  .object({
    backendApiKey: z
      .string()
      .min(1)
      .refine((key) => key.trim() === key),
    backendPort: z.coerce.number().int().min(1).max(65535).default(4000),
    databaseUrl: z.url({ protocol: /^(postgres|postgresql)$/ }),
    openAiApiKey: z.string().optional(),
    openAiBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
    openAiModel: z.string().trim().min(1),
    openAiReasoningEffort: z.string().optional(),
    chatVerificationStreamErrorRate: z.coerce.number().min(0).max(1).default(0),
    turnHeartbeatIntervalMs: z.coerce.number().int().positive().default(10_000),
    turnStaleAfterMs: z.coerce.number().int().positive().default(30_000),
  })
  .refine(
    ({ turnHeartbeatIntervalMs, turnStaleAfterMs }) =>
      turnHeartbeatIntervalMs < turnStaleAfterMs,
    { message: "Heartbeat interval must be shorter than stale timeout." },
  );

/** Validated chat backend runtime configuration. */
export const config = configSchema.parse({
  backendApiKey: process.env.BACKEND_API_KEY,
  backendPort: process.env.BACKEND_PORT,
  databaseUrl: process.env.DATABASE_URL,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL,
  openAiModel: process.env.OPENAI_MODEL,
  openAiReasoningEffort: process.env.OPENAI_REASONING_EFFORT,
  chatVerificationStreamErrorRate:
    process.env.CHAT_VERIFICATION_STREAM_ERROR_RATE,
  turnHeartbeatIntervalMs: process.env.TURN_HEARTBEAT_INTERVAL_MS,
  turnStaleAfterMs: process.env.TURN_STALE_AFTER_MS,
});
