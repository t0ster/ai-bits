"""Generate a synthetic NASA Ragas dataset from indexed chunks."""

import argparse
import json
import random
import sys
from collections.abc import Sequence
from contextlib import closing
from math import ceil
from pathlib import Path

import psycopg2
from langchain_core.documents import Document
from llama_index.llms.openai_like import OpenAILike
from psycopg2 import sql
from ragas.run_config import RunConfig
from ragas.testset import Testset, TestsetGenerator

from lib.config import settings
from packages.rag import document_embedding_model, document_vector_store


def sample_book_chunk_ranges(
    book_sizes: dict[str, int],
    chunk_limit: int = 20,
    seed: int = 42,
) -> list[tuple[str, int, int]]:
    """Choose reproducible, zero-based half-open chunk ranges without loading source text."""
    # Testset source sampling, from database counts to generated questions:
    # 1. PostgreSQL returns each book's chunk count and validates its stored positions.
    #    Python receives one summary per book, rather than the entire corpus's text.
    # 2. chunk_limit is the source sample budget, separate from testset_size, which
    #    requests a number of generated questions. Cover each book first, then divide
    #    remaining slots roughly by book size. With fewer slots than books, sample books.
    # 3. Divide each book's positions into regions and choose a consecutive run of
    #    at most four chunks per region. Twenty slots give five runs of four;
    #    ten give runs of four, three, three. This spreads coverage while keeping context.
    # 4. PostgreSQL returns text/metadata only for those ranges. Remove empty text
    #    and whitespace-normalized duplicates within the fetched sample; this can
    #    leave fewer usable chunks than the requested maximum.
    # 5. A fixed seed repeats ranges for unchanged book IDs/counts.
    # Ragas generates questions/references from this pool; its model outputs are
    # not made deterministic by our sampling seed. Without indexes, PostgreSQL
    # may still scan many rows, but Python does not load unselected chunk text.
    if chunk_limit < 1:
        raise ValueError("Testset chunk limit must be positive")
    if not book_sizes:
        raise ValueError("Testset generation requires indexed text chunks")
    if any(count < 1 for count in book_sizes.values()):
        raise ValueError("Testset book chunk counts must be positive")
    rng = random.Random(seed)
    book_ids = sorted(book_sizes)
    budget = min(chunk_limit, sum(book_sizes.values()))
    if budget < len(book_ids):
        book_ids = sorted(rng.sample(book_ids, budget))
    quotas = {book_id: 1 for book_id in book_ids}
    remaining = budget - len(book_ids)
    capacity = {book_id: book_sizes[book_id] - 1 for book_id in book_ids}
    total_capacity = sum(capacity.values())
    if remaining:
        for book_id in book_ids:
            quotas[book_id] += remaining * capacity[book_id] // total_capacity
        extras = budget - sum(quotas.values())
        ranked = sorted(
            book_ids,
            key=lambda book_id: (
                -(remaining * capacity[book_id] % total_capacity),
                book_id,
            ),
        )
        for book_id in ranked[:extras]:
            quotas[book_id] += 1
    ranges: list[tuple[str, int, int]] = []
    for book_id in book_ids:
        quota = quotas[book_id]
        region_count = ceil(quota / 4)
        region_size, larger_regions = divmod(book_sizes[book_id], region_count)
        run_size, larger_runs = divmod(quota, region_count)
        offset = 0
        for region in range(region_count):
            width = region_size + (region < larger_regions)
            count = run_size + (region < larger_runs)
            start = rng.randint(offset, offset + width - count)
            ranges.append((book_id, start, start + count))
            offset += width
    return ranges


