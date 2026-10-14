"""NASA RAG engine: document ingestion, retrieval, and cited question answering."""

import hashlib
import json
import multiprocessing
import platform
import sys
from collections.abc import Sequence
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import override
from xml.etree.ElementTree import ParseError
from zipfile import BadZipFile

import tiktoken
from defusedxml.common import DefusedXmlException
from docling.datamodel.accelerator_options import (
    AcceleratorDevice,
    AcceleratorOptions,
)
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.transforms.chunker.tokenizer.openai import OpenAITokenizer
from langfuse import observe, propagate_attributes
from llama_index.core import Document, VectorStoreIndex
from llama_index.core.ingestion import DocstoreStrategy, IngestionPipeline
from llama_index.core.postprocessor.types import BaseNodePostprocessor
from llama_index.core.prompts import PromptTemplate
from llama_index.core.query_engine import CitationQueryEngine
from llama_index.core.schema import (
    BaseNode,
    MetadataMode,
    NodeWithScore,
    QueryBundle,
    TransformComponent,
)
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai_like import OpenAILike
from llama_index.node_parser.docling import DoclingNodeParser
from llama_index.postprocessor.cohere_rerank import CohereRerank
from llama_index.readers.docling import DoclingReader
from llama_index.storage.docstore.postgres import PostgresDocumentStore
from llama_index.storage.kvstore.postgres import PostgresKVStore
from llama_index.vector_stores.postgres import PGVectorStore
from openai import APIError
from pydantic import BaseModel, Field
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from lib.config import (
    CHUNK_MAX_TOKENS,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    HYBRID_SEARCH_ENABLED,
    INDEX_VERSION,
    QUESTION_TOP_K,
    RERANKING_ENABLED,
    RERANKING_TOP_N,
    settings,
)
from lib.docling_epub import convert_epub_document
from lib.langfuse_tracing import langfuse

# --- Storage ---


def document_vector_store() -> PGVectorStore:
    """Connect to the document vector store in PostgreSQL."""
    url = make_url(settings.database_url.get_secret_value())
    return PGVectorStore.from_params(
        table_name=f"llamaindex_{INDEX_VERSION}",
        connection_string=url.set(drivername="postgresql+psycopg2").render_as_string(
            hide_password=False
        ),
        async_connection_string=url.set(
            drivername="postgresql+asyncpg"
        ).render_as_string(hide_password=False),
        embed_dim=EMBEDDING_DIMENSIONS,
        hybrid_search=HYBRID_SEARCH_ENABLED,
        text_search_config="english",
        use_jsonb=True,
        indexed_metadata_keys={
            ("title", "text"),
            ("collection", "text"),
            ("language", "text"),
            ("authors", "text[]"),
            ("subjects", "text[]"),
        },
    )


def document_embedding_model() -> OpenAIEmbedding:
    """Create the OpenAI embedding client for documents and queries."""
    return OpenAIEmbedding(
        model=EMBEDDING_MODEL,
        dimensions=EMBEDDING_DIMENSIONS,
        api_key=settings.openai_api_key.get_secret_value(),
    )


def document_docstore() -> PostgresDocumentStore:
    """Create the versioned document store with process-local database clients."""
    url = make_url(settings.database_url.get_secret_value()).set(
        drivername="postgresql+psycopg2"
    )
    connection_string = url.render_as_string(hide_password=False)
    async_connection_string = url.set(drivername="postgresql+asyncpg").render_as_string(
        hide_password=False
    )
    # docstore 0.6.0's from_uri passes an unsupported kwarg to kvstore 0.4.3.
    return PostgresDocumentStore(
        PostgresKVStore.from_params(
            connection_string=connection_string,
            async_connection_string=async_connection_string,
            table_name=f"docstore_{INDEX_VERSION}",
            use_jsonb=True,
        )
    )


# --- Indexing ---


class BookMetadata(BaseModel):
    """Fields read from a NASA publication's metadata.json."""

    title: str = Field(min_length=1)
    authors: list[str] | None = None
    collection: str | None = None
    language: str | None = None
    subjects: list[str] | None = None


