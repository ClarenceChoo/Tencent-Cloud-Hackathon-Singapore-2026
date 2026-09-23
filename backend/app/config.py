import json
import ipaddress
import re
from urllib.parse import urlsplit
from typing import Annotated, List

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def service_base_url(value: str) -> str:
    """A base address that also fits the pendant's 192-byte URL buffer."""
    value = value.strip().rstrip('/')
    try:
        parsed = urlsplit(value)
        port = parsed.port
        host = parsed.hostname or ''
        if ':' in host:
            ipaddress.IPv6Address(host)
        elif not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part)
                     for part in host.rstrip('.').split('.')):
            raise ValueError('Invalid hostname')
    except ValueError as exc:
        raise ValueError('Use an HTTPS service hostname, without a path or credentials') from exc
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
            or any(ch.isspace() or not 33 <= ord(ch) < 127 for ch in value)
            or len(value.encode()) >= 192 or (port is not None and not 1 <= port <= 65535)):
        raise ValueError('Use an HTTPS service hostname, without a path or credentials')
    return value


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
    public_base_url: str = ""
    audio_retention_hours: int = 24
    scheduler_interval_seconds: int = 5
    scheduler_enabled: bool = True

    @field_validator('public_base_url')
    @classmethod
    def validate_public_base_url(cls, value: str) -> str:
        return service_base_url(value) if value.strip() else ''

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
