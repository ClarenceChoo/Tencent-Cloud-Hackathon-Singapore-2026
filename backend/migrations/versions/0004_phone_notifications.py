"""Native notification state, separate evidence and durable generic push outbox."""

from alembic import op
import sqlalchemy as sa

revision = "0004_phone_notifications"
down_revision = "0003_reminder_routes"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("audio_assets", sa.Column("context_guard", sa.JSON(), nullable=True))
    op.create_table(
        "phone_states",
        sa.Column(
            "device_id", sa.String(64), sa.ForeignKey("devices.id"), primary_key=True
        ),
        sa.Column("lifecycle", sa.String(20), nullable=False),
        sa.Column("microphone_permission", sa.String(20), nullable=False),
        sa.Column("notification_permission", sa.String(20), nullable=False),
        sa.Column("reported_at", sa.DateTime(timezone=True)),
        sa.Column("scheduled_until", sa.DateTime(timezone=True)),
        sa.Column("schedule_revision", sa.String(64)),
        sa.Column("push_token", sa.String(240), unique=True),
        sa.Column("push_version", sa.Integer(), nullable=False),
        sa.Column("push_disabled_at", sa.DateTime(timezone=True)),
        sa.Column("push_snapshot", sa.JSON()),
    )
    op.create_table(
        "notification_evidence",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False
        ),
        sa.Column("event_id", sa.String(36), nullable=False),
        sa.Column("identity", sa.String(160), nullable=False),
        sa.Column("stage", sa.String(30), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("device_id", "event_id", name="uq_notification_evidence"),
    )
    op.create_index(
        "ix_notification_evidence_device_id", "notification_evidence", ["device_id"]
    )
    op.create_table(
        "push_hints",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column(
            "device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False
        ),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("route_generation", sa.Integer(), nullable=False),
        sa.Column("push_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("ticket_id", sa.String(100)),
        sa.Column("error_code", sa.String(60)),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("device_id", "fingerprint", name="uq_push_hint"),
    )
    op.create_index("ix_push_hints_device_id", "push_hints", ["device_id"])
    op.create_index("ix_push_hints_status", "push_hints", ["status"])


def downgrade():
    op.drop_column("audio_assets", "context_guard")
    for table in ("push_hints", "notification_evidence", "phone_states"):
        op.drop_table(table)
