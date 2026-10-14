"""Convert LangChain streams to AI SDK UI event models."""

import uuid
from collections.abc import AsyncGenerator, AsyncIterable
from typing import Annotated, Literal

from langchain_core.messages import AIMessage
from pydantic import BaseModel, Field, TypeAdapter


class UIStartEvent(BaseModel):
    type: Literal["start"] = "start"
    messageId: str


class UITextStartEvent(BaseModel):
    type: Literal["text-start"] = "text-start"
    id: str


class UITextDeltaEvent(BaseModel):
    type: Literal["text-delta"] = "text-delta"
    id: str
    delta: str


class UITextEndEvent(BaseModel):
    type: Literal["text-end"] = "text-end"
    id: str


class UIUsage(BaseModel):
    inputTokens: int
    outputTokens: int


class UIFinishEvent(BaseModel):
    type: Literal["finish"] = "finish"
    finishReason: Literal["stop"]
    usage: UIUsage


class UIErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    errorText: str


UIMessageEvent = Annotated[
    UIStartEvent
    | UITextStartEvent
    | UITextDeltaEvent
    | UITextEndEvent
    | UIFinishEvent
    | UIErrorEvent,
    Field(discriminator="type"),
]

ui_event_adapter = TypeAdapter(UIMessageEvent)


def _chunk_to_content_text(chunk: AIMessage) -> str:
    """Extract text content from an AIMessage.

    Handles both list content blocks and string content.
    """
    content = getattr(chunk, "content", None)

    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        # Extract text from all text-type blocks
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        return "".join(text_parts)

    return ""


async def to_ui_message_stream(
    chunks: AsyncIterable[object],
    *,
    message_id: str | None = None,
) -> AsyncGenerator[UIMessageEvent, None]:
    """Yield UI text events."""
    message_id = message_id or f"msg_{uuid.uuid4().hex[:30]}"
    text_id = f"text_{uuid.uuid4().hex[:30]}"

    yield UIStartEvent(messageId=message_id)
    yield UITextStartEvent(id=text_id)

    async for chunk in chunks:
        if not isinstance(chunk, AIMessage):
            continue

        text = _chunk_to_content_text(chunk)
        if not text:
            continue

        yield UITextDeltaEvent(id=text_id, delta=text)

    yield UITextEndEvent(id=text_id)
    yield UIFinishEvent(
        finishReason="stop",
        usage=UIUsage(inputTokens=0, outputTokens=0),
    )
