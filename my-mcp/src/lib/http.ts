/** Headers letting browser-based MCP clients (e.g. MCP Inspector) call the server cross-origin. */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
};

/** Wraps a handler to answer CORS preflight requests and add CORS headers to every response. */
export function withCors(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const response = await handler(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

/** Wraps a handler so only POST reaches it; other methods get 405. */
export function postOnly(handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> =>
    request.method === "POST" ? handler(request) : new Response("Method not allowed", { status: 405 });
}

/** Whether the URL points at this machine (localhost, 127.0.0.1, or ::1). */
export function isLoopbackUrl(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
