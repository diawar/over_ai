import pytest
from jsonschema import validate, ValidationError
from app.dialogue_views import _remove_duplicate_aliases


SCHEMA = {"type": "object", "additionalProperties": False, "properties": {"action": {"type": "object", "additionalProperties": False, "properties": {"workloadProfile": {"type": "object"}}, "required": ["workloadProfile"]}}, "required": ["action"]}


def test_only_identical_redundant_alias_is_removed():
    value = {"action": {"workloadProfile": {"version": 1}, "workloadProfile_": {"version": 1}}}
    _remove_duplicate_aliases(value, SCHEMA)
    validate(value, SCHEMA)
    assert list(value["action"]) == ["workloadProfile"]


@pytest.mark.parametrize("extra", [{"workloadProfile_": {"version": 2}}, {"unrecognized": 1}])
def test_conflicting_and_unknown_fields_still_fail(extra):
    value = {"action": {"workloadProfile": {"version": 1}, **extra}}
    _remove_duplicate_aliases(value, SCHEMA)
    with pytest.raises(ValidationError):
        validate(value, SCHEMA)