def get_nasa_ebook_id(metadata: dict) -> str:
    """Generate a stable document ID from the normalized title and authors."""

    def normalize(value: str) -> str:
        return " ".join(value.casefold().split())

    identity = {
        "title": normalize(metadata["title"]),
        "authors": sorted(
            normalize(author) for author in metadata.get("authors") or []
        ),
    }
    canonical = json.dumps(identity, sort_keys=True, ensure_ascii=False)
    return "nasa:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def convert_document(document_path: Path) -> list[Document]:
    """Convert a PDF or EPUB to a LlamaIndex document containing Docling JSON."""
    if not document_path.is_file() or document_path.suffix.lower() not in {
        ".pdf",
        ".epub",
    }:
        raise ValueError("Expected an existing PDF or EPUB file")

    print(f"Converting document: {document_path.name}", file=sys.stderr, flush=True)
    if document_path.suffix.lower() == ".pdf":
        # Community Torch advertises MPS on Intel, but this backend needs unified memory.
        intel_mac = sys.platform == "darwin" and platform.machine() == "x86_64"
        device = AcceleratorDevice.CPU if intel_mac else AcceleratorDevice.AUTO
        options = PdfPipelineOptions(
            accelerator_options=AcceleratorOptions(device=device)
        )
        converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
        )
        reader = DoclingReader(
            export_type=DoclingReader.ExportType.JSON, doc_converter=converter
        )
        return reader.load_data(str(document_path.resolve()))
    document = convert_epub_document(document_path)
    return [Document(text=json.dumps(document.export_to_dict()))]


def document_node_parser(chunk_max_tokens: int) -> DoclingNodeParser:
    """Create a HybridChunker using the embedding model's tokenizer."""
    tokenizer = OpenAITokenizer(
        tokenizer=tiktoken.encoding_for_model(EMBEDDING_MODEL),
        max_tokens=chunk_max_tokens,
    )
    return DoclingNodeParser(chunker=HybridChunker(tokenizer=tokenizer))


class AssignChunkPositions(TransformComponent):
    """Store zero-based chunk positions per source book without changing model context."""

    @classmethod
    @override
    def class_name(cls) -> str:
        return "AssignChunkPositions"

    @override
    def __call__(
        self, nodes: Sequence[BaseNode], **kwargs: object
    ) -> Sequence[BaseNode]:
        positions: dict[str, int] = {}
        for node in nodes:
            book_id = node.ref_doc_id
            if book_id is None:
                raise ValueError("Chunk position assignment requires a source book ID")
            position = positions.get(book_id, 0)
            node.metadata["chunk_index"] = position
            positions[book_id] = position + 1
            for excluded in (
                node.excluded_embed_metadata_keys,
                node.excluded_llm_metadata_keys,
            ):
                if "chunk_index" not in excluded:
                    excluded.append("chunk_index")
        return nodes


