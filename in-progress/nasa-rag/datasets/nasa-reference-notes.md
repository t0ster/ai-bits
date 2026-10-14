# NASA reference dataset design and validation

Created on 5 October 2026, this is a 30-item synthetic starter dataset for source-grounded NASA RAG. It contains 27 ordinary answerable questions, two abstention cases, and one supported false-premise correction. All references remain **synthetic and not human reviewed**. They are source-relative targets, not independently established historical truth.

[Hosted dataset](https://cloud.langfuse.com/project/cmutrxww205r3ad0hbswtgk1e/datasets/cmuughjkr1bqpad0dcxb8dk82) · [Local rows](nasa-reference-v1.json)

## Guidance and decisions

[Ragas test generation](https://docs.ragas.io/en/stable/concepts/test_data_generation/rag/) builds scenarios from source nodes and relationships, varying query types and producing a query, reference, and supporting contexts. For the original 15 rows, we followed those principles with small source-conditioned batches instead of installing or running its knowledge-graph generator. Those original rows are Ragas-compatible data, not output from Ragas TestsetGenerator. The additional 15 rows are imported from the existing Ragas export.

[Langfuse dataset design](https://langfuse.com/academy/datasets/designing-great-datasets) recommends starting with 15–30 rows, defining useful slices, enforcing consistent input/reference shapes, including high-risk cases, deduplicating, and treating traces as seeds rather than ground truth. Our 12/2/1 mix is a deliberate design choice, not an official ratio or estimated production distribution. [Langfuse's chatbot example](https://langfuse.com/blog/2026-07-16-steal-our-eval-setup) separately checks correctness and expected behavior, including deferring out-of-scope requests. That informed our behavioral edge cases.

## Coverage and provenance

The frozen index contains 2,969 chunks from ten NASA books. We selected 20 substantive candidate chunks, generated five three-question batches with `codex/gpt-6-sol`, retained 12 questions, and added three behavioral edge cases. The original 15 rows use 13 supporting chunks across all ten books. The source snapshot also retains unused generation candidates for reproducibility and one additional Surveyor chunk.

The original question mix is five factual, five explanatory, two multi-source comparisons, one unrelated sourdough request, one unsupported fiscal-year 2027 funding question, and one Surveyor false-premise correction. Topics include X-15 reentry, pressure suits, capsule dynamics, NASA emblems and policy, engine loads, transport design, wind-shear detection, and lunar landers. Coverage is deliberately broad for a small set; it is neither exhaustive nor sampled from real user traffic.

References were generated directly from indexed book text, independently of production RAG responses. Each supported row stores exact quotes, document and chunk IDs, chunk positions, text hashes, full reference contexts, and provenance. The two abstention rows have no invented evidence or reference contexts. A full-corpus scan found no `sourdough` or standalone `2027`; substring matches for 2027 were identifiers, report numbers, or contract numbers. This is evidence of an indexing-scope gap, not proof that no 2027 budget exists elsewhere.

## Validation

All 30 rows passed structural, unique-question, near-duplicate text, source-ID, source-hash, and exact-quote checks. All 59 evidence entries are verbatim indexed text. The original 40 quotes had their normalized first 18 words matched against the corresponding original EPUBs; that EPUB check was not repeated for imported rows. Prefix matching is an additional provenance check, not full EPUB equivalence.

A separate `codex/gpt-6-astra` review checked support, completeness, ambiguity, distinctness, and evidence sufficiency for every original row. Four rows required fuller references or evidence qualifiers. Those were revised and re-reviewed; the final 15 passed. Initial findings and revised judgments are retained. The coding assistant additionally spot-checked eight rows against their evidence. Neither process is human review; generator and reviewer may share systematic errors.

The Surveyor source contains an unrelated Apollo 12 date error. Its correction reference uses only the supported seven-sent/five-successful statement and does not repeat or silently repair that date. Other source or extraction errors may remain. Human review is needed before treating the set as a release gate.

Run deterministic checks without model calls:

```sh
uv run python datasets/validate_nasa_reference.py
```

## Imported Ragas selection

Appended 15 unchanged rows from `nasa-rag-testset-200-chunks-400.json` (169 rows), SHA-256 `31c176152807905aa7351227a6d8ba2023080da8809ab8b780a2db68052bc33e`. Zero-based row indices: 3, 4, 24, 33, 39, 41, 54, 55, 66, 77, 88, 140, 149, 156, 160. Original 15 remote records were preserved in full.

Selected nine single-hop-specific, two multi-hop-abstract, and four multi-hop-specific rows. These are original Ragas synthesizer labels, not independently proven reasoning requirements. All 19 imported contexts exactly match indexed chunks after removing only a leading `<N-hop>` label for comparison; stored contexts retain those labels. All matched chunks occur in the 400-chunk selection manifest. Questions, references, original fields, spelling, and contexts remain unchanged. Generator model is unknown from this export.

Selection favored substantive, distinct questions and excluded bibliography-only evidence. Separate `codex/gpt-6-astra` checks passed all selected rows. Candidate row 95 was rejected because its reference turned a model-testing purpose into a verified result; unchanged row 66 replaced it. Row 24 retains the source's F-102/F-106 speed statements; source support does not independently establish aircraft performance accuracy. Imported rows remain synthetic and not human reviewed.

`nasa-reference-v1.ragas-selection.json` preserves original questions and answers (copied reference passages removed), source matches, source/manifest hashes, selection criteria, rejected candidate, and all selection review judgments. Import IDs use UUID5 over dataset ID, source hash, and zero-based row index. Original generation/review artifacts describe the original 15; the selection artifact describes the appended 15. Deterministic validation covers all 30, with 28 eligible for reference metrics.

## Ragas mapping and future metric routing

| Ragas field | Stored value |
| --- | --- |
| `user_input` | Langfuse item `input` |
| `reference` | Langfuse item `expectedOutput` / local `expected_output` |
| Reference passage text | Resolve retained source IDs against the local source snapshot; not copied into item metadata |
| `reference_context_ids` | Item `metadata.reference_context_ids` |
| `response` | Future RAG answer, never the reference |
| `retrieved_contexts` | Future actual retrieval or synthesis passages; choose and label the pipeline stage |

[Ragas Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/) tests whether retrieved contexts support reference claims. [Reference-based Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/) assesses retrieved-context relevance against a reference. [Factual Correctness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/factual_correctness/) compares generated response claims with reference claims. These are distinct from the three existing hosted categorical evaluators.

Evaluation rules must implement these branches explicitly; metadata does not route or skip anything automatically:

- `expected_behavior=answer`: apply reference metrics and ordinary answer checks.
- `expected_behavior=abstain`: skip reference-based context recall, precision, and factual-correctness aggregates. Check appropriate abstention and absence of fabricated details; do not fail an appropriate refusal merely for having no numbered citation.
- `expected_behavior=correct_premise`: check explicit premise correction. This row has a factual reference and supporting evidence, so reference metrics remain eligible. Report its behavior score separately from ordinary answers.

Use `expected_behavior` to exclude `abstain` cases from reference-based scores and report slice counts. Both experiment stages run all 30 items; the runner copies expected behavior into observation metadata for hosted rule filtering. The retrieval rule selects the retrieval tag and excludes abstention cases; context recall maps its answer variable to the dataset expected output. The generation rule selects the generation tag and applies groundedness to all items. Both rules use full sampling. No full RAG/evaluation run was performed during this metadata migration.

## Saved artifacts

- `nasa-reference-v1.json`: canonical 30 rows and corpus fingerprint.
- `nasa-reference-v1.sources.json`: frozen source text and provenance.
- `nasa-reference-v1.generation.json`: generator prompt, schema, source groups, selection, and revisions. Regeneration is stochastic; the frozen artifact is the reproducible benchmark.
- `nasa-reference-v1.review.json`: initial and final automated judgments, review prompt, and reviewed-content fingerprint.
- `nasa-reference-v1.validation.json`: deterministic results and original-EPUB prefix checks.
- `nasa-reference-v1.upload.json`: remote dataset identity and verified field/count receipt.

Upload used stable UUIDs so repeating the same rows upserts rather than duplicates. Remote read-back confirmed all 30 IDs, inputs, expected outputs, and metadata matched exactly. Behavior counts are 27 answers, two abstentions, and one correction. No files were committed or pushed.
