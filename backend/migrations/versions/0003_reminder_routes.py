"""Preserve logical occurrences and per-target reminder attempts."""
from alembic import op
import sqlalchemy as sa

revision = "0003_reminder_routes"
down_revision = "0002_phone_identity"
branch_labels = None
depends_on = None
NAMING = {"uq": "uq_%(table_name)s_%(column_0_name)s"}


def upgrade():
    op.create_table("reminder_occurrences",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("patient_id", sa.String(64), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("dose_instance_id", sa.String(64), sa.ForeignKey("dose_instances.id"), nullable=True, unique=True),
        sa.Column("local_date", sa.Date(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("patient_id", "kind", "local_date", name="uq_checkin_occurrence"))
    op.create_index("ix_reminder_occurrences_patient_id", "reminder_occurrences", ["patient_id"])
    for table in ("reminder_commands", "checkin_deliveries"):
        op.add_column(table, sa.Column("occurrence_id", sa.String(64), nullable=True))
        op.add_column(table, sa.Column("route_generation", sa.Integer(), nullable=False, server_default="1"))
        op.add_column(table, sa.Column("audio_accessed_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(table, sa.Column("cancel_reason", sa.String(40), nullable=True))
    op.execute(sa.text("""INSERT INTO reminder_occurrences (id,patient_id,kind,dose_instance_id,expires_at,created_at)
        SELECT 'occ_' || r.id,d.patient_id,'medication',r.dose_instance_id,r.expires_at,r.created_at
        FROM reminder_commands r JOIN dose_instances d ON d.id=r.dose_instance_id"""))
    op.execute(sa.text("""INSERT INTO reminder_occurrences (id,patient_id,kind,local_date,expires_at,created_at)
        SELECT 'occ_' || id,patient_id,'checkin',local_date,expires_at,created_at FROM checkin_deliveries"""))
    for table in ("reminder_commands", "checkin_deliveries"):
        op.execute(sa.text("UPDATE " + table + " SET occurrence_id = 'occ_' || id"))
        # Old builds did not track downloads. Queued/received/started/unknown history
        # must be treated as potentially played and must never replay on a switch.
        op.execute(sa.text("UPDATE " + table + " SET audio_accessed_at = created_at WHERE delivery_state NOT IN ('preparing')"))
        uniques = sa.inspect(op.get_bind()).get_unique_constraints(table)
        old_columns = ["dose_instance_id"] if table == "reminder_commands" else ["patient_id", "local_date"]
        old_name = next(item["name"] or "uq_" + table + "_" + old_columns[0] for item in uniques if item["column_names"] == old_columns)
        with op.batch_alter_table(table, naming_convention=NAMING) as batch:
            batch.drop_constraint(old_name, type_="unique")
            batch.alter_column("occurrence_id", existing_type=sa.String(64), nullable=False)
            batch.create_foreign_key("fk_" + table + "_occurrence", "reminder_occurrences", ["occurrence_id"], ["id"])
            batch.create_index("ix_" + table + "_occurrence_id", ["occurrence_id"])
            batch.create_unique_constraint("uq_reminder_route_attempt" if table == "reminder_commands" else "uq_checkin_route_attempt", ["occurrence_id", "route_generation"])
    op.create_index("ix_reminder_commands_dose_instance_id", "reminder_commands", ["dose_instance_id"])


def downgrade():
    # Refuse to discard routing history to satisfy an older uniqueness constraint.
    connection = op.get_bind()
    for table, columns in (("reminder_commands", "dose_instance_id"), ("checkin_deliveries", "patient_id,local_date")):
        if connection.execute(sa.text("SELECT COUNT(*) FROM " + table + " GROUP BY " + columns + " HAVING COUNT(*) > 1")).first():
            raise RuntimeError("Routing history exists; restore the pre-upgrade backup rather than discarding attempts")
    op.drop_index("ix_reminder_commands_dose_instance_id", table_name="reminder_commands")
    for table in ("reminder_commands", "checkin_deliveries"):
        with op.batch_alter_table(table, naming_convention=NAMING) as batch:
            batch.drop_constraint("uq_reminder_route_attempt" if table == "reminder_commands" else "uq_checkin_route_attempt", type_="unique")
            batch.drop_constraint("fk_" + table + "_occurrence", type_="foreignkey")
            batch.drop_index("ix_" + table + "_occurrence_id")
            for column in ("cancel_reason", "audio_accessed_at", "route_generation", "occurrence_id"):
                batch.drop_column(column)
            batch.create_unique_constraint("uq_reminder_commands_dose_instance_id" if table == "reminder_commands" else "uq_patient_checkin_date", ["dose_instance_id"] if table == "reminder_commands" else ["patient_id", "local_date"])
    op.drop_index("ix_reminder_occurrences_patient_id", table_name="reminder_occurrences")
    op.drop_table("reminder_occurrences")
