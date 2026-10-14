"""Demo HTTP API for chat and investigations, with shared resource lifetime."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, Path, Request
from fastapi.responses import JSONResponse, StreamingResponse

from lib.core.durdur import (
    EntityNotFoundError,
    EntityRequestError,
    RequestNotFoundError,
)
from lib.database.engine import engine, pool
from lib.shared import (
    ID_PATTERN,
    ChatInput,
    HistoryInput,
    queue,
    redis_client,
)
from packages.chat.read_chat_history import read_chat_history
from packages.chat.send_chat_message import send_chat_message
from packages.investigation import InvestigationEvent
from packages.investigation.get_investigation import (
    InvestigationLookup,
    InvestigationSnapshot,
    get_investigation,
)
from packages.investigation.reply_investigation import (
    InvestigationReply,
    reply_investigation,
)
from packages.investigation.start_investigation import (
    InvestigationStart,
    start_investigation,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await pool.open()
    try:
        yield
    finally:
        await engine.dispose()
        await pool.close()
        await queue.close()
        await redis_client.aclose()


app = FastAPI(lifespan=lifespan)


@app.exception_handler(EntityRequestError)
async def entity_request_error(_request: Request, error: EntityRequestError):
    """Return not found for missing entities or requests, and conflict otherwise."""
    return JSONResponse(
        status_code=404
        if isinstance(error, (EntityNotFoundError, RequestNotFoundError))
        else 409,
        content={"error": {"code": error.code, "message": str(error)}},
    )


# Chat


@app.get("/api/chat/{thread_id}/history")
async def chat_history(thread_id: str):
    """Expose saved text messages in AI SDK UI message format."""
    history = await read_chat_history(HistoryInput(thread_id=thread_id))
    pending = history.pending
    messages = [
        {
            "id": message.id,
            "role": message.role,
            "parts": [{"type": "text", "text": message.content}],
        }
        for message in history.messages
    ]

    return {
        "messages": messages,
        "pending": (
            {"message_id": pending.message_id, "message": pending.message}
            if pending is not None
            else None
        ),
        "last_request": history.last_request,
    }


@app.post("/api/chat/send")
async def send_chat_message_endpoint(request: ChatInput):
    """New requests stream live; existing requests wait and replay."""

    source = send_chat_message(request)
    # Run acceptance before HTTP headers so busy/ID conflicts can return HTTP 409.
    # Discard the initial heartbeat; subsequent events are forwarded below.
    _ = await anext(source)

    async def events():
        try:
            async for event in source:
                if event is None:
                    yield ": heartbeat\n\n"
                else:
                    yield f"data: {event.model_dump_json()}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            await source.aclose()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "x-vercel-ai-ui-message-stream": "v1",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# Investigations

_InvestigationPath = Annotated[
    str, Path(min_length=1, max_length=128, pattern=ID_PATTERN)
]


async def _investigation_response(source: AsyncGenerator[InvestigationEvent | None]):
    # Acceptance precedes headers so reservation conflicts remain HTTP errors.
    _ = await anext(source)

    async def events():
        try:
            # Some proxies hold headers until the first body byte; flush acceptance now.
            yield ": accepted\n\n"
            async for event in source:
                if event is None:
                    yield ": heartbeat\n\n"
                else:
                    yield f"event: {event.type}\ndata: {event.model_dump_json(exclude={'type'})}\n\n"
        finally:
            await source.aclose()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/investigations/start")
async def start_investigation_endpoint(request: InvestigationStart):
    """Accept the question and stream this execution in the same response."""
    return await _investigation_response(start_investigation(request))


@app.post("/api/investigations/reply")
async def reply_investigation_endpoint(request: InvestigationReply):
    """Accept a clarification reply and stream its resumed execution."""
    return await _investigation_response(reply_investigation(request))


@app.get("/api/investigations/{investigation_id}", response_model=InvestigationSnapshot)
async def investigation_snapshot_endpoint(investigation_id: _InvestigationPath):
    """Load saved graph state and request information without starting work."""
    return await get_investigation(
        InvestigationLookup(investigation_id=investigation_id)
    )
