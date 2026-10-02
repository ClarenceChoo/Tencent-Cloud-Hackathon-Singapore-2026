from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class LoginRequest(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=200)


class ProposalCreate(BaseModel):
    kind: Literal["health_note", "medication_report", "measurement", "preventive_task", "support_request", "followup"]
    payload: Dict[str, Any]


class ProposalRevise(BaseModel):
    payload: Dict[str, Any]


class ProposalConfirm(BaseModel):
    confirmed: Literal[True]


class QueryRequest(BaseModel):
    kind: Literal["latest_reading", "open_support", "medication_reports"]
    local_date: Optional[date] = None

    @model_validator(mode="after")
    def date_matches_kind(self):
        if self.kind == "medication_reports" and self.local_date is None:
            raise ValueError("local_date is required for medication_reports")
        if self.kind != "medication_reports" and self.local_date is not None:
            raise ValueError("local_date is only accepted for medication_reports")
        return self


class Medicine(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    instructions: str = Field(min_length=1, max_length=1000)
    reviewed_reference: str = Field(min_length=1, max_length=2000)
    reference_source: str = Field(min_length=1, max_length=500)


class ScheduleItem(BaseModel):
    medicine_id: str
    local_time: str

    @field_validator("local_time")
    @classmethod
    def time_format(cls, value: str) -> str:
        try:
            hour, minute = [int(part) for part in value.split(":")]
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError("local_time must be HH:MM")
        return "%02d:%02d" % (hour, minute)


class MedicationPlanCreate(BaseModel):
    timezone: str = Field(min_length=1, max_length=80)
    source: str = Field(min_length=1, max_length=1000)
    checked: Literal[True]
    medicines: List[Medicine] = Field(min_length=1)
    schedule: List[ScheduleItem] = Field(min_length=1)

    @model_validator(mode="after")
    def schedule_references_known_medicines(self):
        known = {item.id for item in self.medicines}
        if len(known) != len(self.medicines):
            raise ValueError("medicine IDs must be unique")
        if any(item.medicine_id not in known for item in self.schedule):
            raise ValueError("schedule references an unknown medicine")
        schedule_keys = {(item.medicine_id, item.local_time) for item in self.schedule}
        if len(schedule_keys) != len(self.schedule):
            raise ValueError("schedule entries must be unique")
        return self


class DeviceClaim(BaseModel):
    code: str = Field(min_length=4, max_length=40)
    patient_id: str


class ActiveCompanionSelect(BaseModel):
    device_id: Optional[str] = Field(default=None, max_length=64)
    expected_generation: int = Field(ge=0)
    other_pendants_powered_off: bool = False


class RemovedPhoneRelease(BaseModel):
    expected_generation: int = Field(ge=0)
    app_removed_or_reset: Literal[True]


class ResolveRequest(BaseModel):
    outcome: str = Field(min_length=1, max_length=2000)


class GrantCreate(BaseModel):
    user_id: str
    scopes: List[str] = Field(min_length=1)
    expires_at: Optional[datetime] = None


class NoteSharingUpdate(BaseModel):
    user_ids: List[str] = Field(default_factory=list)


class PatientProfileUpdate(BaseModel):
    preferred_name: str = Field(min_length=1, max_length=100)
    language: str = Field(min_length=2, max_length=20)
    timezone: str = Field(min_length=1, max_length=80)
    daily_check_in_enabled: bool = False
    daily_check_in_local_time: Optional[str] = None
    calling_route: Optional[str] = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def check_in_time(self):
        if self.daily_check_in_enabled and not self.daily_check_in_local_time:
            raise ValueError("daily_check_in_local_time is required when check-in is enabled")
        if self.daily_check_in_local_time:
            try:
                hour, minute = [int(part) for part in self.daily_check_in_local_time.split(":")]
                if not (0 <= hour <= 23 and 0 <= minute <= 59):
                    raise ValueError
            except (ValueError, TypeError):
                raise ValueError("daily_check_in_local_time must be HH:MM")
            self.daily_check_in_local_time = "%02d:%02d" % (hour, minute)
        return self


class SummaryCreate(BaseModel):
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def ordered(self):
        if self.end_date < self.start_date:
            raise ValueError("end_date must not precede start_date")
        return self


class SummaryUpdate(BaseModel):
    sections: List[Dict[str, Any]]
    omitted_source_ids: List[str] = Field(default_factory=list)
    reviewed: Literal[True]


class SummaryShareCreate(BaseModel):
    expires_in_seconds: int = Field(ge=60, le=604800)


class DeviceAck(BaseModel):
    ack_id: str
    command_id: str
    stage: Literal["received", "playback_started", "playback_completed", "interrupted", "failed", "expired"]
    device_time: Optional[datetime] = None


class Heartbeat(BaseModel):
    type: Literal["heartbeat"]
    battery_mv: Optional[int] = Field(default=None, ge=2000, le=6000)
    rssi: Optional[int] = Field(default=None, ge=-150, le=20)
    firmware_version: Optional[str] = Field(default=None, max_length=100)
