"""Investigation event contracts, Redis publication, and scoped subscriptions."""

from collections.abc import AsyncGenerator
from contextlib import aclosing, asynccontextmanager
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter
from redis.exceptions import RedisError

from lib.shared import redis_client

from .types import InvestigationGraphSnapshot, InvestigationReference


class InvestigationSnapshotEvent(BaseModel):
    """Graph-emitted state, without request bookkeeping or commit guarantees."""

    type: Literal["snapshot"] = "snapshot"
    snapshot: InvestigationGraphSnapshot


class InvestigationDoneEvent(BaseModel):
    """Execution finished normally, including a clarification pause."""

    type: Literal["done"] = "done"


class InvestigationErrorEvent(BaseModel):
    """Safe execution or transport failure; no provider diagnostics are exposed."""

    type: Literal["error"] = "error"
    message: str


InvestigationEvent = Annotated[
    InvestigationSnapshotEvent | InvestigationDoneEvent | InvestigationErrorEvent,
    Field(discriminator="type"),
]
investigation_event_adapter = TypeAdapter(InvestigationEvent)


def investigation_event_channel(reference: InvestigationReference) -> str:
    """Scope investigation events to one execution, including delayed subscribers."""
    return (
        f"investigation:{reference.investigation_id}:request:{reference.job_id}:events"
    )


async def publish_investigation_event(
    reference: InvestigationReference, event: InvestigationEvent
) -> None:
    """Publish once; Redis delivery is best effort with no replay."""
    _ = await redis_client.publish(
        investigation_event_channel(reference), event.model_dump_json()
    )


@asynccontextmanager
async def subscribe_investigation_events(
    reference: InvestigationReference,
) -> AsyncGenerator[AsyncGenerator[InvestigationEvent | None]]:
    """Confirm subscription before yielding; exiting closes the event stream and Redis."""
    async with redis_client.pubsub() as subscriber:
        await subscriber.subscribe(investigation_event_channel(reference))
        acknowledgement = await subscriber.get_message(timeout=None)
        if acknowledgement is None or acknowledgement["type"] != "subscribe":
            raise RuntimeError("Investigation subscription was not confirmed")

        async def read_events() -> AsyncGenerator[InvestigationEvent | None]:
            try:
                while True:
                    message = await subscriber.get_message(
                        ignore_subscribe_messages=True, timeout=15
                    )
                    if message is None:
                        # Transport keepalive only: no state reads or recovery polling.
                        yield None
                        continue
                    data = message["data"]
                    assert isinstance(data, (str, bytes))
                    event = investigation_event_adapter.validate_json(data)
                    yield event
                    if event.type in {"done", "error"}:
                        return
            except (RedisError, ValueError, OSError):
                yield InvestigationErrorEvent(
                    message="Investigation progress unavailable."
                )

        async with aclosing(read_events()) as events:
            yield events
