import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Coding tools ported from pi's built-in read, bash, edit, and write
// (pi/packages/coding-agent/src/core/tools). Same names, parameters, and output limits.

/** Tool output limits: whichever is hit first wins. */
const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_BASH_TIMEOUT_SECONDS = 24 * 60 * 60;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** Registers the pi-style read, bash, edit, and write tools; relative paths and commands resolve against `workspaceDir`. */
export function registerTools(server: McpServer, workspaceDir: string): void {
  const resolvePath = (filePath: string) =>
    path.resolve(workspaceDir, filePath.replace(/^~(?=$|\/)/, os.homedir()));

  server.registerTool(
    "read",
    {
      description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
      inputSchema: z.object({
        path: z.string().describe("Path to the file to read (relative or absolute)"),
        offset: z.number().int().min(1).optional().describe("Line number to start reading from (1-indexed)"),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path: filePath, offset, limit }) => {
      const absolutePath = resolvePath(filePath);
      await access(absolutePath, constants.R_OK);

      const imageMimeType = IMAGE_MIME_TYPES[path.extname(absolutePath).toLowerCase()];
      if (imageMimeType) {
        const data = (await readFile(absolutePath)).toString("base64");
        return {
          content: [
            { type: "text", text: `Read image file [${imageMimeType}]` },
            { type: "image", data, mimeType: imageMimeType },
          ],
        };
      }

      const allLines = (await readFile(absolutePath, "utf-8")).split("\n");
      const startLine = offset ? offset - 1 : 0;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
      const truncation = truncateHead(allLines.slice(startLine, endLine));
      const firstShown = startLine + 1;
      const lastShown = startLine + truncation.lines.length;

      if (truncation.firstLineTooLong) {
        return textResult(
          `[Line ${firstShown} exceeds the ${formatSize(MAX_OUTPUT_BYTES)} limit. Use bash: sed -n '${firstShown}p' ${filePath} | head -c ${MAX_OUTPUT_BYTES}]`,
        );
      }
      let text = truncation.lines.join("\n");
      if (truncation.truncatedBy === "lines") {
        text += `\n\n[Showing lines ${firstShown}-${lastShown} of ${allLines.length}. Use offset=${lastShown + 1} to continue.]`;
      } else if (truncation.truncatedBy === "bytes") {
        text += `\n\n[Showing lines ${firstShown}-${lastShown} of ${allLines.length} (${formatSize(MAX_OUTPUT_BYTES)} limit). Use offset=${lastShown + 1} to continue.]`;
      } else if (endLine < allLines.length) {
        text += `\n\n[${allLines.length - endLine} more lines in file. Use offset=${endLine + 1} to continue.]`;
      }
      return textResult(text);
    },
  );

  server.registerTool(
    "bash",
    {
      description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        timeout: z
          .number()
          .positive()
          .max(MAX_BASH_TIMEOUT_SECONDS)
          .optional()
          .describe("Timeout in seconds (optional, no default timeout)"),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ command, timeout }, ctx) => {
      const result = await runBashCommand(command, workspaceDir, timeout, ctx.mcpReq.signal);
      let text = result.output || "(no output)";
      const truncation = truncateTail(text.split("\n"));
      if (truncation.truncatedBy) {
        const fullOutputPath = path.join(os.tmpdir(), `my-remote-mcp-bash-${crypto.randomUUID()}.log`);
        await writeFile(fullOutputPath, result.output, "utf-8");
        const firstShown = truncation.totalLines - truncation.lines.length + 1;
        text = `${truncation.lines.join("\n")}\n\n[Showing lines ${firstShown}-${truncation.totalLines} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
      }

      if (result.timedOut) return textResult(`${text}\n\nCommand timed out after ${timeout} seconds`, true);
      if (result.exitCode !== 0) return textResult(`${text}\n\nCommand exited with code ${result.exitCode}`, true);
      return textResult(text);
    },
  );

  server.registerTool(
    "edit",
    {
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file to edit (relative or absolute)"),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .min(1)
                .describe(
                  "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
                ),
              newText: z.string().describe("Replacement text for this targeted edit."),
            }),
          )
          .min(1)
          .describe(
            "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
          ),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ path: filePath, edits }) => {
      const absolutePath = resolvePath(filePath);
      await access(absolutePath, constants.R_OK | constants.W_OK);
      const raw = await readFile(absolutePath, "utf-8");

      // Match against BOM-less, LF-normalized text; restore both on write.
      const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
      const content = raw.slice(bom.length);
      const firstNewline = content.indexOf("\n");
      const lineEnding = firstNewline > 0 && content[firstNewline - 1] === "\r" ? "\r\n" : "\n";
      const normalized = content.replace(/\r\n?/g, "\n");

      const matches = edits.map((edit, index) => {
        const oldText = edit.oldText.replace(/\r\n?/g, "\n");
        const matchIndex = normalized.indexOf(oldText);
        if (matchIndex === -1) throw new Error(`edits[${index}].oldText was not found in ${filePath}.`);
        if (normalized.indexOf(oldText, matchIndex + 1) !== -1) {
          throw new Error(`edits[${index}].oldText matches more than once in ${filePath}; include more context.`);
        }
        return { index, matchIndex, end: matchIndex + oldText.length, newText: edit.newText.replace(/\r\n?/g, "\n") };
      });
      matches.sort((a, b) => a.matchIndex - b.matchIndex);
      for (let i = 1; i < matches.length; i++) {
        const previous = matches[i - 1]!;
        const current = matches[i]!;
        if (current.matchIndex < previous.end) {
          throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap; merge them into one edit.`);
        }
      }

      let updated = normalized;
      for (const match of matches.toReversed()) {
        updated = updated.slice(0, match.matchIndex) + match.newText + updated.slice(match.end);
      }
      await writeFile(absolutePath, bom + (lineEnding === "\r\n" ? updated.replace(/\n/g, "\r\n") : updated), "utf-8");
      return textResult(`Successfully replaced ${edits.length} block(s) in ${filePath}.`);
    },
  );

  server.registerTool(
    "write",
    {
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      inputSchema: z.object({
        path: z.string().describe("Path to the file to write (relative or absolute)"),
        content: z.string().describe("Content to write to the file"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ path: filePath, content }) => {
      const absolutePath = resolvePath(filePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
      return textResult(`Successfully wrote to ${filePath}`);
    },
  );
}

/** Builds a text tool result; `isError` marks it as a failed call for the model. */
export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/** Runs a command with bash in its own process group so timeouts and cancellation kill the whole tree. */
function runBashCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number | undefined,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let timedOut = false;
    const killTree = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process group already exited.
        }
      }
    };
    const timer =
      timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killTree();
          }, timeoutSeconds * 1000);
    signal.addEventListener("abort", killTree, { once: true });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", killTree);
      reject(error);
    });
    // "exit" rather than "close": detached descendants may keep the pipes open.
    child.on("exit", (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", killTree);
      // Signal-killed shells follow the shell convention of 128 + signal number.
      const exitCode = code ?? 128 + (exitSignal ? (os.constants.signals[exitSignal] ?? 0) : 0);
      setImmediate(() => resolve({ output: Buffer.concat(chunks).toString("utf-8"), exitCode, timedOut }));
    });
  });
}

