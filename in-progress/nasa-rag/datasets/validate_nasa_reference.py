"""Validate frozen NASA reference rows and exact source provenance without model calls."""

import hashlib
import json
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel, ConfigDict, Field


class ReferenceItem(BaseModel):
    """Keep question and reference as strings for Langfuse and Ragas adapters."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid")
    id: str
    input: str = Field(min_length=30)
    expected_output: str = Field(min_length=70)
    metadata: dict


def validate_reference_dataset() -> dict:
    """Check source hashes, exact quotes, question uniqueness, and scoring slices."""
    directory = Path(__file__).parent
    artifact = json.loads((directory / "nasa-reference-v1.json").read_text())
    sources = {
        source["node_id"]: source
        for source in json.loads(
            (directory / "nasa-reference-v1.sources.json").read_text()
        )
    }
    items = [ReferenceItem.model_validate(item) for item in artifact["items"]]
    assert len(items) == 30, "NASA reference dataset requires exactly 30 rows."
    assert len({item.id for item in items}) == 30, "Duplicate item IDs."
    questions = [" ".join(item.input.casefold().split()) for item in items]
    assert len(set(questions)) == 30, "Duplicate questions."
    similar_pairs = [
        [items[i].metadata["case_id"], items[j].metadata["case_id"]]
        for i in range(len(items))
        for j in range(i + 1, len(items))
        if SequenceMatcher(None, questions[i], questions[j]).ratio() > 0.8
    ]
    assert not similar_pairs, f"Review near-duplicate questions: {similar_pairs}"
    for source in sources.values():
        digest = hashlib.sha256(source["text"].encode()).hexdigest()
        assert digest == source["sha256"], "Source snapshot hash mismatch."
    quoted_evidence_count = 0
    documents = set()
    for item in items:
        metadata = item.metadata
        assert metadata["synthetic"] is True
        assert metadata["human_review_status"] == "unreviewed"
        ids = metadata["reference_context_ids"]
        assert len(ids) == len(set(ids)), "Duplicate source IDs within a row."
        if metadata.get("origin") == "ragas_import":
            original = metadata["provenance"]["original_row"]
            assert item.input == original["user_input"]
            assert item.expected_output == original["reference"]
            assert metadata["provenance"]["edits"] == []
        assert all(k in sources for k in ids), "Unknown source ID."
        assert {entry["node_id"] for entry in metadata["evidence"]} == set(ids)
        assert {entry["node_id"] for entry in metadata["source_documents"]} == set(ids)
        for entry in metadata["source_documents"]:
            source = sources[entry["node_id"]]
            for key in ("document_id", "title", "chunk_index", "sha256"):
                assert entry[key] == source[key], "Source identifier mismatch."
            documents.add(source["document_id"])
        for evidence in metadata["evidence"]:
            assert len(evidence["quote"]) >= 40, "Evidence quote too short."
            assert evidence["quote"] in sources[evidence["node_id"]]["text"]
            quoted_evidence_count += 1
        if metadata["answerability"] in ("answerable", "answerable_correction"):
            assert ids and metadata["expected_behavior"] in ("answer", "correct_premise")
        else:
            assert not ids and not metadata["evidence"]
            assert metadata["expected_behavior"] == "abstain"
            assert metadata["corpus_audit"]["matching_chunks"] == 0
        if metadata["question_type"] == "multi_source_comparison":
            assert len(ids) >= 2, "Multi-source question needs distinct chunks."
    distribution = Counter(item.metadata["question_type"] for item in items)
    assert distribution == {
        "factual": 5,
        "explanatory": 5,
        "multi_source_comparison": 2,
        "out_of_domain": 1,
        "in_domain_missing_evidence": 1,
        "false_premise": 1,
        "ragas_single_hop_specific": 9,
        "ragas_multi_hop_abstract": 2,
        "ragas_multi_hop_specific": 4,
    }
    return {
        "items": len(items),
        "documents": len(documents),
        "exact_evidence_quotes": quoted_evidence_count,
        "question_type_distribution": dict(distribution),
        "reference_answer_cases": sum(
            item.metadata["expected_behavior"] != "abstain" for item in items
        ),
        "near_duplicate_pairs": similar_pairs,
        "limitation": "Structural/provenance checks do not establish semantic support or historical truth.",
    }


if __name__ == "__main__":
    print(json.dumps(validate_reference_dataset(), indent=2))
