"""Worker-only chat generation with checkpointed request deduplication."""

from langchain_core.messages import AIMessageChunk, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel

from lib.core.ai_sdk_adapter import to_ui_message_stream
from lib.core.durdur import (
    EntityRef,
    claim_entity_request,
    finish_entity_request,
)
from lib.shared import ChatInput, Unvalidated, redis_client

from .lib import chat_event_channel


class ChatReplyReference(BaseModel):
    """Reply identifiers stored in the Redis job result."""

    thread_id: str
    message_id: str


async def chat_send_job(
    graph: CompiledStateGraph,
    payload: Unvalidated[ChatInput],
) -> ChatReplyReference:
    """Claim before graph access; release only after execution definitively ends."""
    request = payload.validate()
    entity = EntityRef(type="chat", id=request.thread_id)
    await claim_entity_request(entity, request.request_id)
    try:
        config: RunnableConfig = {
            "configurable": {
                "thread_id": f"chat:{request.thread_id}",
                "request_id": request.request_id,
            }
        }
        state = await graph.aget_state(config)
        reply = next(
            (
                message
                for message in state.values.get("messages", [])
                if message.type == "ai"
                and message.response_metadata.get("chat_request_id")
                == request.request_id
            ),
            None,
        )
        if reply is None:
            chunks = (
                chunk
                async for chunk, _metadata in graph.astream(
                    {
                        "messages": [
                            HumanMessage(content=request.message, id=request.message_id)
                        ]
                    },
                    config,
                    stream_mode="messages",
                    durability="sync",
                )
                if isinstance(chunk, AIMessageChunk)
            )
            async for event in to_ui_message_stream(chunks):
                _ = await redis_client.publish(
                    chat_event_channel(request.thread_id, request.request_id),
                    event.model_dump_json(),
                )
            state = await graph.aget_state(config)
            reply = next(
                message
                for message in state.values["messages"]
                if message.type == "ai"
                and message.response_metadata.get("chat_request_id")
                == request.request_id
            )
        result = ChatReplyReference.model_validate(
            {"thread_id": request.thread_id, "message_id": reply.id}
        )
    except Exception:
        await finish_entity_request(entity, request.request_id, "failed")
        raise
    # Completion errors must preserve the running reservation.
    await finish_entity_request(entity, request.request_id, "completed")
    return result