def ingestion_fingerprint(document_path: Path, metadata: dict) -> str:
    """Fingerprint document content, metadata, and pipeline settings for change detection."""
    with document_path.open("rb") as source:
        content_hash = hashlib.file_digest(source, "sha256").hexdigest()
    fingerprint = {
        "content_hash": content_hash,
        "source_file": document_path.name,
        "source_format": document_path.suffix.lower(),
        "metadata": metadata,
        # Renaming this key would invalidate existing fingerprints.
        "max_tokens": CHUNK_MAX_TOKENS,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dimensions": EMBEDDING_DIMENSIONS,
        # Increment when conversion or metadata handling changes.
        "pipeline_version": 3,
        "packages": {
            package: version(package)
            for package in (
                "docling",
                "docling-core",
                "docling-parse",
                "llama-index-core",
                "llama-index-readers-docling",
                "llama-index-node-parser-docling",
                "llama-index-embeddings-openai",
                "tiktoken",
            )
        },
    }
    canonical = json.dumps(fingerprint, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@propagate_attributes(tags=["nasa-rag", "ingest-document"])
@observe(name="ingest-document", capture_input=False, capture_output=False)
def ingest_document(document_path: Path) -> int:
    """Index a NASA document and its sidecar metadata, skipping unchanged content."""
    langfuse.update_current_span(input=document_path.name)
    try:
        if not document_path.is_file() or document_path.suffix.lower() not in {
            ".pdf",
            ".epub",
        }:
            raise ValueError("Expected an existing PDF or EPUB file")
        sidecar = document_path.with_name("metadata.json")
        metadata = BookMetadata.model_validate_json(sidecar.read_text()).model_dump(
            exclude_none=True
        )
        if not metadata["title"].strip():
            raise ValueError("Document metadata title must not be blank")
        metadata["authors"] = metadata.get("authors") or []
        metadata["subjects"] = metadata.get("subjects") or []
        document_id = get_nasa_ebook_id(metadata)
        fingerprint = ingestion_fingerprint(document_path, metadata)
        docstore = document_docstore()
        previous = docstore.get_document(document_id, raise_error=False)
        if previous and previous.metadata.get("ingestion_fingerprint") == fingerprint:
            print(f"Skipped unchanged document: {metadata['title']} ({document_id})")
            langfuse.update_current_span(
                output={"status": "unchanged", "document_id": document_id}
            )
            return 0

        documents = convert_document(document_path)
        if len(documents) != 1:
            raise ValueError("Expected one converted document per input file")
        document = documents[0]
        document.id_ = document_id
        document.metadata = {
            **metadata,
            "source_file": document_path.name,
            "source_format": document_path.suffix.lower().lstrip("."),
            "ingestion_fingerprint": fingerprint,
        }
        document.excluded_embed_metadata_keys = [
            "source_file",
            "source_format",
            "ingestion_fingerprint",
        ]
        document.excluded_llm_metadata_keys = list(
            document.excluded_embed_metadata_keys
        )
        pipeline = IngestionPipeline(
            transformations=[
                document_node_parser(CHUNK_MAX_TOKENS),
                AssignChunkPositions(),
                document_embedding_model(),
            ],
            docstore=docstore,
            vector_store=document_vector_store(),
            docstore_strategy=DocstoreStrategy.UPSERTS,
        )
        nodes = pipeline.run(documents=documents)
        langfuse.update_current_span(
            output={
                "status": "indexed",
                "document_id": document_id,
                "chunks": len(nodes),
            }
        )
        print(f"Indexed {len(nodes)} chunks: {metadata['title']} ({document_id})")
    except (
        ImportError,
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        BadZipFile,
        DefusedXmlException,
        ParseError,
        APIError,
        SQLAlchemyError,
    ) as error:
        langfuse.update_current_span(level="ERROR", status_message=type(error).__name__)
        # Exception messages can include credentials; log only the exception type.
        print(f"Document ingestion failed ({type(error).__name__}).", file=sys.stderr)
        return 1
    return 0


def ingest_document_worker(document_path: Path) -> int:
    """Ingest one book in a spawned process and flush that process's traces."""
    print(document_path, flush=True)
    try:
        return ingest_document(document_path)
    finally:
        langfuse.flush()


def ingest_nasa_archive(
    directory: Path | None,
    document_format: str,
    dry_run: bool,
    limit: int | None,
    concurrency: int = 2,
) -> int:
    """Ingest one PDF or EPUB per document directory in a NASA archive."""
    directory = directory if directory is not None else settings.nasa_archive_dir
    if directory is None:
        print(
            "NASA ingestion failed: provide a directory or set NASA_ARCHIVE_DIR.",
            file=sys.stderr,
        )
        return 1
    directory = directory.expanduser()
    if not directory.is_dir():
        print(f"NASA ingestion failed: not a directory: {directory}", file=sys.stderr)
        return 1

    try:
        candidates: dict[Path, list[Path]] = {}
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path.suffix.lower() in {".pdf", ".epub"}:
                candidates.setdefault(path.parent, []).append(path)
        selected: list[Path] = []
        for paths in candidates.values():
            formats = (
                ("epub", "pdf") if document_format == "auto" else (document_format,)
            )
            for source_format in formats:
                matches = [
                    path for path in paths if path.suffix.lower() == f".{source_format}"
                ]
                if matches:
                    selected.append(matches[0])
                    break
        selected = selected[:limit]
    except OSError as error:
        print(f"NASA discovery failed ({type(error).__name__}).", file=sys.stderr)
        return 1

    if dry_run:
        for document_path in selected:
            print(document_path, flush=True)
        print(f"Selected {len(selected)} documents (dry run).")
        return 0
    if concurrency < 1:
        raise ValueError("NASA ingestion concurrency must be positive")
    failures = 0
    if concurrency == 1 or len(selected) < 2:
        for document_path in selected:
            failures += ingest_document_worker(document_path)
    else:
        # Spawn avoids inheriting database connections and telemetry threads.
        with ProcessPoolExecutor(
            max_workers=min(concurrency, len(selected)),
            mp_context=multiprocessing.get_context("spawn"),
        ) as executor:
            jobs = {
                executor.submit(ingest_document_worker, path): path for path in selected
            }
            for future in as_completed(jobs):
                try:
                    failures += future.result()
                except Exception as error:  # noqa: BLE001 - isolate worker failures
                    # Provider exceptions may contain credentials; never print messages.
                    print(
                        f"Document worker failed: {jobs[future].name} ({type(error).__name__}).",
                        file=sys.stderr,
                    )
                    failures += 1
    print(f"Processed {len(selected)} documents; {failures} failed.")
    return 1 if failures else 0


# --- Question answering (public interface) ---


# Explicit copies of llama-index-core 0.14.25 citation defaults.
# Source: llama_index/core/query_engine/citation_query_engine.py
CITATION_ANSWER_PROMPT = PromptTemplate(
    "Please provide an answer based solely on the provided sources. "
    "When referencing information from a source, "
    "cite the appropriate source(s) using their corresponding numbers. "
    "Every answer should include at least one source citation. "
    "Only cite a source when you are explicitly referencing it. "
    "If none of the sources are helpful, you should indicate that. "
    "For example:\n"
    "Source 1:\n"
    "The sky is red in the evening and blue in the morning.\n"
    "Source 2:\n"
    "Water is wet when the sky is red.\n"
    "Query: When is water wet?\n"
    "Answer: Water will be wet when the sky is red [2], "
    "which occurs in the evening [1].\n"
    "Now it's your turn. Below are several numbered sources of information:"
    "\n------\n"
    "{context_str}"
    "\n------\n"
    "Query: {query_str}\n"
    "Answer: "
)

CITATION_ANSWER_REFINE_PROMPT = PromptTemplate(
    "Please provide an answer based solely on the provided sources. "
    "When referencing information from a source, "
    "cite the appropriate source(s) using their corresponding numbers. "
    "Every answer should include at least one source citation. "
    "Only cite a source when you are explicitly referencing it. "
    "If none of the sources are helpful, you should indicate that. "
    "For example:\n"
    "Source 1:\n"
    "The sky is red in the evening and blue in the morning.\n"
    "Source 2:\n"
    "Water is wet when the sky is red.\n"
    "Query: When is water wet?\n"
    "Answer: Water will be wet when the sky is red [2], "
    "which occurs in the evening [1].\n"
    "Now it's your turn. "
    "We have provided an existing answer: {existing_answer}"
    "Below are several numbered sources of information. "
    "Use them to refine the existing answer. "
    "If the provided sources are not helpful, you will repeat the existing answer."
    "\nBegin refining!"
    "\n------\n"
    "{context_msg}"
    "\n------\n"
    "Query: {query_str}\n"
    "Answer: "
)


@dataclass(frozen=True)
class QuestionAnswerEngine:
    """Reuse retrieval, reranking, and citation synthesis clients across questions."""

    citation_engine: CitationQueryEngine
    reranker: BaseNodePostprocessor | None


def build_question_answer_engine() -> QuestionAnswerEngine:
    """Build the answer engine with source-grounded factual coverage and numbered citations."""
    index = VectorStoreIndex.from_vector_store(
        document_vector_store(), embed_model=document_embedding_model()
    )
    citation_engine = CitationQueryEngine.from_args(
        index,
        similarity_top_k=QUESTION_TOP_K,
        sparse_top_k=QUESTION_TOP_K,
        vector_store_query_mode="hybrid" if HYBRID_SEARCH_ENABLED else "default",
        citation_qa_template=CITATION_ANSWER_PROMPT,
        citation_refine_template=CITATION_ANSWER_REFINE_PROMPT,
        llm=OpenAILike(
            model=settings.generation_model,
            api_base=str(settings.generation_base_url),
            api_key=settings.generation_api_key.get_secret_value(),
            context_window=100_000,
            is_chat_model=True,
        ),
    )
    reranker = None
    if RERANKING_ENABLED:
        reranker = CohereRerank(
            top_n=RERANKING_TOP_N,
            model=settings.rerank_model,
            api_key=settings.cohere_api_key.get_secret_value(),
        )
        reranker.callback_manager = citation_engine.callback_manager
    return QuestionAnswerEngine(citation_engine=citation_engine, reranker=reranker)


def node_contexts(nodes: Sequence[NodeWithScore]) -> list[str]:
    """Render passages with the metadata the LLM sees."""
    return [node.node.get_content(metadata_mode=MetadataMode.LLM) for node in nodes]


@dataclass(frozen=True)
class QuestionRetrievalResult:
    """Preserve original and selected chunks before answer synthesis."""

    retrieved_nodes: tuple[NodeWithScore, ...]
    reranked_nodes: tuple[NodeWithScore, ...]

    @property
    def reranked_contexts(self) -> list[str]:
        """Return passages in reranker order."""
        return node_contexts(self.reranked_nodes)


def retrieve_question_context(
    query: str, engine: QuestionAnswerEngine
) -> QuestionRetrievalResult:
    """Retrieve and optionally rerank chunks without generating an answer."""
    query_bundle = QueryBundle(query)
    retrieved_nodes = engine.citation_engine.retriever.retrieve(query_bundle)
    retrieved_snapshot = tuple(node.model_copy(deep=True) for node in retrieved_nodes)
    reranked_nodes = (
        engine.reranker.postprocess_nodes(retrieved_nodes, query_bundle=query_bundle)
        if engine.reranker is not None
        else retrieved_nodes
    )
    return QuestionRetrievalResult(
        retrieved_nodes=retrieved_snapshot,
        reranked_nodes=tuple(node.model_copy(deep=True) for node in reranked_nodes),
    )


@dataclass(frozen=True)
class QuestionAnswerResult:
    """Capture ordered passages, scores, and metadata before and after reranking."""

    question: str
    answer: str
    retrieved_nodes: tuple[NodeWithScore, ...]
    reranked_nodes: tuple[NodeWithScore, ...]
    source_nodes: tuple[NodeWithScore, ...]

    @property
    def reranked_contexts(self) -> list[str]:
        """Return passages in reranker order, before citation splitting."""
        return node_contexts(self.reranked_nodes)

    @property
    def citation_contexts(self) -> list[str]:
        """Return citation passages supplied to answer synthesis, including source labels."""
        return node_contexts(self.source_nodes)


@propagate_attributes(tags=["nasa-rag", "answer-question"])
@observe(name="answer-question", capture_input=False, capture_output=False)
def generate_question_answer(
    query: str, engine: QuestionAnswerEngine
) -> QuestionAnswerResult:
    """Return an answer and stage snapshots without printing or rebuilding the engine."""
    langfuse.update_current_span(input=query)
    retrieval = retrieve_question_context(query, engine)
    response = engine.citation_engine.synthesize(
        QueryBundle(query),
        [node.model_copy(deep=True) for node in retrieval.reranked_nodes],
    )
    langfuse.update_current_span(
        output=str(response),
        metadata={
            "retrieved_count": len(retrieval.retrieved_nodes),
            "reranked_count": len(retrieval.reranked_nodes),
        },
    )
    return QuestionAnswerResult(
        question=query,
        answer=str(response),
        retrieved_nodes=retrieval.retrieved_nodes,
        reranked_nodes=retrieval.reranked_nodes,
        source_nodes=tuple(
            node.model_copy(deep=True) for node in response.source_nodes
        ),
    )
