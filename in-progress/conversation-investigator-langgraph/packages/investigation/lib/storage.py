"""Scoped transcript retrieval using SQLAlchemy Core and exact vector search."""

from datetime import datetime
from typing import Literal, Self

from pydantic import AwareDatetime, BaseModel, Field, model_validator
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncConnection

from lib.database.tables import conversations, search_chunks


class TranscriptEntry(BaseModel):
    """Original timestamped message; source order is preserved."""

    id: str = Field(min_length=1)
    speaker: Literal["customer", "agent"]
    text: str
    sent_at: AwareDatetime


class Conversation(BaseModel):
    """Stored conversation with its original ordered transcript."""

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


class ConversationSearchHit(BaseModel):
    """One ranked passage with original entry IDs, not a relevance guarantee."""

    id: str
    conversation_id: str
    entry_ids: list[str]
    text: str


def _conversation_filters(
    start: datetime, end: datetime, agent_id: str | None, team_id: str | None
):
    conditions = [conversations.c.started_at >= start, conversations.c.started_at < end]
    if agent_id is not None:
        conditions.append(conversations.c.agent_id == agent_id)
    if team_id is not None:
        conditions.append(conversations.c.team_id == team_id)
    return and_(*conditions)


async def search_conversation_chunks(
    connection: AsyncConnection,
    *,
    query: str,
    embedding: list[float],
    start: datetime,
    end: datetime,
    agent_id: str | None,
    team_id: str | None,
    offset: int,
) -> list[ConversationSearchHit]:
    """Fuse lexical and semantic ranks within scope; return twenty passages per page."""
    filters = _conversation_filters(start, end, agent_id, team_id)
    source = search_chunks.join(
        conversations, search_chunks.c.conversation_id == conversations.c.id
    )
    semantic = (
        select(
            search_chunks.c.id,
            func.row_number()
            .over(
                order_by=(
                    search_chunks.c.embedding.cosine_distance(embedding),
                    search_chunks.c.id,
                )
            )
            .label("rank"),
        )
        .select_from(source)
        .where(filters, search_chunks.c.embedding.is_not(None))
        .cte("semantic")
    )
    terms = func.websearch_to_tsquery("english", query)
    lexical = (
        select(
            search_chunks.c.id,
            func.row_number()
            .over(
                order_by=(
                    func.ts_rank_cd(search_chunks.c.search_vector, terms).desc(),
                    search_chunks.c.id,
                )
            )
            .label("rank"),
        )
        .select_from(source)
        .where(filters, search_chunks.c.search_vector.op("@@")(terms))
        .cte("lexical")
    )
    score = func.coalesce(1.0 / (60 + semantic.c.rank), 0) + func.coalesce(
        1.0 / (60 + lexical.c.rank), 0
    )
    statement = (
        select(
            search_chunks.c.id,
            search_chunks.c.conversation_id,
            search_chunks.c.entry_ids,
            search_chunks.c.text,
        )
        .select_from(
            source.outerjoin(semantic, semantic.c.id == search_chunks.c.id).outerjoin(
                lexical, lexical.c.id == search_chunks.c.id
            )
        )
        .where(filters, (semantic.c.id.is_not(None) | lexical.c.id.is_not(None)))
        .order_by(score.desc(), search_chunks.c.id)
        .offset(offset)
        .limit(20)
    )
    return [
        ConversationSearchHit.model_validate(dict(row))
        for row in (await connection.execute(statement)).mappings()
    ]


async def read_conversation(
    connection: AsyncConnection,
    *,
    conversation_id: str,
) -> Conversation | None:
    """Read a full conversation by ID; return None when absent."""
    result = await connection.execute(
        select(conversations).where(
            conversations.c.id == conversation_id,
        )
    )
    row = result.mappings().one_or_none()
    return Conversation.model_validate(dict(row)) if row is not None else None