interface Truncation {
  lines: string[];
  truncatedBy?: "lines" | "bytes";
  totalLines: number;
  firstLineTooLong: boolean;
}

/** Keeps whole lines from the start within the line and byte limits. */
function truncateHead(lines: string[]): Truncation {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length === MAX_OUTPUT_LINES) return { lines: kept, truncatedBy: "lines", totalLines: lines.length, firstLineTooLong: false };
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
      return { lines: kept, truncatedBy: "bytes", totalLines: lines.length, firstLineTooLong: kept.length === 0 };
    }
    kept.push(line);
    bytes += lineBytes;
  }
  return { lines: kept, totalLines: lines.length, firstLineTooLong: false };
}

/** Keeps whole lines from the end within the line and byte limits. */
function truncateTail(lines: string[]): Truncation {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length === MAX_OUTPUT_LINES) return { lines: kept.reverse(), truncatedBy: "lines", totalLines: lines.length, firstLineTooLong: false };
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
      // A single oversized last line is cut to its final bytes rather than dropped.
      if (kept.length === 0) kept.push(Buffer.from(line, "utf-8").subarray(-MAX_OUTPUT_BYTES).toString("utf-8"));
      return { lines: kept.reverse(), truncatedBy: "bytes", totalLines: lines.length, firstLineTooLong: false };
    }
    kept.push(line);
    bytes += lineBytes;
  }
  return { lines: kept.reverse(), totalLines: lines.length, firstLineTooLong: false };
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}
