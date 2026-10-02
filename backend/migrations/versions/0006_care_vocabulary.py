"""Versioned reviewed vocabulary and per-turn snapshot reference."""

from alembic import op
import sqlalchemy as sa

revision = "0006_care_vocabulary"
down_revision = "0005_capture_intent"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "care_vocabularies",
        sa.Column("patient_id", sa.String(64), sa.ForeignKey("patients.id"), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("terms", sa.JSON(), nullable=False),
        sa.Column("reviewed_by_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "care_vocabulary_audits",
        sa.Column("patient_id", sa.String(64), sa.ForeignKey("patients.id"), primary_key=True),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("terms", sa.JSON(), nullable=False),
        sa.Column("reviewed_by_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.add_column("voice_turns", sa.Column("vocabulary_version", sa.Integer(), nullable=True))


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT COUNT(*) FROM care_vocabulary_audits")).scalar_one():
        raise RuntimeError("Reviewed vocabulary audit exists; downgrade would destroy review history")
    op.drop_column("voice_turns", "vocabulary_version")
    op.drop_table("care_vocabulary_audits")
    op.drop_table("care_vocabularies")
