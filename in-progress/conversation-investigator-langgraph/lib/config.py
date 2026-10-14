"""Environment settings shared by the CLI and worker."""

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment names match field names, case-insensitively."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")  # pyright: ignore[reportUnannotatedClassAttribute]

    redis_url: str = Field(min_length=1, repr=False)
    investigator_queue: str = Field(min_length=1)
    database_url: str = Field(min_length=1, repr=False)

    investigator_timezone: str = "UTC"

    gateway_base_url: str | None = Field(default=None, min_length=1)
    gateway_api_key: SecretStr
    openai_api_key_embedding: SecretStr = Field(min_length=1)
    gateway_model: str = Field(min_length=1)


# Required values are supplied by BaseSettings environment loading.
settings = Settings()  # pyright: ignore[reportCallIssue]
