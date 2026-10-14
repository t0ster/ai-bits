"""Sequential JSONL ingestion with atomic replacement per conversation."""

from collections.abc import Iterator
from pathlib import Path

from openai import AsyncOpenAI
from pydantic import BaseModel

from lib.config import settings
from lib.database.engine import engine

from .lib.storage import (
    ConversationChunkInput,
    ConversationChunksInput,
    ConversationInput,
    TranscriptEntry,
    delete_conversation_chunks,
    insert_conversation_chunk,
    upsert_conversation,
)


class IngestInput(BaseModel):
    """Path to a JSONL file, one original conversation per line."""

    path: Path


class IngestResult(BaseModel):
    """Committed conversation and chunk counts for this invocation."""

    conversations: int
    chunks: int


def chunk_conversation_entries(
    entries: list[TranscriptEntry],
) -> Iterator[list[TranscriptEntry]]:
    """Yield original entries grouped into overlapping windows of speaker turns.

    Consecutive same-speaker messages form one turn, without changing their IDs
    or text. Take three turns, advance two (one-turn overlap), and retain a
    shorter final window. Stop when the last turn is covered so an overlap-only
    trailing window is not emitted. Empty conversations produce no chunks.
    """
    turns = []
    for entry in entries:
        if turns and turns[-1][-1].speaker == entry.speaker:
            turns[-1].append(entry)
        else:
            turns.append([entry])
    for start in range(0, len(turns), 2):
        yield [entry for turn in turns[start : start + 3] for entry in turn]
        if start + 3 >= len(turns):
            break


async def ingest_conversations(path: Path) -> IngestResult:
    """Upsert each transcript, then embed and replace its chunks before committing."""
    count = chunk_count = 0
    async with AsyncOpenAI(
        api_key=settings.openai_api_key_embedding.get_secret_value(),
        base_url="https://api.openai.com/v1",
    ) as client:
        with path.open() as source:
            for line in source:
                if not line.strip():
                    continue
                record = ConversationInput.model_validate_json(line)
                async with engine.begin() as connection:
                    await upsert_conversation(connection, record)
                    await delete_conversation_chunks(
                        connection, ConversationChunksInput(conversation_id=record.id)
                    )
                    written = 0
                    for group in chunk_conversation_entries(record.entries):
                        text = "\n".join(
                            f"{entry.speaker}: {entry.text}" for entry in group
                        )
                        response = await client.embeddings.create(
                            model="text-embedding-3-large",
                            input=text,
                            dimensions=3072,
                        )
                        await insert_conversation_chunk(
                            connection,
                            ConversationChunkInput(
                                conversation_id=record.id,
                                position=written,
                                entry_ids=[entry.id for entry in group],
                                text=text,
                                embedding=response.data[0].embedding,
                            ),
                        )
                        written += 1
                count += 1
                chunk_count += written
    return IngestResult(conversations=count, chunks=chunk_count)
