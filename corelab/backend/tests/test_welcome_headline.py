import pytest
from sqlalchemy import select

from app import main
from app.models import Organization, User
from app.settings_views import DEFAULT_WELCOME_HEADLINE
from test_catalog_views import catalog_client
from test_property_views import csrf


def test_headline_persists_and_is_scoped_to_organization(catalog_client):
    client, db = catalog_client
    user = db.scalar(select(User))
    user.role = "chief_admin"
    db.add(Organization(id=2, name="Second"))
    db.commit()
    main.app.dependency_overrides[main.admin_user] = lambda: user
    path = "/api/v1/admin/settings/organization"
    assert client.get(path).json()["welcome_headline"] == DEFAULT_WELCOME_HEADLINE
    lines = ["  Наш опыт.  ", "Ваши идеи.", "<b>Ваш компьютер.</b>"]
    expected = [line.strip() for line in lines]
    assert client.put(path + "/welcome", json={"welcome_headline": lines}, headers=csrf(client)).status_code == 200
    db.expire_all()
    assert db.get(Organization, 1).welcome_headline == expected
    assert client.get(path).json()["welcome_headline"] == expected
    assert client.get("/api/v1/organizations/1/branding").json()["welcome_headline"] == expected
    assert client.get("/api/v1/organizations/2/branding").json()["welcome_headline"] == DEFAULT_WELCOME_HEADLINE


@pytest.mark.parametrize("lines", [["one"], ["one", " ", "three"], ["x" * 81, "two", "three"], ["one\ntwo", "two", "three"]])
def test_invalid_headline_rejected(catalog_client, lines):
    client, db = catalog_client
    user = db.scalar(select(User))
    user.role = "chief_admin"
    main.app.dependency_overrides[main.admin_user] = lambda: user
    assert client.put("/api/v1/admin/settings/organization/welcome", json={"welcome_headline": lines}, headers=csrf(client)).status_code == 422


def test_headline_requires_chief_role_and_csrf(catalog_client):
    client, db = catalog_client
    user = db.scalar(select(User))
    main.app.dependency_overrides[main.admin_user] = lambda: user
    path = "/api/v1/admin/settings/organization/welcome"
    body = {"welcome_headline": DEFAULT_WELCOME_HEADLINE}
    assert client.put(path, json=body, headers=csrf(client)).status_code == 403
    user.role = "chief_admin"
    assert client.put(path, json=body).status_code == 403
