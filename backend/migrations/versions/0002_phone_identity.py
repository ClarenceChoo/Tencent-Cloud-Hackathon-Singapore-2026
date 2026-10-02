"""Phone installations and explicit reminder routing."""
from alembic import op
import sqlalchemy as sa

revision = "0002_phone_identity"
down_revision = "0001_existing_care"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("devices", sa.Column("device_type", sa.String(20), nullable=False, server_default="pendant"))
    op.add_column("devices", sa.Column("platform", sa.String(20), nullable=True))
    op.add_column("devices", sa.Column("display_name", sa.String(80), nullable=True))
    op.create_table("phone_enrollments",
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), primary_key=True),
        sa.Column("idempotency_key", sa.String(36), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False))
    op.create_table("companion_routes",
        sa.Column("patient_id", sa.String(64), sa.ForeignKey("patients.id"), primary_key=True),
        sa.Column("active_device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=True),
        sa.Column("generation", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False))
    # Only an unambiguous single binding retains automatic reminder delivery.
    op.execute(sa.text("""INSERT INTO companion_routes
        (patient_id, active_device_id, generation, changed_at)
        SELECT p.id, CASE WHEN COUNT(d.id) = 1 THEN MIN(d.id) ELSE NULL END, 1, CURRENT_TIMESTAMP
        FROM patients p LEFT JOIN devices d ON d.patient_id = p.id AND d.revoked_at IS NULL
        GROUP BY p.id"""))


def downgrade():
    # Care records and original pendant bindings are preserved. Phone credentials
    # are revoked before the older server loses its device-type distinction.
    op.execute(sa.text("UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE device_type = 'phone' AND revoked_at IS NULL"))
    op.drop_table("companion_routes")
    op.drop_table("phone_enrollments")
    op.drop_column("devices", "display_name")
    op.drop_column("devices", "platform")
    op.drop_column("devices", "device_type")
