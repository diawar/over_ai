"""Explicit read-only HTTP smoke against the running local service (no secret output)."""
import httpx
from sqlalchemy import func, select
from app.config import get_settings
from app.db import SessionLocal
from app.models import Category, Product, PropertyRule

settings = get_settings()
with httpx.Client(base_url="http://127.0.0.1:8000") as client:
    response = client.post("/api/v1/admin/auth/login", json={"username": settings.admin_username, "password": settings.admin_password})
    assert response.status_code == 200, f"Login failed: HTTP {response.status_code}"
    headers = {"X-CSRF-Token": response.json()["csrf_token"]}
    cats = client.get("/api/v1/admin/catalog/categories")
    assert cats.status_code == 200
    category_id = cats.json()["items"][0]["id"]
    rules = client.get(f"/api/v1/admin/properties/categories/{category_id}")
    assert rules.status_code == 200 and len(rules.json()["items"]) >= 14
    report = client.post(f"/api/v1/admin/properties/categories/{category_id}/preview", json={"values": {}, "context": {"country": "KZ"}}, headers=headers)
    assert report.status_code == 200 and set(report.json()["groups"]) == {"internal", "gmc"}
    # Container DNS is only transport; use the loopback Host accepted by Vite.
    page = httpx.get(f"http://frontend:5173/admin/categories/{category_id}/properties", headers={"Host": "localhost:5173"})
    assert page.status_code == 200
with SessionLocal() as db:
    print({"http_smoke": "passed", "products": db.scalar(select(func.count()).select_from(Product)),
           "categories": db.scalar(select(func.count()).select_from(Category)),
           "global_rules": db.scalar(select(func.count()).select_from(PropertyRule).where(PropertyRule.scope == "global"))})
