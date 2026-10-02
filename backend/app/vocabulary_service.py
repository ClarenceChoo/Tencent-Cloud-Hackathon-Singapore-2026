"""Patient-scoped reviewed vocabulary; suggestions never become reviewed by reading them."""
from dataclasses import dataclass
from datetime import datetime
import unicodedata

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models as m
from .routing import lock_patient
from .security import aware, utcnow


@dataclass(frozen=True)
class VocabularyTerm:
    canonical: str
    aliases: list[str]
    category: str


@dataclass(frozen=True)
class VocabularyView:
    version: int
    terms: list[VocabularyTerm]
    reviewed_by_user_id: str | None
    reviewed_at: datetime | None


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value.strip()).casefold()


def validate_terms(terms: list[VocabularyTerm]) -> list[dict]:
    if len(terms) > 100:
        raise HTTPException(422, "Keep at most 100 reviewed terms")
    seen: dict[str, str] = {}
    clean = []
    for item in terms:
        canonical = item.canonical.strip()
        aliases = [alias.strip() for alias in item.aliases]
        if not canonical or len(canonical) > 80:
            raise HTTPException(422, "Each reviewed name must be 1–80 characters")
        if item.category not in {"medicine", "person", "other"}:
            raise HTTPException(422, "Unsupported reviewed-name category")
        if len(aliases) > 5:
            raise HTTPException(422, "Keep at most 5 alternatives for each name")
        for value in [canonical, *aliases]:
            if not value or len(value) > 80:
                raise HTTPException(422, "Each alternative must be 1–80 characters")
            normalized = _normalized(value)
            if normalized in seen:
                raise HTTPException(422, "A reviewed name or alternative is duplicated or ambiguous")
            seen[normalized] = canonical
        clean.append({"canonical": canonical, "aliases": aliases, "category": item.category})
    return clean


def read_vocabulary(db: Session, patient_id: str) -> VocabularyView:
    row = db.get(m.CareVocabulary, patient_id, populate_existing=True)
    if row is None:
        return VocabularyView(0, [], None, None)
    return VocabularyView(row.version, [VocabularyTerm(**term) for term in row.terms],
                          row.reviewed_by_user_id, row.reviewed_at)


def read_vocabulary_version(db: Session, patient_id: str, version: int) -> VocabularyView:
    """Load the immutable snapshot selected for a turn, including after retries."""
    if version == 0:
        return VocabularyView(0, [], None, None)
    audit = db.scalar(select(m.CareVocabularyAudit).where(
        m.CareVocabularyAudit.patient_id == patient_id,
        m.CareVocabularyAudit.version == version))
    if audit is None:
        raise RuntimeError("Reviewed vocabulary snapshot is unavailable")
    return VocabularyView(audit.version, [VocabularyTerm(**term) for term in audit.terms],
                          audit.reviewed_by_user_id, audit.reviewed_at)


def update_vocabulary(db: Session, patient_id: str, actor_id: str, expected_version: int,
                      terms: list[VocabularyTerm]) -> VocabularyView:
    if expected_version < 0:
        raise HTTPException(422, "Expected version must be nonnegative")
    clean = validate_terms(terms)
    lock_patient(db, patient_id)
    current = db.get(m.CareVocabulary, patient_id, populate_existing=True)
    version = current.version if current else 0
    if expected_version != version:
        raise HTTPException(409, "Reviewed names changed. Refresh and compare before saving.")
    reviewed_at = utcnow()
    new_version = version + 1
    if current is None:
        current = m.CareVocabulary(patient_id=patient_id, version=new_version,
                                   terms=clean, reviewed_by_user_id=actor_id,
                                   reviewed_at=reviewed_at)
        db.add(current)
    else:
        current.version = new_version
        current.terms = clean
        current.reviewed_by_user_id = actor_id
        current.reviewed_at = reviewed_at
    db.add(m.CareVocabularyAudit(patient_id=patient_id, version=new_version, terms=clean,
                                 reviewed_by_user_id=actor_id, reviewed_at=reviewed_at))
    db.commit()
    return VocabularyView(new_version, [VocabularyTerm(**term) for term in clean], actor_id, reviewed_at)


def vocabulary_suggestions(db: Session, patient_id: str) -> list[VocabularyTerm]:
    """Return only checked active medicine names and currently permitted names."""
    candidates: list[VocabularyTerm] = []
    plan = db.scalar(select(m.MedicationPlanVersion).where(
        m.MedicationPlanVersion.patient_id == patient_id,
        m.MedicationPlanVersion.active.is_(True))
        .order_by(m.MedicationPlanVersion.version.desc()).limit(1))
    if plan and plan.checked_at:
        for medicine in plan.medicines or []:
            name = medicine.get("name") if isinstance(medicine, dict) else None
            if isinstance(name, str) and name.strip() and len(name.strip()) <= 80:
                candidates.append(VocabularyTerm(name.strip(), [], "medicine"))
    rows = db.execute(select(m.AccessGrant, m.User).join(m.User, m.User.id == m.AccessGrant.user_id)
        .where(m.AccessGrant.patient_id == patient_id,
               m.AccessGrant.revoked_at.is_(None), m.User.active.is_(True))).all()
    now = utcnow()
    for grant, user in rows:
        if grant.relationship == "owner" or (grant.expires_at and aware(grant.expires_at) <= now):
            continue
        if user.name.strip() and len(user.name.strip()) <= 80:
            candidates.append(VocabularyTerm(user.name.strip(), [], "person"))
    unique = {}
    for term in candidates:
        unique.setdefault(_normalized(term.canonical), term)
    return list(unique.values())[:100]
