"""Chat graph execution and checkpointed reply streaming."""

from uuid import uuid4

from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, MessagesState, StateGraph

from lib.config import settings
from lib.core.durdur import EntityRef, mark_entity_ready


def chat_event_channel(thread_id: str, request_id: str) -> str:
    """Derive the transient event channel from the client-supplied request ID."""
    return f"{settings.investigator_queue}:chat.events:{thread_id}:{request_id}"


def build_chat_graph(checkpointer: AsyncPostgresSaver):
    """Persist complete message history locally; send it to the gateway each turn."""
    model = ChatOpenAI(
        model=settings.gateway_model,
        base_url=settings.gateway_base_url,
        api_key=settings.gateway_api_key,
        use_responses_api=True,
        store=False,
        timeout=120,
        max_retries=0,
    )

    async def initialize_chat(state: MessagesState, config: RunnableConfig):
        _ = state
        # sync durability persists the input checkpoint before this node starts.
        thread_id = config.get("configurable", {})["thread_id"].removeprefix("chat:")
        await mark_entity_ready(EntityRef(type="chat", id=thread_id))
        return {}

    async def call_model(state: MessagesState, config: RunnableConfig):
        reply = await model.ainvoke(state["messages"])
        reply.id = str(uuid4())
        reply.response_metadata["chat_request_id"] = config.get("configurable", {})[
            "request_id"
        ]
        return {"messages": [reply]}

    graph = StateGraph(MessagesState)
    _ = graph.add_node("initialize", initialize_chat)
    _ = graph.add_node("chat", call_model)
    _ = graph.add_edge(START, "initialize")
    _ = graph.add_edge("initialize", "chat")
    _ = graph.add_edge("chat", END)
    return graph.compile(checkpointer=checkpointer)
