"""Pure rule evaluator. No network, database writes, eval(), or category branches."""
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Literal
from urllib.parse import urlsplit
import re
import math

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["all", "any", "not", "eq", "in", "exists"]
    field: str | None = Field(default=None, pattern=r"^(context|values)\.[a-zA-Z][a-zA-Z0-9_]*$")
    value: Any = None
    args: list["Condition"] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def shape(self):
        if self.op in ("all", "any", "not"):
            if not self.args or self.field or (self.op == "not" and len(self.args) != 1):
                raise ValueError("Составное условие требует args; not — ровно один аргумент")
        elif not self.field or self.args:
            raise ValueError("Условие требует field, без args")
        if self.op == "in" and (not isinstance(self.value, list) or not self.value):
            raise ValueError("in требует непустой список value")
        return self


class RuleDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{0,159}$")
    label: str = Field(min_length=1, max_length=300)
    source: Literal["internal", "gmc"] = "internal"
    level: Literal["required", "conditional", "recommended", "optional"]
    value_type: Literal["string", "number", "integer", "boolean", "url", "enum", "list"] = "string"
    unit: str | None = Field(default=None, max_length=80)
    allowed_values: list[str | int | float | bool] = Field(default_factory=list, max_length=200)
    minimum: float | None = None
    maximum: float | None = None
    max_length: int | None = Field(default=None, ge=1, le=10000)
    format: Literal["gtin", "currency", "date_time"] | None = None
    condition: Condition | None = None
    applies_when: Condition | None = None
    normalization: dict = Field(default_factory=dict)
    evidence_url: str | None = Field(default=None, max_length=2000)
    checked_on: date | None = None
    note: str = Field(default="", max_length=2000)
    required_for_selection: bool = False
    ai_blocked: bool = False
    default_value: Any = None

    @model_validator(mode="after")
    def rules(self):
        if (self.level == "conditional") != (self.condition is not None):
            raise ValueError("Условие обязательно только для уровня conditional")
        if self.value_type == "enum" and not self.allowed_values:
            raise ValueError("Перечисление требует допустимые значения")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("Минимум больше максимума")
        if self.checked_on is not None and self.checked_on > date.today():
            raise ValueError("Дата проверки источника не может быть в будущем")
        if self.required_for_selection and self.level != "required":
            raise ValueError("Обязательность для подбора требует уровня required")
        for condition in (self.condition, self.applies_when):
            if condition and condition_depth(condition) > 6:
                raise ValueError("Условие слишком глубоко вложено")
        allowed = {"aliases", "unit_factors"}
        if set(self.normalization) - allowed:
            raise ValueError("Поддерживаются aliases и unit_factors")
        for key in allowed:
            if key in self.normalization and not isinstance(self.normalization[key], dict):
                raise ValueError("Правила нормализации должны быть объектами")
        for factor in self.normalization.get("unit_factors", {}).values():
            try:
                if not Decimal(str(factor)).is_finite() or Decimal(str(factor)) <= 0:
                    raise ValueError("Коэффициент единицы должен быть положительным")
            except InvalidOperation as exc:
                raise ValueError("Некорректный коэффициент единицы") from exc
        if self.source == "gmc" and self.code not in {
            "description", "image_link", "additional_image_link", "warranty_months", "mpn",
            "condition", "product_length_cm", "product_width_cm", "product_height_cm", "product_weight_kg"
        }:
            raise ValueError("Разрешены только выбранные поля GMC")
        return self


def condition_depth(c):
    return 1 + max((condition_depth(a) for a in c.args), default=0)


def unpack(value):
    if isinstance(value, dict) and "state" in value:
        state = value["state"]
        if state not in ("known", "unknown", "not_applicable"):
            return "invalid", None
        return state, value.get("value")
    if value is None or isinstance(value, str) and not value.strip():
        return "unknown", None
    return "known", value


def condition_value(c: Condition, values: dict, context: dict):
    """Three-valued logic: missing context is UNKNOWN, never implicitly false."""
    if c.op in ("all", "any", "not"):
        results = [condition_value(a, values, context) for a in c.args]
        if c.op == "not":
            return None if results[0] is None else not results[0]
        if c.op == "all":
            return False if False in results else None if None in results else True
        return True if True in results else None if None in results else False
    namespace, field = c.field.split(".", 1)
    data = context if namespace == "context" else values
    state, value = unpack(data.get(field))
    if state != "known" or value is None:
        return None
    if c.op == "exists":
        return True
    # JSON true must not compare equal to integer 1.
    same = lambda a, b: a == b if type(a) is type(b) else None
    if c.op == "eq":
        return same(value, c.value)
    results = [same(value, item) for item in c.value]
    return True if True in results else False if False in results else None


def canonical_catalog_value(code: str, value):
    if code == "gpu_graphics_processor" and isinstance(value, str):
        value = re.sub(r"^NVIDIA\s+(?=GeForce\b)", "", value, flags=re.IGNORECASE)
        value = re.sub(r"^AMD\s+(?=Radeon\b)", "", value, flags=re.IGNORECASE)
    return value


