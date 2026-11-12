import os

os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://corelab:local@localhost/corelab_test")
os.environ.setdefault("SESSION_SECRET", "test-session-secret-with-at-least-thirty-two-characters")
os.environ.setdefault("APP_ENV", "local")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import db, main
from app.db import Base, get_db
from app.models import Attribute, CatalogSource, Organization, Product, User
from app.security import hash_password, verify_password


@pytest.fixture
def client(monkeypatch):
    # PostgreSQL test URL is mandatory; never let tests silently use SQLite.
    main.limiter._storage.reset()
    source_url = os.environ.get("DATABASE_URL", "postgresql+psycopg://corelab:local@localhost:5432/corelab")
    url = os.environ.get("TEST_DATABASE_URL", source_url.rsplit("/", 1)[0] + "/corelab_test")
    engine = create_engine(url, pool_pre_ping=True)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(db, "SessionLocal", TestSession)
    monkeypatch.setattr(main.settings, "admin_username", "test-admin")
    monkeypatch.setattr(main.settings, "admin_password", "test-password")
    def override_db():
        session = TestSession()
        try: yield session
        finally: session.close()
    main.app.dependency_overrides[get_db] = override_db
    with TestClient(main.app) as test_client:
        yield test_client
    main.app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_password_is_argon2_hash_and_verifies():
    encoded = hash_password("long-test-password")
    assert encoded.startswith("$argon2id$")
    assert verify_password(encoded, "long-test-password")
    assert not verify_password(encoded, "wrong")


def test_login_success_and_session_cookie(client):
    response = client.post("/api/v1/admin/auth/login", json={"username": "test-admin", "password": "test-password"})
    assert response.status_code == 200
    assert response.json()["role"] == "chief_admin"
    assert response.json()["organization"]["primary_color"] == "#ff416c"
    with db.SessionLocal() as session:
        organization = session.get(Organization, response.json()["organization"]["id"])
        organization.primary_color = "#fb7602"
        session.commit()
    assert client.get("/api/v1/admin/auth/me").json()["organization"]["primary_color"] == "#fb7602"
    assert response.cookies.get("corelab_session")
    assert "httponly" in response.headers["set-cookie"].lower()


