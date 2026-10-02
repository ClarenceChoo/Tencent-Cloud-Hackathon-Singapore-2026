"""Deterministic presentations of already selected, source-linked care evidence.

This module only changes section order and headings. The selection of records,
their wording, and their immutable source references belong to the caller.
"""

from copy import deepcopy
from datetime import datetime
from typing import TypedDict


SUMMARY_PURPOSES = ("doctor_visit", "family_handoff", "weekly_review")
SUMMARY_TEMPLATE_VERSION = 1


class AuthoredQuestion(TypedDict):
    text: str
    author_id: str
    author_display_name: str
    authored_at: datetime


_EVIDENCE_KEYS = {
    "Reported health notes": "notes",
    "Reported measurements": "readings",
    "Medication reports": "medications",
    "Current preventive care context at summary generation": "current_context",
    "Unresolved support and follow-up": "unresolved",
}

_ORDERS = {
    "doctor_visit": ("notes", "readings", "medications", "unresolved", "current_context"),
    "family_handoff": ("unresolved", "medications", "notes", "readings", "current_context"),
    "weekly_review": ("notes", "readings", "medications", "unresolved", "current_context"),
}

_HEADINGS = {
    "doctor_visit": {
        "notes": "Reported concerns selected by event date, or recorded date when unknown",
        "readings": "Reported readings selected by event date, or recorded date when unknown",
        "medications": "Medication reports in the selected period",
        "unresolved": "Unresolved requests in the selected period and current open follow-ups",
        "current_context": "Current preventive care context at summary generation (outside the date filter)",
    },
    "family_handoff": {
        "unresolved": "Unresolved requests in the selected period and current open follow-ups",
        "medications": "Medication reports in the selected period",
        "notes": "Reported health notes selected by event date, or recorded date when unknown",
        "readings": "Reported readings selected by event date, or recorded date when unknown",
        "current_context": "Current preventive care context at summary generation (outside the date filter)",
    },
    "weekly_review": {
        "notes": "Selected period · Health notes by event date, or recorded date when unknown",
        "readings": "Selected period · Readings by event date, or recorded date when unknown",
        "medications": "Selected period · Medication reports",
        "unresolved": "Selected period requests and current open follow-ups",
        "current_context": "Current context at summary generation (outside the selected period)",
    },
}


def present_summary(
    purpose: str, evidence_sections: list[dict], questions: list[AuthoredQuestion]
) -> list[dict]:
    """Present all selected evidence unchanged, with authored questions kept separate.

    Unknown section types are retained after recognized evidence and before
    questions, preserving their original order and heading.
    """
    if purpose not in SUMMARY_PURPOSES:
        raise ValueError("Unknown summary purpose")

    ordered = []
    for index, section in enumerate(evidence_sections):
        if section.get("kind") == "authored_questions":
            raise ValueError("Authored questions must be supplied separately from evidence")
        key = _EVIDENCE_KEYS.get(section.get("title"))
        rank = _ORDERS[purpose].index(key) if key else len(_ORDERS[purpose])
        ordered.append((rank, index, section, key))

    presented = []
    for _, _, section, key in sorted(ordered):
        copy = deepcopy(section)
        if key:
            copy["title"] = _HEADINGS[purpose][key]
        presented.append(copy)

    if questions:
        presented.append(
            {
                "kind": "authored_questions",
                "title": "Questions written by a caregiver or patient (not reported care facts)",
                "items": [
                    {
                        "text": question["text"],
                        "author_display_name": question["author_display_name"],
                        "authored_at": question["authored_at"].isoformat(),
                    }
                    for question in questions
                ],
            }
        )
    return presented
