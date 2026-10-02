"""Persist purpose, template version, and authenticated authored questions."""

from alembic import op
import sqlalchemy as sa

revision = "0007_summary_purposes"
down_revision = "0006_care_vocabulary"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("visit_summaries", sa.Column("purpose", sa.String(30), nullable=False, server_default="doctor_visit"))
    op.add_column("visit_summaries", sa.Column("template_version", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("visit_summaries", sa.Column("questions", sa.JSON(), nullable=False, server_default="[]"))


def downgrade():
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT COUNT(*) FROM visit_summaries WHERE purpose <> 'doctor_visit' OR template_version <> 1 OR CAST(questions AS TEXT) <> '[]'")).scalar_one():
        raise RuntimeError("Purpose or authored questions exist; downgrade would discard reviewed content")
    op.drop_column("visit_summaries", "questions")
    op.drop_column("visit_summaries", "template_version")
    op.drop_column("visit_summaries", "purpose")
