"""Accept chat reservations and stream live events or replay checkpointed replies."""

from collections.abc import AsyncGenerator

from langchain_core.messages import AIMessage

from lib.core import durdur
from lib.core.ai_sdk_adapter import (
    UIErrorEvent,
    UIMessageEvent,
    to_ui_message_stream,
    ui_event_adapter,
)
from lib.core.bulljobs import queue_get_job_state
from lib.database.engine import create_checkpointer
from lib.shared import (
    ChatInput,
    queue,
    redis_client,
)

from .lib import build_chat_graph, chat_event_channel


async def send_chat_message(
    request: ChatInput,
) -> AsyncGenerator[UIMessageEvent | None, None]:
    """Subscribe before publication; the first keepalive confirms acceptance."""
    thread_id = request.thread_id
    stream_started = False
    async with redis_client.pubsub() as subscriber:
        await subscriber.subscribe(chat_event_channel(thread_id, request.request_id))
        acknowledgement = await subscriber.get_message(timeout=None)
        if acknowledgement is None or acknowledgement["type"] != "subscribe":
            raise RuntimeError("Chat subscription was not confirmed")
        reference = await durdur.enqueue_entity_request(
            durdur.EntityRef(type="chat", id=thread_id),
            request_id=request.request_id,
            job_name="chat.send",
            payload=request.model_dump(mode="json"),
        )
        # HTTP consumes this before opening its response, so busy is an HTTP error.
        yield None
        while True:
            message = await subscriber.get_message(
                ignore_subscribe_messages=True, timeout=1
            )
            if message is not None:
                data = message["data"]
                assert isinstance(data, (str, bytes))
                event = ui_event_adapter.validate_json(data)
                # A reconnect can miss the opening events. Wait and replay instead
                # of forwarding a partial stream that the UI cannot decode.
                if not stream_started:
                    if event.type != "start":
                        continue
                    stream_started = True
                yield event
            else:
                # Redis was quiet for one second; check whether the request finished.
                snapshot = await durdur.read_entity(
                    reference.entity, reference.request_id
                )
                current = snapshot.request
                assert current is not None
                if current.execution_status == "completed":
                    break
                if current.execution_status == "failed":
                    yield UIErrorEvent(
                        errorText="Chat failed. Please try a new message."
                    )
                    return

                # Queue failures handling: detect missing or failed jobs so the stream does not wait forever.
                job_state = await queue_get_job_state(queue, reference.request_id)
                if job_state == "unknown":
                    yield UIErrorEvent(
                        errorText="Accepted chat request has no queue job. Operator recovery is required."
                    )
                    return
                if job_state == "failed":
                    yield UIErrorEvent(
                        errorText="Chat execution is blocked. Operator recovery is required."
                    )
                    return

                # Idle heartbeat; HTTP turns None into an SSE keepalive.
                yield None

    if stream_started:
        return

    # Replay path: this connection missed the live stream's start, or joined after
    # completion. Load the saved reply for this request and stream it in full.
    graph = build_chat_graph(create_checkpointer())
    state = await graph.aget_state({"configurable": {"thread_id": f"chat:{thread_id}"}})
    for message in state.values.get("messages", []):
        if (
            message.type == "ai"
            and message.response_metadata.get("chat_request_id") == request.request_id
        ):

            async def saved_reply(reply: AIMessage):
                yield reply

            async for event in to_ui_message_stream(
                saved_reply(message), message_id=message.id
            ):
                yield event
            return
    raise ValueError("Chat reply not found in checkpoint")
