"""Conversation mutations using the caller's SQLAlchemy Core transaction."""

from typing import Literal, Self

from pydantic import AwareDatetime, BaseModel, Field, model_validator
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncConnection

from lib.database.tables import conversations, search_chunks


class TranscriptEntry(BaseModel):
    """Original timestamped message; source order is preserved."""

    id: str = Field(min_length=1)
    speaker: Literal["customer", "agent"]
    text: str
    sent_at: AwareDatetime


class ConversationInput(BaseModel):
    """Original transcript accepted by the conversation upsert."""

    id: str = Field(min_length=1)
    started_at: AwareDatetime
    entries: list[TranscriptEntry]
    agent_id: str | None = None
    team_id: str | None = None

    @model_validator(mode="after")
    def validate_entry_ids(self) -> Self:
        if len({entry.id for entry in self.entries}) != len(self.entries):
            raise ValueError("Conversation entry IDs must be unique")
        return self


class ConversationChunksInput(BaseModel):
    """Conversation whose derived chunks will be replaced."""

    conversation_id: str


class ConversationChunkInput(BaseModel):
    """One indexed passage with references to original messages."""

    conversation_id: str
    position: int = Field(ge=0)
    entry_ids: list[str] = Field(min_length=1)
    text: str
    embedding: list[float] = Field(min_length=3072, max_length=3072)


async def upsert_conversation(
    connection: AsyncConnection, record: ConversationInput
) -> None:
    """Replace a conversation's original transcript and metadata by stable ID."""
    statement = insert(conversations).values(
        id=record.id,
        started_at=record.started_at,
        entries=[entry.model_dump(mode="json") for entry in record.entries],
        agent_id=record.agent_id,
        team_id=record.team_id,
    )
    _ = await connection.execute(
        statement.on_conflict_do_update(
            index_elements=[conversations.c.id],
            set_={
                key: statement.excluded[key]
                for key in ("started_at", "entries", "agent_id", "team_id")
            },
        )
    )


async def delete_conversation_chunks(
    connection: AsyncConnection, request: ConversationChunksInput
) -> None:
    """Clear derived chunks before rebuilding them within the same transaction."""
    _ = await connection.execute(
        search_chunks.delete().where(
            search_chunks.c.conversation_id == request.conversation_id
        )
    )


async def insert_conversation_chunk(
    connection: AsyncConnection,
    chunk: ConversationChunkInput,
) -> None:
    """Store one embedded chunk with original entry references and lexical data."""
    _ = await connection.execute(
        insert(search_chunks).values(
            id=f"{chunk.conversation_id}-chunk-{chunk.position:03}",
            **chunk.model_dump(),
            search_vector=func.to_tsvector("english", chunk.text),
        )
    )
