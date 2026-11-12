from sqlalchemy import select

from app import main
from app.db import get_db
from app.models import AuditLog, CatalogSource, ImportLog, Job, JobItem, User
from test_catalog_views import catalog_client, seed


def test_journal_filters_pages_progress_persists_and_hides_secrets(catalog_client):
    client, db = catalog_client
    _, _, product = seed(db)
    for number in range(30):
        db.add(AuditLog(action="properties.rule_updated", object_type="property_rules",
                        object_id=str(number + 1), details={"new": {"api_key": "sk-private-value"}}))
    db.add(AuditLog(action="properties.structure_checked", object_type="property_rules", object_id="4",
                    details={"status": "warning", "errors": [], "warnings": ["private-key"], "secret": "sk-private-value"}))
    db.add(AuditLog(action="properties.ai_load_skipped", object_type="product", object_id=str(product.id),
                    details={"job_id": 1, "reason": "Товар больше не относится к выбранной категории", "property_count": 0}))
    db.add(AuditLog(action="properties.ai_load_failed", object_type="product", object_id=str(product.id),
                    details={"reason": "Bearer sk-private-value", "api_key": "sk-private-value"}))
    db.add(AuditLog(action="product.attribute_changed", object_type="product_attribute",
                    object_id=f"{product.id}:socket", details={"new": "AM5"}))
    source = db.scalar(select(CatalogSource).where(CatalogSource.code == "p1"))
    db.add(ImportLog(source_id=source.id, status="completed", records_expected=30,
                     records_imported=30, snapshot_sha256="0" * 64,
                     error_summary="Bearer sk-private-value"))
    job = Job(job_type="property_load", status="running", total=2, completed=0, skipped=1, failed=0)
    db.add(job); db.flush()
    db.add(JobItem(job_id=job.id, product_id=product.id, status="skipped",
                   details={"reason": "Товар больше не относится к выбранной категории", "api_key": "sk-private-value"}))
    db.add(JobItem(job_id=job.id, product_id=None, status="running", details={"reason": "Bearer sk-private-value"}))
    db.commit()

    first = client.get("/api/v1/admin/logs", params={"page_size": 10})
    assert first.status_code == 200 and first.json()["total"] == 34
    assert len(first.json()["items"]) == 10
    second = client.get("/api/v1/admin/logs", params={"page": 2, "page_size": 10})
    assert second.status_code == 200
    assert set(item["id"] for item in first.json()["items"]).isdisjoint(item["id"] for item in second.json()["items"])
    structure = client.get("/api/v1/admin/logs", params={"kind": "structure"}).json()
    assert structure["total"] == 1 and structure["items"][0]["warning_count"] == 1
    searched = client.get("/api/v1/admin/logs", params={"kind": "property", "q": "rule_updated"}).json()
    assert searched["total"] == 30
    loads = client.get("/api/v1/admin/logs", params={"kind": "load"}).json()
    assert loads["total"] == 2
    assert any(item["reason"] == "Товар больше не относится к выбранной категории" for item in loads["items"])
    assert all("sk-private-value" not in str(item) for item in loads["items"])
    assert "sk-private-value" not in first.text and "private-key" not in structure.__str__()
    assert client.get("/api/v1/admin/logs", params={"status": "skipped"}).json()["total"] == 1
    assert client.get("/api/v1/admin/logs", params={"status": "warning"}).json()["total"] == 1
    by_product = client.get("/api/v1/admin/logs", params={"product_id": product.id}).json()
    assert {item["action"] for item in by_product["items"]} == {
        "properties.ai_load_skipped", "properties.ai_load_failed", "product.attribute_changed"}
    assert client.get("/api/v1/admin/logs", params={"date_from": "2030-01-01"}).json()["total"] == 0
    imports = client.get("/api/v1/admin/logs/imports").json()
    assert imports["total"] == 1 and imports["items"][0]["imported"] == 30
    assert "sk-private-value" not in str(imports)

    # A fresh session reads the committed job and event rows, as after a server restart.
    from sqlalchemy.orm import Session
    with Session(db.get_bind()) as fresh:
        main.app.dependency_overrides[get_db] = lambda: fresh
        progress = client.get("/api/v1/admin/logs/jobs")
        assert progress.status_code == 200
        item = progress.json()["items"][0]
        assert (item["total"], item["completed"], item["skipped"], item["failed"]) == (2, 0, 1, 0)
        assert item["items"][0]["reason"] == "Товар больше не относится к выбранной категории"
        assert "sk-private-value" not in progress.text
    main.app.dependency_overrides[get_db] = lambda: db


