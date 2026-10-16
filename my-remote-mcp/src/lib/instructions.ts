import { readFileSync } from "node:fs";
import os from "node:os";
import type { ServerConfig } from "./config.ts";

/**
 * Builds the MCP server instructions: tells the model these tools operate on the machine this server
 * runs on (a remote server or the user's own computer), and which one. Machine details are read once at startup.
 */
export function buildServerInstructions(config: ServerConfig): string {
  const name = config.serverName;
  const description = config.serverDescription;
  const user = os.userInfo().username;

  return `This is "${name}" (${description}), an MCP server running on a machine that the user controls.
Machine: ${os.hostname()} — ${describeOperatingSystem()}, ${os.arch()}. User: ${user}. Working directory: ${config.workspaceDir}.

- The read, bash, edit, and write tools act on this machine. Do not assume it is the device the user is chatting from, and do not confuse it with your own sandbox or code-execution environment.
- If several servers are connected, use the tools of the one the user means. This one is "${name}".`;
}

/** Human-readable OS name, e.g. "Ubuntu 24.04.1 LTS" or "macOS 15.4". */
function describeOperatingSystem(): string {
  if (process.platform === "darwin") return `macOS (Darwin ${os.release()})`;
  if (process.platform === "linux") {
    try {
      const prettyName = readFileSync("/etc/os-release", "utf-8").match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1];
      if (prettyName) return `${prettyName} (Linux ${os.release()})`;
    } catch {
      // No os-release file; fall back to the kernel name below.
    }
  }
  return `${os.type()} ${os.release()}`;
}
