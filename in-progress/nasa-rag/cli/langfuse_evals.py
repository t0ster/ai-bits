"""Run retrieval then generation experiments: uv run cli/langfuse_evals.py --description "Baseline"
[--dataset-version <timestamp from Langfuse dataset version history>].

Hosted judges run asynchronously. Filter context precision/recall by the
rag-retrieval tag and answer judges by rag-generation. Map context to
output.context, generation output to output.answer, and reference to the
dataset expected output. The first run executes the full RAG pipeline once per
item and exposes retrieval context. The second exposes the saved answer and
citation context; it does not call the model again. Generation cost and internal
traces therefore belong to the first run. Use --mode retrieval to skip generation.
"""

import argparse

from langfuse import propagate_attributes
from langfuse.experiment import ExperimentItem

from lib.experiment_metadata import build_experiment_metadata, parse_dataset_version
from lib.langfuse_tracing import langfuse, tracing_enabled
from packages.rag import (
    QuestionAnswerResult,
    build_question_answer_engine,
    generate_question_answer,
    retrieve_question_context,
)

DATASET_NAME = "nasa-rag-reference-v1"


def prepare_experiment_question(item: ExperimentItem) -> tuple[str, str]:
    """Identify hosted dataset items and expose expected behavior for judge rules."""
    item_id = item.get("id") if isinstance(item, dict) else item.id
    question = item.get("input") if isinstance(item, dict) else item.input
    metadata = (item.get("metadata") if isinstance(item, dict) else item.metadata) or {}
    if not isinstance(item_id, str) or not item_id:
        raise ValueError("RAG experiment requires a hosted dataset item ID.")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("RAG experiment input must be a nonempty question.")
    langfuse.update_current_span(
        metadata={"expected_behavior": metadata["expected_behavior"]}
    )
    return item_id, question


def main() -> int:
    """Expose one RAG result per item in two separately scored experiment runs."""
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "--mode",
        choices=("retrieval", "both"),
        default="both",
        help="Run retrieval only (no answer generation), or both experiments (default).",
    )
    _ = parser.add_argument(
        "--description",
        required=True,
        help="Required run note describing what changed or what this experiment tests.",
    )
    _ = parser.add_argument(
        "--dataset-version",
        type=parse_dataset_version,
        help="Optional Langfuse dataset version timestamp; omit to use latest.",
    )
    args = parser.parse_args()
    args.description = args.description.strip()
    if not args.description:
        parser.error("--description must not be blank")
    if not tracing_enabled:
        raise RuntimeError("RAG experiment requires enabled Langfuse tracing.")

    try:
        run_metadata = build_experiment_metadata()
        dataset_version = args.dataset_version
        run_metadata["dataset_version"] = (
            dataset_version.isoformat() if dataset_version is not None else None
        )
        dataset = langfuse.get_dataset(DATASET_NAME, version=dataset_version)
        if not dataset.items:
            raise ValueError("RAG experiment dataset has no active questions.")
        engine = build_question_answer_engine()

        answer_results: dict[str, QuestionAnswerResult] = {}

        def retrieve_dataset_context(*, item: ExperimentItem, **_kwargs: object):
            item_id, question = prepare_experiment_question(item)
            if args.mode == "retrieval":
                contexts = retrieve_question_context(question, engine).reranked_contexts
            else:
                result = generate_question_answer(question, engine)
                answer_results[item_id] = result
                contexts = result.reranked_contexts
            context = "\n\n".join(contexts)
            return {"context": context}

        def generate_dataset_answer(*, item: ExperimentItem, **_kwargs: object):
            item_id, _question = prepare_experiment_question(item)
            result = answer_results[item_id]
            context = "\n\n".join(result.citation_contexts)
            return {"answer": result.answer, "context": context}

        with propagate_attributes(tags=["nasa-rag", "rag-retrieval", "langfuse"]):
            retrieval_result = dataset.run_experiment(
                name="Retrieval 1 (langfuse)",
                metadata={**run_metadata, "rag": "retrieval"},
                description=args.description,
                task=retrieve_dataset_context,
                max_concurrency=1,
            )
        print(retrieval_result.format())
        # The SDK logs task failures and omits them from item_results. Avoid an
        # incomplete generation experiment or silently retrieving failed items again.
        if len(retrieval_result.item_results) != len(dataset.items):
            print("Retrieval experiment failed; generation experiment was not started.")
            return 1

        if args.mode == "retrieval":
            print("Hosted judge scores arrive asynchronously at the run URL.")
            return 0

        with propagate_attributes(tags=["nasa-rag", "rag-generation", "langfuse"]):
            generation_result = dataset.run_experiment(
                name="Generation 1 (langfuse)",
                metadata={**run_metadata, "rag": "generation"},
                description=args.description,
                task=generate_dataset_answer,
                max_concurrency=1,
            )
        print(generation_result.format())
        print("Hosted judge scores arrive asynchronously at the run URLs.")
        return 0 if len(generation_result.item_results) == len(dataset.items) else 1
    finally:
        # Flush uploads observations; it does not wait for hosted judge scores.
        langfuse.flush()


if __name__ == "__main__":
    raise SystemExit(main())
