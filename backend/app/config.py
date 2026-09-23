import json
from typing import Annotated, List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CARELOOP_", env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./careloop.db"
    allowed_origins: Annotated[List[str], NoDecode] = Field(default_factory=lambda: ["http://localhost:5173"])
    cookie_secure: bool = True
    session_ttl_hours: int = 12
    development_seed: bool = False
    admin_enabled: bool = False
    testing: bool = False
    provider: str = ""
    audio_retention_hours: int = 24
    scheduler_interval_seconds: int = 5
    scheduler_enabled: bool = True

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_origins(cls, value):
        if isinstance(value, str):
            stripped = value.strip()
            if stripped.startswith("["):
                try:
                    value = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    raise ValueError("allowed origins must be a JSON list or comma-separated origins") from exc
            else:
                value = value.split(",")
        if isinstance(value, list):
            return [str(item).strip().rstrip("/") for item in value if str(item).strip()]
        return value


def get_settings() -> Settings:
    return Settings()