def test_journal_requires_admin(catalog_client):
    client, db = catalog_client
    main.app.dependency_overrides.pop(main.admin_user)
    assert client.get("/api/v1/admin/logs").status_code == 401
    assert client.get("/api/v1/admin/logs/jobs").status_code == 401
    assert client.get("/api/v1/admin/logs/imports").status_code == 401


def test_journal_distinguishes_admins_and_job_initiator(catalog_client):
    client, db = catalog_client
    first = db.scalar(select(User).where(User.username == "catalog-test"))
    second = User(username="second-admin", password_hash="test", role="admin")
    db.add(second); db.flush()
    job = Job(job_type="property_load", status="completed", total=1, completed=1)
    db.add(job); db.flush()
    db.add_all([
        AuditLog(user_id=first.id, action="product.selection_changed", object_type="product", object_id="1"),
        AuditLog(user_id=second.id, action="properties.rule_updated", object_type="property_rules", object_id="2"),
        AuditLog(user_id=second.id, action="properties.ai_load_queued", object_type="category", object_id="3",
                 details={"job_id": job.id}),
        AuditLog(action="properties.ai_load_completed", object_type="product", object_id="1",
                 details={"job_id": job.id}),
        AuditLog(action="properties.rule_updated", object_type="property_rules", object_id="4"),
    ])
    db.commit()

    events = client.get("/api/v1/admin/logs").json()["items"]
    by_action = {(row["action"], row["object_id"]): row for row in events}
    assert by_action["product.selection_changed", "1"]["author"] == "catalog-test"
    assert by_action["properties.rule_updated", "2"]["author"] == "second-admin"
    assert by_action["properties.rule_updated", "4"]["author"] == "Не указан"
    completed = by_action["properties.ai_load_completed", "1"]
    assert (completed["author"], completed["initiated_by"]) == ("Система", "second-admin")
    jobs = client.get("/api/v1/admin/logs/jobs").json()["items"]
    assert jobs[0]["initiated_by"] == "second-admin"


def test_journal_includes_ai_structure_lifecycle_and_failure_diagnostics(catalog_client):
    client, db = catalog_client
    user = db.scalar(select(User).where(User.username == "catalog-test"))
    lifecycle = [
        ("properties.ai_structure_queued", "queued", {}),
        ("properties.ai_structure_started", "running", {}),
        ("properties.ai_structure_failed", "failed", {
            "error": "Не удалось подтвердить источник; отклонена модель: Brand A Model 1; причина: неподтверждённая ссылка; рассмотрены: Brand A Model 1, Brand B Model 2",
            "rejected_model": "Brand A Model 1",
            "considered_models": ["Brand A Model 1", "Brand B Model 2"],
            "reason": "ссылка не найдена среди подтверждённых результатов Kimi Search",
        }),
        ("properties.ai_structure_generated", "completed", {
            "source_urls": ["https://www.asus.com/motherboards/model-a/",
                            "https://support.asus.com/model-b/", "javascript:alert(1)",
                            "https://user:password@unsafe.example/product"]}),
    ]
    for action, status, details in lifecycle:
        db.add(AuditLog(user_id=user.id, action=action, object_type="category", object_id="124",
                        details={"job_id": 77, "status": status, **details}))
    db.commit()

    events = client.get("/api/v1/admin/logs", params={"kind": "structure"}).json()
    assert events["total"] == 4
    by_action = {item["action"]: item for item in events["items"]}
    assert by_action["properties.ai_structure_queued"]["status"] == "queued"
    assert by_action["properties.ai_structure_started"]["status"] == "running"
    failed = by_action["properties.ai_structure_failed"]
    assert failed["status"] == "failed"
    assert "Brand A Model 1" in failed["reason"]
    assert "Brand B Model 2" in failed["reason"]
    generated = by_action["properties.ai_structure_generated"]
    assert generated["status"] == "completed"
    assert generated["sources"] == [
        {"url": "https://www.asus.com/motherboards/model-a/", "label": "www.asus.com"},
        {"url": "https://support.asus.com/model-b/", "label": "support.asus.com"},
    ]
    assert client.get("/api/v1/admin/logs", params={"status": "running"}).json()["total"] == 1
    assert client.get("/api/v1/admin/logs", params={"status": "failed"}).json()["total"] == 1
    assert client.get("/api/v1/admin/logs", params={"q": "Brand B Model 2"}).json()["total"] == 1