def test_organization_isolation_and_chief_admin_user_management(client):
    with db.SessionLocal() as session:
        other = Organization(name="Другая организация")
        session.add(other); session.flush()
        own_catalog = CatalogSource(organization_id=1, code="corelab", name="Каталог 1", endpoint="local://one")
        other_catalog = CatalogSource(organization_id=other.id, code="corelab", name="Каталог 2", endpoint="local://two")
        session.add_all([own_catalog, other_catalog]); session.flush()
        own_product = Product(organization_id=1, source_id=own_catalog.id, sku="own", name="Наш товар", raw_data={})
        other_product = Product(organization_id=other.id, source_id=other_catalog.id, sku="other", name="Чужой товар", raw_data={})
        session.add_all([own_product, other_product]); session.flush()
        session.add_all([
            CatalogSource(organization_id=1, code="shop", name="Наш источник", endpoint="https://one.test"),
            CatalogSource(organization_id=other.id, code="shop", name="Чужой источник", endpoint="https://two.test"),
            Attribute(organization_id=1, code="socket", label="Наше свойство", value_type="string"),
            Attribute(organization_id=other.id, code="socket", label="Чужое свойство", value_type="string"),
            User(organization_id=other.id, username="other-admin", password_hash=hash_password("other-password-123"), role="admin"),
        ])
        session.commit()
        other_id = other.id
        own_product_id = own_product.id

    chief_login = client.post("/api/v1/admin/auth/login", json={"username": "test-admin", "password": "test-password"})
    assert chief_login.json()["organization"]["name"] == 'ТОО "OVER-SHOP.KZ"'
    assert [item["name"] for item in client.get("/api/v1/admin/sources").json()["items"]] == ["Наш источник"]
    assert [item["name"] for item in client.get("/api/v1/admin/catalog").json()["items"]] == ["Наш товар"]
    assert [item["label"] for item in client.get("/api/v1/admin/properties/dictionary").json()["items"]] == ["Наше свойство"]
    headers = {"X-CSRF-Token": client.cookies.get("corelab_csrf")}
    created = client.post("/api/v1/admin/settings/users", json={
        "username": "new-admin", "password": "temporary-password-123"}, headers=headers)
    assert created.status_code == 200 and created.json()["role"] == "admin"
    edited = client.patch(f"/api/v1/admin/settings/users/{created.json()['id']}", json={
        "username": "renamed-admin", "password": "replacement-password-123"}, headers=headers)
    assert edited.status_code == 200 and edited.json()["must_change_password"] is True
    assert client.get("/api/v1/admin/settings/users").json()["items"][-1]["username"] == "renamed-admin"
    new_login = client.post("/api/v1/admin/auth/login", json={
        "username": "renamed-admin", "password": "replacement-password-123"})
    assert new_login.json()["role"] == "admin" and new_login.json()["must_change_password"] is True
    assert new_login.json()["organization"]["id"] == 1

    other_login = client.post("/api/v1/admin/auth/login", json={"username": "other-admin", "password": "other-password-123"})
    assert other_login.json()["organization"]["id"] == other_id
    assert [item["name"] for item in client.get("/api/v1/admin/sources").json()["items"]] == ["Чужой источник"]
    assert [item["name"] for item in client.get("/api/v1/admin/catalog").json()["items"]] == ["Чужой товар"]
    assert [item["label"] for item in client.get("/api/v1/admin/properties/dictionary").json()["items"]] == ["Чужое свойство"]
    assert client.get(f"/api/v1/admin/catalog/{own_product_id}").status_code == 404
    assert [item["username"] for item in client.get("/api/v1/admin/settings/users").json()["items"]] == ["other-admin"]
    headers = {"X-CSRF-Token": client.cookies.get("corelab_csrf")}
    assert client.post("/api/v1/admin/settings/users", json={
        "username": "forbidden", "password": "temporary-password-123"}, headers=headers).status_code == 403
    assert client.delete(f"/api/v1/admin/settings/users/{created.json()['id']}", headers=headers).status_code == 403
    client.post("/api/v1/admin/auth/login", json={"username": "test-admin", "password": "test-password"})
    headers = {"X-CSRF-Token": client.cookies.get("corelab_csrf")}
    assert client.delete(f"/api/v1/admin/settings/users/{created.json()['id']}", headers=headers).status_code == 200
    assert client.post("/api/v1/admin/auth/login", json={
        "username": "renamed-admin", "password": "replacement-password-123"}).status_code == 401


def test_login_failure_is_401(client):
    assert client.post("/api/v1/admin/auth/login", json={"username": "test-admin", "password": "wrong"}).status_code == 401


def test_unauthenticated_and_role_forbidden(client):
    assert client.get("/api/v1/admin/catalog").status_code == 401
    with db.SessionLocal() as session:
        session.add(User(username="viewer", password_hash=hash_password("viewer-password"), role="viewer")); session.commit()
    client.post("/api/v1/admin/auth/login", json={"username": "viewer", "password": "viewer-password"})
    assert client.get("/api/v1/admin/catalog").status_code == 403


def test_logout_requires_csrf_and_clears_session(client):
    login = client.post("/api/v1/admin/auth/login", json={"username": "test-admin", "password": "test-password"})
    csrf = login.json()["csrf_token"]
    assert client.post("/api/v1/admin/auth/logout").status_code == 403
    logout = client.post("/api/v1/admin/auth/logout", headers={"X-CSRF-Token": csrf})
    assert logout.status_code == 200
    assert client.get("/api/v1/admin/auth/me").status_code == 401


def test_nonlocal_bootstrap_password_must_be_changed(client):
    with db.SessionLocal() as session:
        session.add(User(username="first-login", password_hash=hash_password("temporary-password"), role="admin", must_change_password=True)); session.commit()
    login = client.post("/api/v1/admin/auth/login", json={"username": "first-login", "password": "temporary-password"})
    csrf = login.json()["csrf_token"]
    assert login.json()["must_change_password"] is True
    assert client.get("/api/v1/admin/catalog").status_code == 403
    changed = client.post("/api/v1/admin/auth/change-password", headers={"X-CSRF-Token": csrf},
                          json={"current_password": "temporary-password", "new_password": "a-new-long-password"})
    assert changed.status_code == 200
    assert client.get("/api/v1/admin/catalog").status_code == 200
