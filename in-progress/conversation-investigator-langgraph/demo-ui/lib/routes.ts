/** Demo page addressed by the current URL path. */
export type Route =
  | { readonly page: "home" }
  | { readonly page: "chat"; readonly threadId: string | null }
  | { readonly page: "investigation"; readonly investigationId: string | null }
  | { readonly page: "not-found" };

/** Parse `/`, `/chat[/<thread id>]`, or `/investigation[/<investigation id>]`. */
export function parseRoute(pathname: string): Route {
  if (pathname === "/") return { page: "home" };
  const [, page, id, ...rest] = pathname.split("/");
  if (id === "" || rest.length > 0) return { page: "not-found" };
  if (page === "chat") return { page, threadId: id ?? null };
  if (page === "investigation") return { page, investigationId: id ?? null };
  return { page: "not-found" };
}

/** Path to a chat thread, or to a new chat when no thread is given. */
export function chatPath(threadId?: string): string {
  return threadId ? `/chat/${threadId}` : "/chat";
}

/** Path to an investigation, or to a new investigation when none is given. */
export function investigationPath(investigationId?: string): string {
  return investigationId
    ? `/investigation/${investigationId}`
    : "/investigation";
}

/** Replace the current URL without adding a history entry. */
export function replacePath(path: string): void {
  window.history.replaceState(null, "", path);
}
