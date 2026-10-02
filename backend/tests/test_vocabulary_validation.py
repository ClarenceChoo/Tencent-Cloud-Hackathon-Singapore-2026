import pytest
from fastapi import HTTPException

from app.vocabulary_service import VocabularyTerm, validate_terms


def test_valid_reviewed_names_preserve_display_spelling():
    assert validate_terms([VocabularyTerm("  Fictional Med  ", ["  Med-A  "], "medicine")]) == [
        {"canonical": "Fictional Med", "aliases": ["Med-A"], "category": "medicine"}
    ]


@pytest.mark.parametrize("terms", [
    [VocabularyTerm("Ａlice", [], "person"), VocabularyTerm("Alice", [], "person")],
    [VocabularyTerm("Med A", ["Med B"], "medicine"), VocabularyTerm("Med B", [], "medicine")],
    [VocabularyTerm("Med A", ["med a"], "medicine")],
    [VocabularyTerm("x" * 81, [], "other")],
    [VocabularyTerm("Med A", [str(i) for i in range(6)], "medicine")],
    [VocabularyTerm(str(i), [], "other") for i in range(101)],
])
def test_duplicate_or_excessive_reviewed_names_are_rejected(terms):
    with pytest.raises(HTTPException) as error:
        validate_terms(terms)
    assert error.value.status_code == 422
