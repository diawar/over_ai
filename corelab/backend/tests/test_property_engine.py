import pytest
from pydantic import ValidationError

from app.property_engine import Condition, RuleDefinition, condition_value, evaluate
from app.property_service import defaults


def rule(**kw):
    return {"code": "socket", "label": "Сокет", "source": "internal", "level": "required", **kw}


@pytest.mark.parametrize("level,status", [("required", "error"), ("recommended", "warning"), ("optional", "success")])
def test_missing_levels(level, status):
    assert evaluate([rule(level=level)], {})["status"] == status


@pytest.mark.parametrize("context,status", [({"country": "KZ"}, "error"), ({"country": "US"}, "success"), ({}, "warning")])
def test_country_condition_not_assumed(context, status):
    r = rule(level="conditional", condition={"op": "eq", "field": "context.country", "value": "KZ"})
    assert evaluate([r], {}, context)["status"] == status


def test_three_valued_logic_does_not_invent_facts():
    c = Condition(op="not", args=[Condition(op="eq", field="context.assigned", value=True)])
    assert condition_value(c, {}, {}) is None
    assert condition_value(c, {}, {"assigned": False}) is True
    assert condition_value(c, {}, {"assigned": 1}) is None


def test_false_zero_unknown_and_not_applicable():
    r = rule(value_type="boolean")
    assert evaluate([r], {"socket": False})["status"] == "success"
    assert evaluate([r], {"socket": {"state": "known", "value": False}})["status"] == "success"
    for state in ("unknown", "not_applicable"):
        assert evaluate([r], {"socket": {"state": state}})["status"] == "error"
    assert evaluate([rule(value_type="number")], {"socket": 0})["status"] == "success"
    assert evaluate([rule(level="optional")], {"socket": {"state": "not_applicable"}})["status"] == "success"


def test_types_locales_units_and_aliases():
    r = rule(value_type="number", unit="mm", normalization={"unit_factors": {"cm": 10}})
    assert evaluate([r], {"socket": "12,5 cm"})["normalized"]["socket"] == 125
    assert evaluate([r], {"socket": "12 GHz"})["status"] == "error"
    assert evaluate([r], {"socket": True})["status"] == "error"
    assert evaluate([r], {"socket": "NaN"})["status"] == "error"
    assert evaluate([rule(normalization={"aliases": {"LGA 1700": "LGA1700"}})], {"socket": "LGA 1700"})["normalized"]["socket"] == "LGA1700"


def test_only_selected_gmc_rules_are_allowed_and_condition_requires_predicate():
    assert RuleDefinition(**{**rule(), "code": "description", "source": "gmc", "max_length": 500}).source == "gmc"
    with pytest.raises(ValidationError):
        RuleDefinition(**{**rule(), "code": "gtin", "source": "gmc"})
    with pytest.raises(ValidationError):
        RuleDefinition(**rule(level="conditional"))
    with pytest.raises(ValidationError):
        RuleDefinition(**rule(level="recommended", required_for_selection=True))
    with pytest.raises(ValidationError):
        Condition(op="exec", field="context.country")


@pytest.mark.parametrize("template", defaults()["templates"], ids=lambda t: t["code"])
def test_category_templates_are_data_driven_internal_rules(template):
    report = evaluate(template["attributes"], {})
    required = {row['code'] for row in template['attributes'] if row['level'] == 'required'}
    assert report["status"] == ("error" if required else "warning")
    assert set(report["groups"]) == {"internal"}
    assert {f['code'] for f in report['groups']['internal']['findings'] if f['severity'] == 'error'} == required


def test_only_selected_gmc_rules_are_seeded():
    rules = defaults()["rules"]
    assert len(rules) == 10
    assert {r["code"] for r in rules} == {"description", "image_link", "additional_image_link", "warranty_months", "mpn", "condition", "product_length_cm", "product_width_cm", "product_height_cm", "product_weight_kg"}
    assert all(r["source"] == "gmc" for r in rules)
    assert next(r for r in rules if r["code"] == "warranty_months")["default_value"] == 12
    assert next(r for r in rules if r["code"] == "condition")["default_value"] == "new"


def test_gmc_defaults_and_description_limit_are_applied():
    rules = defaults()["rules"]
    report = evaluate(rules, {"description": "Кратко", "image_link": "https://example.com/main.jpg"})
    assert report["normalized"]["warranty_months"] == 12
    assert report["normalized"]["condition"] == "new"
    assert not any(f["code"] in {"warranty_months", "condition"} for f in report["groups"]["gmc"]["findings"])
    assert any(f["code"] == "description" for f in evaluate(rules, {"description": "x" * 501, "image_link": "https://example.com/a.jpg"})["groups"]["gmc"]["findings"])


def test_new_category_no_code_change_and_optional_invalid_values():
    custom = rule(code="water_resistance", label="Водостойкость", value_type="enum", allowed_values=["IP67", "IP68"], level="optional")
    assert evaluate([custom], {})["status"] == "success"
    assert evaluate([custom], {"water_resistance": "IP68"})["status"] == "success"
    assert evaluate([custom], {"water_resistance": "unknown"})["status"] == "error"


def test_rule_applicability_and_format():
    r = rule(applies_when={"op": "eq", "field": "context.country", "value": "KZ"})
    assert evaluate([r], {}, {"country": "DE"})["status"] == "success"
    assert evaluate([r], {})["status"] == "warning"
    date = rule(code="launch_date", label="Дата запуска", value_type="string", format="date_time", max_length=50)
    assert evaluate([date], {"launch_date": "tomorrow"})["status"] == "error"
    assert evaluate([date], {"launch_date": "2026-12-01T10:00:00+05:00"})["status"] == "success"


def test_empty_rules_and_conflicting_categories_never_report_success():
    assert evaluate([], {})["status"] == "warning"
    report = evaluate([rule(), rule(value_type="number", unit="mm")], {"socket": "12"})
    assert any(f["reason"] == "rule_conflict" for f in report["groups"]["internal"]["findings"])
