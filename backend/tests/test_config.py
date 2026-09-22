import pytest

from app.config import Settings


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("http://localhost:5173,https://care.example/", ["http://localhost:5173", "https://care.example"]),
        ('["http://127.0.0.1:5173", "https://care.example/"]', ["http://127.0.0.1:5173", "https://care.example"]),
    ],
)
def test_allowed_origins_accept_comma_or_json(monkeypatch, raw, expected):
    monkeypatch.setenv("CARELOOP_ALLOWED_ORIGINS", raw)
    assert Settings(_env_file=None).allowed_origins == expected