def load_testset_chunks(chunk_limit: int = 20, seed: int = 42) -> list[Document]:
    """Read book counts, then fetch only sampled chunk ranges from a read-only snapshot."""
    if chunk_limit < 1:
        raise ValueError("Testset chunk limit must be positive")
    vector_store = document_vector_store()
    table = sql.SQL("{}.{}").format(
        sql.Identifier(vector_store.schema_name),
        sql.Identifier(f"data_{vector_store.table_name}"),
    )
    count_query = sql.SQL(
        """SELECT metadata_->>'document_id', count(*),
        count(*) FILTER (WHERE jsonb_typeof(metadata_->'chunk_index') = 'number'),
        min((metadata_->>'chunk_index')::integer),
        max((metadata_->>'chunk_index')::integer),
        count(DISTINCT (metadata_->>'chunk_index')::integer)
        FROM {} GROUP BY metadata_->>'document_id' ORDER BY 1"""
    ).format(table)
    sample_query = sql.SQL(
        """SELECT chunks.node_id, chunks.text,
        chunks.metadata_ - '_node_content' - '_node_type' - 'doc_items'
        FROM {} AS chunks
        JOIN unnest(%s::text[], %s::integer[], %s::integer[])
            AS selection(book_id, start_index, stop_index)
        ON chunks.metadata_->>'document_id' = selection.book_id
        AND (chunks.metadata_->>'chunk_index')::integer >= selection.start_index
        AND (chunks.metadata_->>'chunk_index')::integer < selection.stop_index
        ORDER BY selection.book_id, (chunks.metadata_->>'chunk_index')::integer"""
    ).format(table)
    with closing(
        psycopg2.connect(
            settings.database_url.get_secret_value(),
            connect_timeout=5,
            options="-c statement_timeout=5000",
        )
    ) as connection:
        connection.set_session(readonly=True, isolation_level="REPEATABLE READ")
        with connection, connection.cursor() as cursor:
            cursor.execute(count_query)
            book_sizes: dict[str, int] = {}
            for book_id, count, numbered, first, last, distinct in cursor.fetchall():
                if not isinstance(book_id, str) or not book_id:
                    raise ValueError("Testset chunk is missing its source book ID")
                if (
                    numbered != count
                    or first != 0
                    or last != count - 1
                    or distinct != count
                ):
                    raise ValueError(
                        "Testset requires unique consecutive chunk positions; reindex the books"
                    )
                book_sizes[book_id] = count
            ranges = sample_book_chunk_ranges(book_sizes, chunk_limit, seed)
            cursor.execute(
                sample_query,
                (
                    [book_id for book_id, _, _ in ranges],
                    [start for _, start, _ in ranges],
                    [stop for _, _, stop in ranges],
                ),
            )
            rows = cursor.fetchall()
            if len(rows) != sum(stop - start for _, start, stop in ranges):
                raise ValueError(
                    "Testset sampled ranges returned an unexpected chunk count"
                )
    selected: list[Document] = []
    seen_text: set[str] = set()
    for node_id, text, metadata in rows:
        normalized = " ".join(text.split())
        if normalized and normalized not in seen_text:
            selected.append(
                Document(page_content=text, metadata={**metadata, "chunk_id": node_id})
            )
            seen_text.add(normalized)
    if not selected:
        raise ValueError("Testset selection contains no usable text chunks")
    return selected


def generate_nasa_testset(chunks: Sequence[Document], testset_size: int = 5) -> Testset:
    """Generate questions and reference answers with the testset model and app embeddings."""
    if testset_size < 1:
        raise ValueError("Testset size must be positive")
    if not chunks:
        raise ValueError("Testset generation requires indexed text chunks")
    print(f"Loaded {len(chunks)} indexed chunks.", file=sys.stderr, flush=True)
    generator = TestsetGenerator.from_llama_index(
        llm=OpenAILike(
            model=settings.evals_testset_model,
            api_base=str(settings.generation_base_url),
            api_key=settings.generation_api_key.get_secret_value(),
            context_window=100_000,
            is_chat_model=True,
        ),
        embedding_model=document_embedding_model(),
    )
    testset = generator.generate_with_chunks(
        list(chunks),
        testset_size=testset_size,
        run_config=RunConfig(max_workers=2, max_retries=2),
        raise_exceptions=True,
    )
    if not isinstance(testset, Testset):
        raise TypeError("Testset generation did not return a completed testset")
    return testset


def run_testset_generation(args: argparse.Namespace) -> int:
    """Write a synthetic testset to a new JSON file."""
    output = args.output.expanduser()
    if output.exists():
        raise FileExistsError("Testset output already exists")
    if not output.parent.is_dir():
        raise FileNotFoundError("Testset output directory does not exist")
    chunks = load_testset_chunks(args.chunk_limit, args.seed)
    testset = generate_nasa_testset(chunks, args.size)
    if not testset.samples:
        raise ValueError("Testset generation produced no samples")
    # Keep synthesizer_name alongside the evaluation sample's reference fields.
    serialized = json.dumps(testset.to_list(), ensure_ascii=False, indent=2)
    with output.open("x", encoding="utf-8") as destination:
        _ = destination.write(serialized + "\n")
    print(f"Generated {len(testset.samples)} samples: {output}")
    return 0


def main() -> int:
    """Generate a new dataset; existing output files are never overwritten."""

    def positive_integer(value: str) -> int:
        number = int(value)
        if number < 1:
            raise argparse.ArgumentTypeError("Expected a positive integer")
        return number

    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "--size",
        type=positive_integer,
        default=5,
        help="Requested number of questions (default: 5)",
    )
    _ = parser.add_argument(
        "--chunk-limit",
        type=positive_integer,
        default=20,
        help="Maximum source chunks sampled across books (default: 20)",
    )
    _ = parser.add_argument(
        "--output", type=Path, required=True, help="New JSON testset file"
    )
    _ = parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Reproducible chunk sampling seed (default: 42)",
    )
    return run_testset_generation(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
