"""Import a validated p1 snapshot into the local PostgreSQL catalog."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert

from .models import (CatalogSource, Category, ImportLog, Product, ProductSourceLink,
                     SupplierOffer, product_categories)

SOURCE_CODE = "p1"
SOURCE_NAME = "p1.overclockers.kz"
SOURCE_ENDPOINT = "https://p1.overclockers.kz/api/master-catalog/all"


def _price(value, sku, field):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"Invalid {field} for skuOver {sku}")
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f"Invalid {field} for skuOver {sku}") from None
    if not result.is_finite():
        raise ValueError(f"Invalid {field} for skuOver {sku}")
    return result


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("items"), list):
        raise ValueError("Snapshot must contain an items array")
    if snapshot.get("source") != SOURCE_ENDPOINT:
        raise ValueError("Snapshot source does not match the approved p1 catalog endpoint")
    items = snapshot["items"]
    if snapshot.get("totalElements") != len(items):
        raise ValueError("Snapshot totalElements does not match items")
    if not isinstance(snapshot.get("pagesFetched"), int) or snapshot["pagesFetched"] < 0:
        raise ValueError("Snapshot pagesFetched is invalid")
    seen = set()
    categories = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Catalog item must be an object")
        sku = item.get("skuOver")
        if not isinstance(sku, str) or not sku.strip():
            raise ValueError("Catalog item has invalid skuOver")
        if sku in seen:
            raise ValueError(f"Duplicate skuOver {sku}")
        seen.add(sku)
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            raise ValueError(f"Catalog item {sku} has invalid name")
        if len(sku) > 117 or len(item["name"]) > 1000:
            raise ValueError(f"Catalog item {sku[:40]} exceeds a supported text length")
        for field, limit in (("article", 300), ("manufacturer", 300)):
            value = item.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > limit):
                raise ValueError(f"Catalog item {sku} has invalid {field}")
        category = item.get("category")
        if category is not None and not isinstance(category, str):
            raise ValueError(f"Catalog item {sku} has invalid category")
        dealers = item.get("dealersData")
        if dealers is not None and (
            not isinstance(dealers, list)
            or any(not isinstance(row, str) for row in dealers)
        ):
            raise ValueError(f"Catalog item {sku} has invalid dealersData")
        categories.add(category if category else None)
        for field in ("priceLoan", "priceBonus", "priceSpecial"):
            _price(item.get(field), sku, field)
        # Fail before opening a database transaction if any field cannot round-trip
        # into PostgreSQL JSONB (for example NaN or Infinity).
        json.dumps(item, ensure_ascii=False, allow_nan=False)
    return items, categories


def _download_time(snapshot):
    value = snapshot.get("downloadedAtUtc")
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        raise ValueError("Snapshot downloadedAtUtc is invalid") from None
    if parsed.tzinfo is None:
        raise ValueError("Snapshot downloadedAtUtc must include a timezone")
    return parsed.astimezone(timezone.utc)


def upsert_offers(session, batch, organization_id, source_id):
    offer_values = [{
        "organization_id": organization_id, "source_id": source_id, "sku": item["skuOver"], "raw_data": item,
        "price": _price(item.get("priceLoan"), item["skuOver"], "priceLoan"),
        "price_bonus": _price(item.get("priceBonus"), item["skuOver"], "priceBonus"),
        "price_special": _price(item.get("priceSpecial"), item["skuOver"], "priceSpecial"),
        "currency": "KZT",
        "is_archived": item.get("isArchived") if isinstance(item.get("isArchived"), bool) else None,
        "is_current": True,
    } for item in batch]
    offer_stmt = insert(SupplierOffer).values(offer_values)
    offer_stmt = offer_stmt.on_conflict_do_update(
        constraint="uq_offer_source_sku",
        set_={key: getattr(offer_stmt.excluded, key) for key in
              ("raw_data", "price", "price_bonus", "price_special", "currency", "is_archived", "is_current", "imported_at")},
    ).returning(SupplierOffer.id, SupplierOffer.sku)
    return {sku: offer_id for offer_id, sku in session.execute(offer_stmt).all()}


def import_snapshot(session, snapshot, snapshot_sha256, batch_size=500):
    """Upsert one complete snapshot. Caller owns the encompassing transaction."""
    from .validity import lock_validation, revalidate_product
    lock_validation(session)
    if not isinstance(snapshot_sha256, str) or len(snapshot_sha256) != 64:
        raise ValueError("Expected a SHA-256 digest for the staged snapshot")
    items, category_names = validate_snapshot(snapshot)
    downloaded_at = _download_time(snapshot)
    organization_id = session.info.get("organization_id", 1)

    source_stmt = insert(CatalogSource).values(organization_id=organization_id, code=SOURCE_CODE, name=SOURCE_NAME, endpoint=SOURCE_ENDPOINT)
    source_stmt = source_stmt.on_conflict_do_update(
        constraint="uq_source_organization_code",
        set_={"name": source_stmt.excluded.name, "endpoint": source_stmt.excluded.endpoint},
    ).returning(CatalogSource.id)
    source_id = session.execute(source_stmt).scalar_one()

    core_stmt = insert(CatalogSource).values(
        organization_id=organization_id, code="corelab", name="Каталог CoreLab", endpoint="local://corelab/catalog"
    ).on_conflict_do_nothing(constraint="uq_source_organization_code").returning(CatalogSource.id)
    core_source_id = session.execute(core_stmt).scalar_one_or_none()
    if core_source_id is None:
        from sqlalchemy import select
        core_source_id = session.scalar(select(CatalogSource.id).where(
            CatalogSource.organization_id == organization_id, CatalogSource.code == "corelab"))

    category_ids = {}
    for category_name in category_names:
        external_category_id = category_name if category_name else "__uncategorized__"
        display_name = category_name if category_name else "(без категории)"
        category_stmt = insert(Category).values(
            organization_id=organization_id,
            source_id=core_source_id,
            source_category_id=external_category_id,
            name=display_name,
            selection_category=False,
        )
        category_stmt = category_stmt.on_conflict_do_update(
            constraint="uq_category_source_key", set_={"name": category_stmt.excluded.name}
        ).returning(Category.id)
        category_ids[category_name] = session.execute(category_stmt).scalar_one()

    run = ImportLog(
        source_id=source_id,
        status="running",
        records_expected=len(items),
        records_imported=0,
        source_downloaded_at=downloaded_at,
        snapshot_sha256=snapshot_sha256,
    )
    session.add(run)
    session.flush()

    # This import is a complete, already-validated snapshot. Mark previous
    # offers as absent first; rows encountered below become current again.
    session.execute(update(SupplierOffer).where(SupplierOffer.source_id == source_id)
                    .values(is_current=False))

    imported = 0
    for offset in range(0, len(items), batch_size):
        batch = items[offset:offset + batch_size]
        # Create a canonical CoreLab product once. Subsequent supplier updates
        # touch only SupplierOffer, preserving locally maintained product fields.
        canonical_values = [{
            "organization_id": organization_id, "source_id": core_source_id, "sku": f"p1:{item['skuOver']}",
            "name": item["name"], "manufacturer_article": item.get("article"),
            "manufacturer": item.get("manufacturer"), "price": None,
            "price_bonus": None, "price_special": None, "currency": "KZT",
            "status": "active", "is_archived": None, "validity_check": None,
            "selection_enabled": True, "image_url": None, "image_path": None,
            "raw_data": {},
        } for item in batch]
        product_stmt = insert(Product).values(canonical_values).on_conflict_do_nothing(
            constraint="uq_product_source_sku"
        ).returning(Product.id, Product.sku)
        from sqlalchemy import select
        product_ids = {sku.removeprefix("p1:"): product_id
                       for product_id, sku in session.execute(product_stmt).all()}
        existing = session.execute(select(Product.id, Product.sku).where(
            Product.source_id == core_source_id,
            Product.sku.in_([f"p1:{item['skuOver']}" for item in batch]),
        )).all()
        product_ids.update({sku.removeprefix("p1:"): product_id for product_id, sku in existing})

        offer_ids = upsert_offers(session, batch, organization_id, source_id)

        link_values = [
            {"product_id": product_ids[item["skuOver"]], "category_id": category_ids[item.get("category") or None]}
            for item in batch
        ]
        if link_values:
            session.execute(delete(product_categories).where(
                product_categories.c.product_id.in_([row["product_id"] for row in link_values])))
            link_stmt = insert(product_categories).values(link_values).on_conflict_do_nothing()
            session.execute(link_stmt)
        link_stmt = insert(ProductSourceLink).values([
            {"organization_id": organization_id, "product_id": product_ids[item["skuOver"]], "offer_id": offer_ids[item["skuOver"]]}
            for item in batch
        ]).on_conflict_do_nothing()
        session.execute(link_stmt)
        imported += len(batch)
        run.records_imported = imported
        session.flush()
        for product in session.scalars(select(Product).where(Product.id.in_(product_ids.values()))):
            # Membership inserts above use SQL, so refresh a previously loaded collection.
            session.expire(product, ["categories"])
            revalidate_product(session, product)

    run.status = "completed"
    run.finished_at = datetime.now(timezone.utc)
    session.flush()
    return {"source_id": source_id, "import_log_id": run.id, "products": imported,
            "categories": len(category_ids), "downloaded_at": downloaded_at}


def import_snapshot_file(session, path, batch_size=500):
    snapshot_path = Path(path)
    digest = hashlib.sha256()
    with snapshot_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8-sig"))
    return import_snapshot(session, snapshot, digest.hexdigest(), batch_size=batch_size)
