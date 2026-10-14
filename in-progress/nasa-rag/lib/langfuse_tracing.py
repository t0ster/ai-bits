"""Langfuse tracing for RAG operations and automatic LlamaIndex observations."""

from langfuse import Langfuse
from openinference.instrumentation.llama_index import LlamaIndexInstrumentor

from lib.config import settings

# Initialize once at application import; the SDK handles disabled tracing.
tracing_enabled = settings.langfuse_tracing_enabled and all(
    (
        settings.langfuse_public_key,
        settings.langfuse_secret_key,
        settings.langfuse_base_url,
    )
)
langfuse = Langfuse(
    public_key=settings.langfuse_public_key.get_secret_value()
    if settings.langfuse_public_key
    else "disabled",
    secret_key=settings.langfuse_secret_key.get_secret_value()
    if settings.langfuse_secret_key
    else "disabled",
    base_url=str(settings.langfuse_base_url).rstrip("/")
    if settings.langfuse_base_url
    else "http://localhost",
    tracing_enabled=tracing_enabled,
    environment=settings.environment,
)
if tracing_enabled:
    LlamaIndexInstrumentor().instrument()
