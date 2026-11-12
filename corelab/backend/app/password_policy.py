import unicodedata
from typing import Annotated
from pydantic import AfterValidator, Field


def validate_password(value: str) -> str:
    if not any(unicodedata.category(char)[0] in ('P', 'S') for char in value):
        raise ValueError('Пароль должен содержать хотя бы один спецсимвол')
    return value


NewPassword = Annotated[str, Field(min_length=8, max_length=256), AfterValidator(validate_password)]
