"""Film-only server entrypoint; no changes to the Parse application."""
import runpy
from pathlib import Path
fixture=runpy.run_path(str(Path(__file__).with_name('story-fixtures.py')))
from app.main import create_app
app=create_app()
app.state.fixture_transcripts=fixture['fixtures']()
