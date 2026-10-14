"""Read persisted chat history."""

from typing import Literal

from pydantic import BaseModel

from lib.core.durdur import (
    EntityRef,
    RequestStatus,
    read_entity,
)
from lib.database.engine import create_checkpointer
from lib.shared import ChatInput, HistoryInput, Id, queue

from .lib import build_chat_graph


class ChatMessage(BaseModel):
    """Public representation of a persisted chat message."""

    id: str
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    """ID and status of the latest accepted chat request."""

    request_id: Id
    status: RequestStatus


class ChatHistory(BaseModel):
    """Ordered messages read from a persisted thread."""

    thread_id: str
    last_request: ChatRequest | None
    messages: list[ChatMessage]
    pending: ChatInput | None


async def read_chat_history(request: HistoryInput) -> ChatHistory:
    """Read LangGraph state without scheduling work or calling the LLM."""
    entity = EntityRef(type="chat", id=request.thread_id)
    registration = await read_entity(entity)
    pending = None
    if registration.request is not None and registration.request.execution_status in {
        "pending",
        "running",
    }:
        job = await queue.getJob(registration.request.request_id)
        if job is not None:
            pending = ChatInput.model_validate(job.data)
    saver = create_checkpointer()
    graph = build_chat_graph(saver)
    state = await graph.aget_state(
        {"configurable": {"thread_id": f"chat:{request.thread_id}"}}
    )
    return ChatHistory.model_validate(
        {
            "thread_id": request.thread_id,
            "pending": pending,
            "last_request": (
                {
                    "request_id": registration.request.request_id,
                    "status": registration.request.execution_status,
                }
                if registration.request is not None
                else None
            ),
            "messages": [
                {
                    "id": message.id,
                    "role": "user" if message.type == "human" else "assistant",
                    "content": message.text,
                }
                for message in state.values.get("messages", [])
            ],
        }
    )
