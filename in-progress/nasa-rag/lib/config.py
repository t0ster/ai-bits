"""RAG configuration; never render validation inputs or secrets."""

from pathlib import Path
from urllib.parse import urlsplit

from pydantic import HttpUrl, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INDEX_VERSION = "v1"
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
CHUNK_MAX_TOKENS = 1024
RERANKING_ENABLED = True
RERANKING_TOP_N = 20
HYBRID_SEARCH_ENABLED = False
QUESTION_TOP_K = 50


class Settings(BaseSettings):
    """Load RAG settings relative to the project, with environment overrides."""

    model_config = SettingsConfigDict(  # pyright: ignore[reportUnannotatedClassAttribute]
        env_file=(
            Path(__file__).parents[1] / ".env",
            Path(__file__).parents[1] / ".env.local",
        ),
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    environment: str
    database_url: SecretStr
    openai_api_key: SecretStr
    nasa_archive_dir: Path | None = None
    cohere_api_key: SecretStr
    rerank_model: str = "rerank-v3.5"
    generation_base_url: HttpUrl
    generation_api_key: SecretStr
    generation_model: str
    evals_testset_model: str = "gpt-6-astra"
    evals_llm_judge_model: str = "gpt-6-astra"
    # Env: CHAT_SPEED_MODELS='["model-a","model-b"]' (JSON list).
    chat_speed_models: list[str] = [
        "gpt-5.5",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-6.1-sol",
        "gpt-6-astra",
    ]
    langfuse_public_key: SecretStr | None = None
    langfuse_secret_key: SecretStr | None = None
    langfuse_base_url: HttpUrl | None = None
    langfuse_tracing_enabled: bool = True

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr) -> SecretStr:
        """Accept PostgreSQL connection URLs without printing credentials."""
        parsed = urlsplit(value.get_secret_value())
        if (
            parsed.scheme not in {"postgresql", "postgres"}
            or not parsed.hostname
            or not parsed.path.strip("/")
        ):
            raise ValueError("Expected a PostgreSQL URL with host and database")
        _ = parsed.port
        return value

    @field_validator("openai_api_key", "cohere_api_key", "generation_api_key")
    @classmethod
    def validate_api_key(cls, value: SecretStr) -> SecretStr:
        """Reject empty provider credentials."""
        if not value.get_secret_value().strip():
            raise ValueError("Credential must not be empty")
        return value

    @field_validator(
        "rerank_model",
        "generation_model",
        "evals_testset_model",
        "evals_llm_judge_model",
    )
    @classmethod
    def validate_model_name(cls, value: str) -> str:
        """Reject empty provider model names."""
        if not value.strip():
            raise ValueError("Model must not be empty")
        return value

    @field_validator("chat_speed_models")
    @classmethod
    def validate_model_names(cls, value: list[str]) -> list[str]:
        """Require at least one model and reject empty names."""
        if not value:
            raise ValueError("Model list must not be empty")
        if any(not model.strip() for model in value):
            raise ValueError("Model names must not be empty")
        return value


# BaseSettings loads required fields from environment/dotenv at runtime.
settings = Settings()  # pyright: ignore[reportCallIssue]
