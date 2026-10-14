"""Score a Langfuse dataset with Ragas:
uv run cli/ragas_evals.py --dataset nasa-rag-reference-v1 --description "Baseline"
[--dataset-version <timestamp from Langfuse dataset version history>].

Use --mode retrieval to skip answer generation. Both mode generates once during
retrieval and shares each answer immediately with the generation scoring run. Ragas receives lists
of original selected chunks for retrieval and citation chunks for faithfulness.
Abstention items skip precision, recall, and answer relevancy. Faithfulness is
undefined for responses without factual claims; those receive no numeric score.
The ragas tag, without langfuse, excludes these runs from hosted judge rules.
"""

import argparse
import asyncio
import math
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, final

from langfuse import Evaluation, propagate_attributes
from langfuse.experiment import ExperimentItem
from langfuse.openai import AsyncOpenAI  # pyright: ignore[reportPrivateImportUsage]
from ragas.embeddings.openai_provider import OpenAIEmbeddings
from ragas.llms import llm_factory
from ragas.metrics.collections import (
    AnswerRelevancy,
    ContextPrecisionWithReference,
    ContextRecall,
    Faithfulness,
)
from ragas.metrics.result import MetricResult

from lib.config import EMBEDDING_MODEL, settings
from lib.experiment_metadata import build_experiment_metadata, parse_dataset_version
from lib.langfuse_tracing import langfuse, tracing_enabled
from packages.rag import (
    QuestionAnswerResult,
    build_question_answer_engine,
    generate_question_answer,
    retrieve_question_context,
)


def prepare_experiment_question(item: ExperimentItem) -> tuple[str, str]:
    """Identify the hosted item and validate its question."""
    item_id = item.get("id") if isinstance(item, dict) else item.id
    question = item.get("input") if isinstance(item, dict) else item.input
    if not isinstance(item_id, str) or not item_id:
        raise ValueError("Ragas experiment requires a hosted dataset item ID.")
    if not isinstance(question, str) or not question.strip():
        raise ValueError("Ragas experiment requires a nonempty question.")
    return item_id, question


@final
class ReciprocalRank:
    """Score the first useful retrieved chunk; no hit within the cutoff scores zero."""

    def __init__(self, relevance: ContextPrecisionWithReference) -> None:
        self.relevance = relevance

    async def ascore(
        self, user_input: str, reference: str, retrieved_contexts: list[str]
    ) -> MetricResult:
        """Use Ragas reference-based relevance judgments, independent of chunk IDs."""
        for rank, context in enumerate(retrieved_contexts, start=1):
            result = await self.relevance.ascore(
                user_input=user_input,
                reference=reference,
                retrieved_contexts=[context],
            )
            relevance = float(result.value)
            if not math.isfinite(relevance) or not 0 <= relevance <= 1:
                raise ValueError("Reciprocal rank received invalid relevance score")
            if relevance > 0.5:
                return MetricResult(value=1.0 / rank)
        return MetricResult(value=0.0)


@final
class RagasJudges:
    """Calculate Ragas metrics and reciprocal rank, retaining judge failures."""

    def __init__(self) -> None:
        llm = llm_factory(
            settings.evals_llm_judge_model,
            client=AsyncOpenAI(
                base_url=str(settings.generation_base_url),
                api_key=settings.generation_api_key.get_secret_value(),
            ),
        )
        embeddings = OpenAIEmbeddings(
            client=AsyncOpenAI(api_key=settings.openai_api_key.get_secret_value()),
            model=EMBEDDING_MODEL,
        )
        self.precision = ContextPrecisionWithReference(llm=llm)
        # self.reciprocal_rank = ReciprocalRank(self.precision)
        self.recall = ContextRecall(llm=llm)
        self.faithfulness = Faithfulness(llm=llm)
        self.relevancy = AnswerRelevancy(llm=llm, embeddings=embeddings)
        self.failures: list[str] = []

    async def score(self, name: str, metric: Any, **inputs: Any) -> list[Evaluation]:
        """Reject invalid scores; never report a judge failure as a zero."""
        try:
            with langfuse.start_as_current_observation(name=name, as_type="evaluator"):
                result = await metric.ascore(**inputs)
            value = float(result.value)
            if name == "faithfulness" and math.isnan(value):
                print("Skipped undefined faithfulness: no factual claims to score.")
                return []
            if not math.isfinite(value):
                raise ValueError("Ragas returned a nonfinite score")
            return [Evaluation(name=name, value=value)]
        except Exception:
            self.failures.append(name)
            raise

    async def retrieval(
        self,
        *,
        input: Any,
        output: Any,
        expected_output: Any,
        metadata: Any,
        **_kwargs: Any,
    ) -> list[Evaluation]:
        """Score original chunks against the reference, except abstention items."""
        if metadata["expected_behavior"] == "abstain":
            return []
        scores = []
        for name, metric in (
            ("context_precision", self.precision),
            ("context_recall", self.recall),
            # ("reciprocal_rank", self.reciprocal_rank),
        ):
            scores.extend(
                await self.score(
                    name,
                    metric,
                    user_input=input,
                    reference=expected_output,
                    retrieved_contexts=output["contexts"],
                )
            )
        return scores

    async def generation(
        self,
        *,
        input: Any,
        output: Any,
        metadata: Any,
        **_kwargs: Any,
    ) -> list[Evaluation]:
        """Score citation grounding, and relevancy only for non-abstention items."""
        scores = await self.score(
            "faithfulness",
            self.faithfulness,
            user_input=input,
            response=output["answer"],
            retrieved_contexts=output["contexts"],
        )
        if metadata["expected_behavior"] != "abstain":
            scores.extend(
                await self.score(
                    "answer_relevancy",
                    self.relevancy,
                    user_input=input,
                    response=output["answer"],
                )
            )
        return scores


