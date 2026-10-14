"""Canonical transcripts, search chunks, and entity coordination."""

from pgvector.sqlalchemy import VECTOR
from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Table,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR

metadata = MetaData()

conversations = Table(
    "conversations",
    metadata,
    Column("id", Text, primary_key=True),
    Column("started_at", DateTime(timezone=True), nullable=False, index=True),
    Column("agent_id", Text, index=True),
    Column("team_id", Text, index=True),
    Column("entries", JSONB, nullable=False),
)

search_chunks = Table(
    "search_chunks",
    metadata,
    Column("id", Text, primary_key=True),
    Column("conversation_id", Text, ForeignKey("conversations.id"), nullable=False),
    Column("position", Integer, nullable=False),
    Column("entry_ids", ARRAY(Text), nullable=False),
    Column("text", Text, nullable=False),
    Column("search_vector", TSVECTOR),
    # text-embedding-3-large uses 3072 dimensions; exact vector search for now.
    Column("embedding", VECTOR()),
    UniqueConstraint("conversation_id", "position"),
    Index("ix_search_chunks_search_vector", "search_vector", postgresql_using="gin"),
)


chats = Table(
    "chats",
    metadata,
    Column("id", Text, primary_key=True),
    Column("status", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

investigations = Table(
    "investigations",
    metadata,
    Column("id", Text, primary_key=True),
    Column("status", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

requests = Table(
    "requests",
    metadata,
    Column("entity_type", Text, nullable=False),
    Column("entity_id", Text, nullable=False),
    Column("request_id", Text, primary_key=True),
    Column("execution_status", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Index("ix_requests_latest", "entity_type", "entity_id", "created_at"),
    Index(
        "ix_requests_reservation",
        "entity_type",
        "entity_id",
        unique=True,
        postgresql_where=text("execution_status IN ('pending', 'running')"),
    ),
)