def normalize(value, rule: RuleDefinition):
    from .cooling_inventory import COOLING_CODES, normalize_cooling_inventory
    if rule.code in COOLING_CODES:
        value = normalize_cooling_inventory(rule.code, value)
    if isinstance(value, str):
        value = value.strip()
        value = rule.normalization.get("aliases", {}).get(value, value)
        value = canonical_catalog_value(rule.code, value)
    if rule.value_type in ("number", "integer"):
        if isinstance(value, bool):
            raise ValueError("Ожидается число, не логическое значение")
        factor = Decimal(1)
        if isinstance(value, str):
            match = re.fullmatch(r"([+-]?\d+(?:[.,]\d+)?)\s*([^\d\s].*)?", value)
            if not match:
                raise ValueError("Некорректное число")
            number, unit = match.groups()
            if unit and unit != rule.unit:
                raw_factor = rule.normalization.get("unit_factors", {}).get(unit)
                if raw_factor is None:
                    raise ValueError("Неподдерживаемая единица измерения")
                factor = Decimal(str(raw_factor))
            value = number.replace(",", ".")
        try:
            value = Decimal(str(value)) * factor
        except (InvalidOperation, TypeError) as exc:
            raise ValueError("Некорректное число") from exc
        if not value.is_finite():
            raise ValueError("Число должно быть конечным")
        if rule.value_type == "integer" and value != value.to_integral_value():
            raise ValueError("Ожидается целое число")
        if rule.minimum is not None and value < Decimal(str(rule.minimum)):
            raise ValueError("Значение меньше допустимого")
        if rule.maximum is not None and value > Decimal(str(rule.maximum)):
            raise ValueError("Значение больше допустимого")
        value = int(value) if rule.value_type == "integer" else float(value)
        if not math.isfinite(value):
            raise ValueError("Число выходит за допустимый диапазон")
    elif rule.value_type == "boolean":
        if not isinstance(value, bool):
            raise ValueError("Ожидается Да/Нет; неизвестно задаётся отдельным состоянием")
    elif rule.value_type == "list":
        if not isinstance(value, list) or not value:
            raise ValueError("Ожидается непустой список")
        if rule.code == "additional_image_link" and any(
            not isinstance(item, str) or urlsplit(item).scheme not in ("http", "https") or not urlsplit(item).hostname
            for item in value
        ):
            raise ValueError("Каждая ссылка на изображение должна быть абсолютной HTTP(S)-ссылкой")
    elif not isinstance(value, str) or not value:
        raise ValueError("Ожидается непустой текст")
    if rule.value_type == "url":
        p = urlsplit(value)
        if p.scheme not in ("http", "https") or not p.hostname or p.username or any(ch.isspace() for ch in value):
            raise ValueError("Ожидается абсолютная ссылка HTTP(S)")
    if rule.max_length and len(str(value)) > rule.max_length:
        raise ValueError("Значение слишком длинное")
    if rule.allowed_values and value not in rule.allowed_values:
        raise ValueError("Значение отсутствует в списке допустимых")
    if rule.format == "currency" and not re.fullmatch(r"[A-Z]{3}", str(value)):
        raise ValueError("Ожидается трёхбуквенный код валюты")
    if rule.format == "date_time":
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError()
        except ValueError as exc:
            raise ValueError("Ожидается дата и время ISO 8601 с часовым поясом") from exc
    if rule.format == "gtin":
        s = str(value)
        if not s.isascii() or not s.isdigit() or len(s) not in (8, 12, 13, 14) or s.startswith(("02", "04", "2")):
            raise ValueError("Некорректный формат GTIN")
        check = (10 - sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(s[:-1]))) % 10) % 10
        if check != int(s[-1]) or int(s) == 0:
            raise ValueError("Некорректная контрольная цифра GTIN")
    return value


def evaluate(rules: list[dict], values: dict, context: dict | None = None):
    context = context or {}
    findings, normalized, shapes = [], {}, {}
    if not rules:
        findings.append(dict(source="internal", code="coverage", label="Покрытие правил",
                             severity="warning", reason="rules_missing", message="Требования ещё не настроены",
                             level="optional", evidence_url=None))
    for data in rules:
        rule = RuleDefinition.model_validate(data)
        def finding(severity, reason, message):
            findings.append(dict(source=rule.source, code=rule.code, label=rule.label,
                                 severity=severity, reason=reason, message=message,
                                 level=rule.level, evidence_url=rule.evidence_url))
        applicable = condition_value(rule.applies_when, values, context) if rule.applies_when else True
        if applicable is False:
            continue
        if applicable is None:
            finding("warning", "applicability_unknown", "Недостаточно данных для определения применимости")
            continue
        shape = (rule.value_type, rule.unit)
        if rule.code in shapes and shapes[rule.code] != shape:
            finding("error", "rule_conflict", "Применимые правила задают разные типы или единицы одного свойства")
            continue
        shapes[rule.code] = shape
        required = rule.level == "required"
        if rule.level == "conditional":
            required = condition_value(rule.condition, values, context)
            if required is None:
                finding("warning", "condition_unknown", "Условие обязательности требует проверки")
        state, value = unpack(values.get(rule.code, rule.default_value))
        if state == "invalid":
            finding("error", "invalid_state", "Недопустимое состояние значения")
            continue
        if state != "known" or value is None or value == "":
            if required is True:
                finding("error", "required_missing", "Обязательное значение отсутствует" if state != "not_applicable" else "Нельзя исключить применимое обязательное свойство")
            elif rule.level == "recommended" and state != "not_applicable":
                finding("warning", "recommended_missing", "Рекомендуется заполнить")
            continue
        try:
            normalized[rule.code] = normalize(value, rule)
        except (ValueError, TypeError) as exc:
            finding("error", "invalid_value", str(exc))
    groups = {}
    for source in ("internal", "gmc"):
        if not any(rule.get("source", "internal") == source for rule in rules):
            continue
        issues = [f for f in findings if f["source"] == source]
        groups[source] = {"status": "error" if any(f["severity"] == "error" for f in issues) else "warning" if issues else "success", "findings": issues}
    return {"status": "error" if any(f["severity"] == "error" for f in findings) else "warning" if findings else "success",
            "groups": groups, "normalized": normalized,
            "scope": "Проверка сохранённых внутренних правил категории; карточка не изменяется"}
