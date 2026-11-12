import pytest
from pydantic import TypeAdapter, ValidationError
from app import main
from app.password_policy import NewPassword


@pytest.mark.parametrize('password,valid', [('123', False), ('12345678', False), ('abcdefg ', False), ('abcd!12', False), ('abcd!123', True), ('Пароль!1', True), ('abcdefgh🔐', True), (' space! ', True)])
def test_password_policy(password, valid):
    if valid:
        assert TypeAdapter(NewPassword).validate_python(password) == password
    else:
        with pytest.raises(ValidationError):
            TypeAdapter(NewPassword).validate_python(password)


def test_password_policy_applies_to_every_write_model():
    from app.platform_admin import PlatformUserCreate, PlatformUserInput, OrganizationCreate
    from app.settings_views import UserCreateInput, UserUpdateInput
    models = [(main.RegistrationInput, {'name': 'Org', 'username': 'owner'}),
              (main.PasswordChangeInput, {'current_password': '123'}),
              (PlatformUserCreate, {'organization_id': 1, 'username': 'owner', 'role': 'admin'}),
              (PlatformUserInput, {'username': 'owner', 'role': 'admin'}),
              (OrganizationCreate, {'name': 'Org', 'username': 'owner'}),
              (UserCreateInput, {'username': 'owner'}), (UserUpdateInput, {'username': 'owner'})]
    for model, values in models:
        field = 'new_password' if model is main.PasswordChangeInput else 'password'
        with pytest.raises(ValidationError):
            model(**values, **{field: 'abcdefgh'})
        model(**values, **{field: 'abc!1234'})
