import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Investigation } from "./investigation";
import { Chat } from "./chat";
import {
  chatPath,
  investigationPath,
  parseRoute,
  replacePath,
  type Route,
} from "@/lib/routes";
import "./globals.css";

function renderRoute(route: Route): ReactNode {
  switch (route.page) {
    case "home":
      return (
        <nav className="flex flex-col gap-2 p-6 underline">
          <a href={chatPath()}>Chat</a>
          <a href={investigationPath()}>Investigation</a>
        </nav>
      );
    case "chat": {
      if (route.threadId) return <Chat threadId={route.threadId} />;
      const threadId = crypto.randomUUID();
      replacePath(chatPath(threadId));
      return <Chat threadId={threadId} />;
    }
    case "investigation":
      return <Investigation investigationId={route.investigationId} />;
    case "not-found":
      return <h1 className="p-6 font-semibold">Not found</h1>;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Demo root element missing");
createRoot(root).render(renderRoute(parseRoute(window.location.pathname)));
