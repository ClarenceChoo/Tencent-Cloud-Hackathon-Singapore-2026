"""Bind optional capture purpose to accepted voice turns."""

from alembic import op
import sqlalchemy as sa

revision = "0005_capture_intent"
down_revision = "0004_phone_notifications"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("voice_turns", sa.Column("capture_intent", sa.String(40), nullable=True))


def downgrade():
    op.drop_column("voice_turns", "capture_intent")