def main() -> int:
    """Expose one RAG result per item in two separately scored experiment runs."""
    parser = argparse.ArgumentParser(description=__doc__)
    _ = parser.add_argument(
        "--dataset", required=True, help="Name of the Langfuse dataset to evaluate."
    )
    _ = parser.add_argument(
        "--mode",
        choices=("retrieval", "both"),
        default="both",
        help="Run retrieval only (no answer generation), or both experiments (default).",
    )
    _ = parser.add_argument(
        "--concurrency",
        type=int,
        default=2,
        help="Concurrent questions per experiment (default: 2).",
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
    args.dataset = args.dataset.strip()
    if not args.dataset:
        parser.error("--dataset must not be blank")
    args.description = args.description.strip()
    if not args.description:
        parser.error("--description must not be blank")
    if args.concurrency < 1:
        parser.error("--concurrency must be positive")
    if not tracing_enabled:
        raise RuntimeError("RAG experiment requires enabled Langfuse tracing.")

    try:
        run_metadata = build_experiment_metadata()
        dataset_version = args.dataset_version
        run_metadata["dataset_version"] = (
            dataset_version.isoformat() if dataset_version is not None else None
        )
        dataset = langfuse.get_dataset(args.dataset, version=dataset_version)
        if not dataset.items:
            raise ValueError("RAG experiment dataset has no active questions.")
        for item in dataset.items:
            metadata = item.metadata or {}
            if metadata.get("expected_behavior") not in {
                "answer",
                "correct_premise",
                "abstain",
            }:
                raise ValueError(
                    "Ragas dataset item requires recognized expected behavior."
                )
            if metadata["expected_behavior"] != "abstain" and not isinstance(
                item.expected_output, str
            ):
                raise ValueError(
                    "Ragas reference metrics require a reference answer string."
                )
        engine = build_question_answer_engine()

        retrieval_judges = RagasJudges()
        generation_judges = RagasJudges()
        answer_results: dict[str, Future[QuestionAnswerResult]] = {
            item.id: Future() for item in dataset.items
        }

        async def retrieve_dataset_context(*, item: ExperimentItem, **_kwargs: object):
            item_id, question = prepare_experiment_question(item)
            if args.mode == "retrieval":
                retrieval = await asyncio.to_thread(
                    retrieve_question_context, question, engine
                )
                contexts = retrieval.reranked_contexts
            else:
                try:
                    result = await asyncio.to_thread(
                        generate_question_answer, question, engine
                    )
                except Exception as error:
                    answer_results[item_id].set_exception(error)
                    raise
                answer_results[item_id].set_result(result)
                contexts = result.reranked_contexts
            return {"contexts": contexts}

        async def generate_dataset_answer(*, item: ExperimentItem, **_kwargs: object):
            item_id, _question = prepare_experiment_question(item)
            result = await asyncio.wrap_future(answer_results[item_id])
            return {
                "answer": result.answer,
                "contexts": result.citation_contexts,
            }

        def run_retrieval():
            try:
                with propagate_attributes(tags=["nasa-rag", "rag-retrieval", "ragas"]):
                    return dataset.run_experiment(
                        name="Retrieval",
                        metadata={**run_metadata, "rag": "retrieval"},
                        description=args.description,
                        task=retrieve_dataset_context,
                        evaluators=[retrieval_judges.retrieval],
                        max_concurrency=args.concurrency,
                    )
            finally:
                # Release consumers even if the SDK fails before executing a task.
                for future in answer_results.values():
                    if not future.done():
                        future.set_exception(
                            RuntimeError("Ragas answer production did not complete.")
                        )

        def run_generation():
            with propagate_attributes(tags=["nasa-rag", "rag-generation", "ragas"]):
                return dataset.run_experiment(
                    name="Generation",
                    metadata={**run_metadata, "rag": "generation"},
                    description=args.description,
                    task=generate_dataset_answer,
                    evaluators=[generation_judges.generation],
                    max_concurrency=args.concurrency,
                )

        if args.mode == "retrieval":
            results = [run_retrieval()]
        else:
            # Separate SDK event loops; each owns its judge clients. A shared
            # future releases generation scoring before retrieval scoring ends.
            with ThreadPoolExecutor(max_workers=2) as executor:
                retrieval_run = executor.submit(run_retrieval)
                generation_run = executor.submit(run_generation)
                results = [retrieval_run.result(), generation_run.result()]
        for result in results:
            print(result.format())
        print("Ragas scoring finished.")
        return (
            0
            if (
                all(
                    len(result.item_results) == len(dataset.items) for result in results
                )
                and not retrieval_judges.failures
                and not generation_judges.failures
            )
            else 1
        )
    finally:
        # Flush uploads observations
        langfuse.flush()


if __name__ == "__main__":
    raise SystemExit(main())
