import os from "node:os";
import path from "node:path";
import { z } from "zod";

/** Server configuration parsed from environment variables (Bun loads `.env` automatically). */
export interface ServerConfig {
  readonly port: number;
  /** Address the HTTP server listens on, e.g. 127.0.0.1 behind a local proxy or a Docker bridge gateway. */
  readonly host: string;
  /** MCP server name reported to clients and shown in OAuth metadata. */
  readonly serverName: string;
  /** Short description of this server, shown to the model next to its name. */
  readonly serverDescription: string;
  /**
   * Public base URL clients use to reach this server, without a trailing slash; also the OAuth issuer.
   * May include a path prefix (e.g. `https://example.com/my-mcp`) when a reverse proxy strips it.
   */
  readonly publicUrl: string;
  /** Path prefix of `publicUrl` (e.g. `/my-mcp`), or `""` when served at the origin root. */
  readonly publicBasePath: string;
  /** MCP endpoint URL; also the OAuth resource identifier and access-token audience. */
  readonly mcpResourceUrl: URL;
  /** Bun.password hash (argon2id or bcrypt) of the password entered on the authorization page. */
  readonly accessPasswordHash: string;
  /** HMAC key used to sign client IDs, authorization codes, and tokens. */
  readonly tokenSigningKey: Uint8Array;
  /** Directory relative tool paths and shell commands resolve against. */
  readonly workspaceDir: string;
}

const ServerEnvSchema = z.object({
  MCP_SERVER_NAME: z.string().min(1).default("my-remote-mcp"),
  MCP_SERVER_DESCRIPTION: z.string().trim().min(1, "MCP_SERVER_DESCRIPTION is required"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:8787"),
  MCP_ACCESS_PASSWORD_HASH: z
    .string({ error: "MCP_ACCESS_PASSWORD_HASH is required; generate it with `bun run hash-password`" })
    .regex(
      /^\$(argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+|2[aby]\$\d{2})\$/,
      "MCP_ACCESS_PASSWORD_HASH is not an argon2 or bcrypt hash. In .env, every $ must be written as \\$ (Bun expands $ otherwise); `bun run hash-password` prints the escaped line",
    ),
  TOKEN_SIGNING_SECRET: z.string().min(32, "TOKEN_SIGNING_SECRET must be at least 32 characters"),
  WORKSPACE_DIR: z.string().min(1).optional(),
});

/** Parses server configuration from environment variables; throws when variables are missing or invalid. */
export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const parsed = ServerEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid server configuration:\n${z.prettifyError(parsed.error)}`);
  }

  const url = new URL(parsed.data.PUBLIC_URL);
  const publicBasePath = url.pathname.replace(/\/+$/, "");
  const publicUrl = `${url.origin}${publicBasePath}`;

  return {
    port: parsed.data.PORT,
    host: parsed.data.HOST,
    serverName: parsed.data.MCP_SERVER_NAME,
    serverDescription: parsed.data.MCP_SERVER_DESCRIPTION,
    publicUrl,
    publicBasePath,
    mcpResourceUrl: new URL(`${publicUrl}/mcp`),
    accessPasswordHash: parsed.data.MCP_ACCESS_PASSWORD_HASH,
    tokenSigningKey: new TextEncoder().encode(parsed.data.TOKEN_SIGNING_SECRET),
    workspaceDir: path.resolve((parsed.data.WORKSPACE_DIR ?? os.homedir()).replace(/^~(?=$|\/)/, os.homedir())),
  };
}
