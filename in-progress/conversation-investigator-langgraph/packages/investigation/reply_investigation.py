"""Submit a clarification reply and stream its resumed execution events."""

from collections.abc import AsyncGenerator

from pydantic import BaseModel, Field

from lib.core import durdur
from lib.shared import Id

from .jobs import InvestigationReplyJobInput
from .lib.events import (
    InvestigationEvent,
    subscribe_investigation_events,
)
from .lib.types import InvestigationReference


class InvestigationReply(BaseModel):
    """Resume one specific saved clarification."""

    request_id: Id
    investigation_id: Id
    clarification_id: str = Field(min_length=1)
    reply: str = Field(min_length=1)


async def reply_investigation(
    request: InvestigationReply,
) -> AsyncGenerator[InvestigationEvent | None]:
    """Stream one reply; first None acknowledges acceptance, later ones keep alive."""
    payload = InvestigationReplyJobInput(
        request_id=request.request_id,
        investigation_id=request.investigation_id,
        clarification_id=request.clarification_id,
        reply=request.reply,
    )
    reference = InvestigationReference(
        investigation_id=request.investigation_id, job_id=request.request_id
    )
    async with subscribe_investigation_events(reference) as events:
        _ = await durdur.enqueue_entity_request(
            durdur.EntityRef(type="investigation", id=request.investigation_id),
            request_id=request.request_id,
            job_name="investigation.reply",
            payload=payload.model_dump(mode="json"),
        )
        yield None
        async for event in events:
            yield event
