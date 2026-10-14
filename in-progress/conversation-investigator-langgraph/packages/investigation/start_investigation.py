"""Submit an investigation question and stream its execution events."""

from collections.abc import AsyncGenerator
from datetime import date, datetime
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from lib.config import settings
from lib.core import durdur
from lib.shared import Id

from .jobs import InvestigationStartJobInput
from .lib.events import (
    InvestigationEvent,
    subscribe_investigation_events,
)
from .lib.types import InvestigationReference


class InvestigationStart(BaseModel):
    """Start input; optional reference date is frozen before enqueueing."""

    request_id: Id
    investigation_id: Id
    question: str = Field(min_length=1)
    today: date | None = None


async def start_investigation(
    request: InvestigationStart,
) -> AsyncGenerator[InvestigationEvent | None]:
    """Stream one execution; first None acknowledges acceptance, later ones keep alive."""
    timezone = settings.investigator_timezone
    today = request.today or datetime.now(ZoneInfo(timezone)).date()
    payload = InvestigationStartJobInput(
        request_id=request.request_id,
        investigation_id=request.investigation_id,
        question=request.question,
        today=today,
        timezone=timezone,
    )
    reference = InvestigationReference(
        investigation_id=request.investigation_id, job_id=request.request_id
    )
    async with subscribe_investigation_events(reference) as events:
        _ = await durdur.enqueue_entity_request(
            durdur.EntityRef(type="investigation", id=request.investigation_id),
            request_id=request.request_id,
            job_name="investigation.start",
            payload=payload.model_dump(mode="json"),
        )
        yield None
        async for event in events:
            yield event
