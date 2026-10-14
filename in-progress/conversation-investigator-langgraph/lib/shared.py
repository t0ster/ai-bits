"""Shared queue and payload models."""

from dataclasses import dataclass
from typing import Annotated

from bullmq import Queue
from pydantic import BaseModel, ConfigDict, Field
from redis.asyncio import Redis

from lib.config import settings

# IDs use ASCII letters, digits, underscores, and hyphens.
ID_PATTERN = r"^[A-Za-z0-9_-]+$"

# Shared validation for client-supplied entity, request, and message IDs.
Id = Annotated[str, Field(min_length=1, max_length=128, pattern=ID_PATTERN)]

queue = Queue(
    settings.investigator_queue,
    {"connection": settings.redis_url},
)


redis_client = Redis.from_url(settings.redis_url, decode_responses=True)


@dataclass(frozen=True, slots=True)
class Unvalidated[T: BaseModel]:
    """Hold input for a model without validating or constructing that model."""

    model: type[T]
    data: object

    def validate(self) -> T:
        """Validate the raw input and return an instance of the expected model."""
        return self.model.model_validate(self.data)


class ChatInput(BaseModel):
    """Client supplies separate identifiers for the message and its submission."""

    model_config = ConfigDict(extra="forbid", strict=True)  # pyright: ignore[reportUnannotatedClassAttribute]
    request_id: Id
    message_id: Id
    message: str = Field(min_length=1)
    thread_id: Id


class HistoryInput(BaseModel):
    """Identify a persisted chat without invoking the model."""

    model_config = ConfigDict(extra="forbid", strict=True)  # pyright: ignore[reportUnannotatedClassAttribute]
    thread_id: Id
