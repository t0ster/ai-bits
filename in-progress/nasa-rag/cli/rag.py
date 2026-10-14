"""NASA RAG CLI for indexing and querying."""

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

import psycopg2
from cohere.core.api_error import ApiError as CohereAPIError
from defusedxml.common import DefusedXmlException
from langfuse import observe, propagate_attributes
from llama_index.core import VectorStoreIndex
from openai import APIError
from sqlalchemy.exc import SQLAlchemyError

from lib.config import (
    CHUNK_MAX_TOKENS,
    HYBRID_SEARCH_ENABLED,
    settings,
)
from lib.langfuse_tracing import langfuse
from packages.rag import (
    build_question_answer_engine,
    convert_document,
    document_embedding_model,
    document_node_parser,
    document_vector_store,
    generate_question_answer,
    ingest_document,
    ingest_nasa_archive,
)


def health() -> int:
    """Check PostgreSQL connectivity."""
    try:
        connection = psycopg2.connect(
            settings.database_url.get_secret_value(),
            connect_timeout=5,
            options="-c statement_timeout=5000",
        )
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                if cursor.fetchone() != (1,):
                    print("Database check failed: unexpected result.", file=sys.stderr)
                    return 1
        finally:
            connection.close()
    except psycopg2.Error:
        print(
            "Database check failed: check DATABASE_URL and PostgreSQL availability.",
            file=sys.stderr,
        )
        return 1
    print("Database OK.")
    return 0


def preview_document(document_path: Path, chunk_max_tokens: int, limit: int) -> int:
    """Print the first limit chunks as serialized LlamaIndex nodes."""
    try:
        documents = convert_document(document_path)
        nodes = document_node_parser(chunk_max_tokens).get_nodes_from_documents(
            documents
        )
        if not nodes:
            print("Document preview failed: no text chunks produced.", file=sys.stderr)
            return 1

        print(
            json.dumps(
                [node.to_dict() for node in nodes[:limit]],
                ensure_ascii=False,
                indent=2,
            )
        )
    except (
        ImportError,
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        BadZipFile,
        DefusedXmlException,
        ParseError,
    ) as error:
        print(
            f"Document preview failed ({type(error).__name__}): {error}",
            file=sys.stderr,
        )
        return 1
    return 0


@propagate_attributes(tags=["nasa-rag", "retrieve-documents"])
@observe(name="retrieve-documents", capture_input=False, capture_output=False)
def retrieve_documents(query: str, top_k: int) -> int:
    """Print retrieved passages and similarity scores as JSON."""
    langfuse.update_current_span(input=query)
    if not query.strip():
        langfuse.update_current_span(
            level="ERROR", status_message="Query must not be blank"
        )
        print("Document retrieval failed: query must not be blank.", file=sys.stderr)
        return 1
    try:
        index = VectorStoreIndex.from_vector_store(
            document_vector_store(), embed_model=document_embedding_model()
        )
        nodes = index.as_retriever(
            similarity_top_k=top_k,
            sparse_top_k=top_k,
            vector_store_query_mode="hybrid" if HYBRID_SEARCH_ENABLED else "default",
        ).retrieve(query)
        langfuse.update_current_span(output=[node.to_dict() for node in nodes])
        if not nodes:
            print("No matching passages found.", file=sys.stderr)
        print(
            json.dumps([node.to_dict() for node in nodes], ensure_ascii=False, indent=2)
        )
    except (APIError, SQLAlchemyError, ValueError) as error:
        langfuse.update_current_span(level="ERROR", status_message=type(error).__name__)
        print(
            f"Document retrieval failed ({type(error).__name__}).",
            "Check database availability, OpenAI credentials, and embedding settings.",
            file=sys.stderr,
        )
        return 1
    return 0


def answer_question(query: str) -> int:
    """Print the structured question answer and citation sources for the CLI."""
    try:
        engine = build_question_answer_engine()
        result = generate_question_answer(query, engine)
        print(result.answer)
        print(
            json.dumps(
                [node.to_dict() for node in result.source_nodes],
                ensure_ascii=False,
                indent=2,
            )
        )
    except (APIError, CohereAPIError, SQLAlchemyError, ValueError) as error:
        print(
            f"Question answering failed ({type(error).__name__}).",
            "Check database availability and provider settings.",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Run a CLI command and return its exit status."""

    def positive_integer(value: str) -> int:
        number = int(value)
        if number < 1:
            raise argparse.ArgumentTypeError("Expected a positive integer")
        return number

    parser = argparse.ArgumentParser(description="NASA RAG CLI")
    commands = parser.add_subparsers(dest="command", required=True)
    _ = commands.add_parser("health", help="Check database connectivity")
    ingest = commands.add_parser(
        "ingest-nasa-single",
        help="Index one NASA PDF or EPUB; requires adjacent metadata.json",
    )
    _ = ingest.add_argument("document", type=Path)
    archive = commands.add_parser(
        "ingest-nasa", help="Index a NASA archive with parallel book workers"
    )
    _ = archive.add_argument(
        "directory", nargs="?", type=Path, help="Defaults to NASA_ARCHIVE_DIR"
    )
    _ = archive.add_argument(
        "--format", choices=("auto", "pdf", "epub"), default="auto"
    )
    _ = archive.add_argument(
        "--dry-run", action="store_true", help="List selected files without ingestion"
    )
    _ = archive.add_argument(
        "--limit",
        type=positive_integer,
        help="Process only the first N selected documents",
    )
    _ = archive.add_argument(
        "--concurrency",
        type=positive_integer,
        default=2,
        help="Concurrent book processes (default: 2; use 1 for sequential ingestion).",
    )
    retrieve = commands.add_parser(
        "retrieve", help="Retrieve hybrid candidates without reranking or generation"
    )
    _ = retrieve.add_argument("query")
    _ = retrieve.add_argument(
        "--top-k",
        type=positive_integer,
        default=5,
        help="Candidates per vector/keyword search; combined results are deduplicated.",
    )
    ask = commands.add_parser("ask", help="Answer a question with built-in citations")
    _ = ask.add_argument("query")
    preview = commands.add_parser(
        "preview", help="Preview PDF or EPUB chunks without API calls"
    )
    _ = preview.add_argument("document", type=Path)
    _ = preview.add_argument(
        "--chunk-max-tokens", type=positive_integer, default=CHUNK_MAX_TOKENS
    )
    _ = preview.add_argument(
        "--limit",
        type=positive_integer,
        default=3,
        help="Chunks to print; the entire document is still converted",
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "health":
            return health()
        if args.command == "ingest-nasa-single":
            return ingest_document(args.document)
        if args.command == "ingest-nasa":
            return ingest_nasa_archive(
                args.directory, args.format, args.dry_run, args.limit, args.concurrency
            )
        if args.command == "retrieve":
            return retrieve_documents(args.query, args.top_k)
        if args.command == "ask":
            return answer_question(args.query)
        return preview_document(args.document, args.chunk_max_tokens, args.limit)
    finally:
        langfuse.flush()


if __name__ == "__main__":
    raise SystemExit(main())
