import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { parseServerConfig, type ServerConfig } from "./lib/config.ts";
import { createPasswordOAuth } from "./lib/password-oauth.ts";
import { buildServerInstructions } from "./lib/instructions.ts";
import { registerTools } from "./tools.ts";

/** Builds the MCP server and its tools; called once per MCP request. */
function createMcpServer(config: ServerConfig, instructions: string): McpServer {
  const server = new McpServer({ name: config.serverName, version: "0.1.0" }, { instructions });
  registerTools(server, config.workspaceDir);
  return server;
}

/** Starts the MCP server behind password-protected OAuth. */
export function startMcpServer(config: ServerConfig) {
  const oauth = createPasswordOAuth(config, { resourceName: config.serverName });
  const instructions = buildServerInstructions(config);
  const mcp = createMcpHandler(() => createMcpServer(config, instructions));

  return Bun.serve({
    hostname: config.host,
    port: config.port,
    routes: {
      ...oauth.routes,
      "/mcp": oauth.requireAccessToken((request, authInfo) => mcp.fetch(request, { authInfo })),
      // Some clients (claude.ai's connector check) probe the origin root before connecting
      // and report "No server responded" on a 404.
      "/": new Response(`${config.serverName} MCP server: ${config.mcpResourceUrl.href}\n`),
      "/health": new Response("ok"),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}

if (import.meta.main) {
  const config = parseServerConfig(process.env);
  const server = startMcpServer(config);
  console.log(`MCP server listening on ${config.host}:${server.port}; endpoint ${config.mcpResourceUrl.href} (tools in ${config.workspaceDir})`);
}
