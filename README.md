# mono

## Projects

- [my-remote-mcp](my-remote-mcp): Give ChatGPT, Claude, or any MCP client a shell on a machine you control — a server or your own laptop.

## In progress

- [conversation-investigator-langgraph](in-progress/conversation-investigator-langgraph): LangGraph agent that investigates support conversations, with validated citations.
- [nasa-rag](in-progress/nasa-rag): RAG over NASA e-books, with cited answers and Ragas/Langfuse evals.
- [simple-ai-sdk-chat-pg](in-progress/simple-ai-sdk-chat-pg): Vercel AI SDK chat with durable Postgres threads.

## Ideas

- Modules with clear boundaries: [modular monolith](https://milanjovanovic.tech/blog/what-is-a-modular-monolith).
- Modules are [deep modules](https://github.com/mattpocock/skills/blob/main/skills/in-progress/setup-ts-deep-modules/SKILL.md): a lot of behaviour behind a small public interface.
- Boundaries are enforced, not just documented: [tach](https://github.com/tach-org/tach) in Python, [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) as the TypeScript equivalent.
- Layers run `entry points` → `packages/` → `shared/core/infra`; imports go downward only and never form cycles.
- Observability through [wide events](https://boristane.com/blog/observability-wide-events-101/).
