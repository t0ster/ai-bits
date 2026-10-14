"""Build experiment run metadata shared by hosted and Ragas evaluations."""

import argparse
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from lib.config import (
    CHUNK_MAX_TOKENS,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    HYBRID_SEARCH_ENABLED,
    QUESTION_TOP_K,
    RERANKING_ENABLED,
    settings,
)


def build_experiment_metadata() -> dict[str, Any]:
    """Record code and configured pipeline settings, not an index snapshot."""
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=Path(__file__).resolve().parents[1],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return {
        "commit": commit,
        "index": {
            "embedding": EMBEDDING_MODEL,
            "embedding_dimensions": EMBEDDING_DIMENSIONS,
            "chunking": "docling.HybridChunker",
            "chunk_max_tokens": CHUNK_MAX_TOKENS,
        },
        "top_k": QUESTION_TOP_K,
        "retrieval_mode": "hybrid" if HYBRID_SEARCH_ENABLED else "default",
        "sparse_top_k": QUESTION_TOP_K if HYBRID_SEARCH_ENABLED else None,
        "reranking": RERANKING_ENABLED,
        "generation_llm": settings.generation_model,
        # Hosted judges are configured independently in Langfuse rules.
        "judge_llm": settings.evals_llm_judge_model,
    }


def parse_dataset_version(value: str) -> datetime:
    """Parse a timezone-aware dataset version timestamp for repeatable experiments."""
    try:
        version = datetime.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            "Dataset version must be an ISO timestamp."
        ) from error
    if version.tzinfo is None:
        raise argparse.ArgumentTypeError("Dataset version must include a timezone.")
    return version.astimezone(UTC)
