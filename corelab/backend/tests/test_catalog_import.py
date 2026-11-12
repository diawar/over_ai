import os

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.db import Base
from app.models import (CatalogSource, Category, ImportLog, Organization, Product, ProductAttribute,
                        ProductSourceLink, SupplierOffer, Attribute, User,
                        product_categories)
from app.catalog_import import SOURCE_ENDPOINT, import_snapshot


@pytest.fixture
def session():
    source_url = os.environ.get("DATABASE_URL", "postgresql+psycopg://corelab:local@localhost/corelab")
    url = os.environ.get("TEST_DATABASE_URL", source_url.rsplit("/", 1)[0] + "/corelab_test")
    engine = create_engine(url, pool_pre_ping=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    with factory() as db:
        db.add(Organization(id=1, name='ТОО "OVER-SHOP.KZ"'))
        db.commit()
        yield db
    Base.metadata.drop_all(engine)
    engine.dispose()


def sample_snapshot():
    return {
        "source": SOURCE_ENDPOINT,
        "downloadedAtUtc": "2026-10-14T10:00:00.000Z",
        "totalElements": 2,
        "pagesFetched": 1,
        "items": [
            {"skuOver": "SKU-001", "name": "GPU A", "category": "Видеокарты", "article": "A-1",
             "manufacturer": "Example", "priceLoan": 12345.5, "priceBonus": 12000, "priceSpecial": None,
             "isArchived": False, "dealersData": ["WAREHOUSE (2) - 1 / 1 / 1"], "extraFutureField": None},
            {"skuOver": "SKU-002", "name": "GPU B", "category": "Видеокарты", "article": None,
             "manufacturer": None, "priceLoan": 0, "priceBonus": None, "priceSpecial": 10,
             "isArchived": True, "dealersData": [], "nested": {"unknown": [None, True, 2]}},
        ],
    }


def test_import_preserves_fields_links_and_existing_users(session):
    session.add(User(username="preserve-me", password_hash="hash", role="admin"))
    session.flush()
    original_users = session.scalar(select(func.count()).select_from(User))
    result = import_snapshot(session, sample_snapshot(), "a" * 64, batch_size=1)
    session.flush()
    assert result["products"] == 2
    assert result["categories"] == 1
    assert session.scalar(select(func.count()).select_from(Product)) == 2
    assert session.scalar(select(func.count()).select_from(SupplierOffer)) == 2
    assert session.scalar(select(func.count()).select_from(ProductSourceLink)) == 2
    assert session.scalar(select(func.count()).select_from(Category)) == 1
    assert session.scalar(select(func.count()).select_from(product_categories)) == 2
    assert session.scalar(select(func.count()).select_from(User)) == original_users
    product = session.scalar(select(Product).where(Product.sku == "p1:SKU-001"))
    offer = session.scalar(select(SupplierOffer).where(SupplierOffer.sku == "SKU-001"))
    assert product.price is None
    assert product.raw_data == {}
    assert offer.price == 12345.50
    assert offer.price_bonus == 12000
    assert offer.price_special is None
    assert offer.currency == "KZT"
    assert offer.raw_data["extraFutureField"] is None
    assert product.validity_check is None and product.selection_enabled is True
    assert product.categories[0].name == "Видеокарты"
    assert session.scalar(select(ImportLog.status)) == "completed"


def test_reimport_is_idempotent(session):
    snapshot = sample_snapshot()
    import_snapshot(session, snapshot, "b" * 64)
    import_snapshot(session, snapshot, "b" * 64)
    session.flush()
    assert session.scalar(select(func.count()).select_from(CatalogSource)) == 2
    assert session.scalar(select(func.count()).select_from(Product)) == 2
    assert session.scalar(select(func.count()).select_from(SupplierOffer)) == 2
    assert session.scalar(select(func.count()).select_from(ProductSourceLink)) == 2
    assert session.scalar(select(func.count()).select_from(Category)) == 1
    assert session.scalar(select(func.count()).select_from(product_categories)) == 2
    assert session.scalar(select(func.count()).select_from(ImportLog)) == 2


def test_reimport_updates_offer_without_overwriting_corelab_properties(session):
    snapshot = sample_snapshot()
    import_snapshot(session, snapshot, "d" * 64)
    product = session.scalar(select(Product).where(Product.sku == "p1:SKU-001"))
    attribute = Attribute(code="color", label="Цвет", value_type="string")
    session.add(attribute)
    session.flush()
    session.add(ProductAttribute(product_id=product.id, attribute_id=attribute.id, value_string="синий"))
    session.flush()
    product.name = "Локальное название CoreLab"
    snapshot["items"][0]["name"] = "Новое название поставщика"
    snapshot["items"][0]["priceLoan"] = 11000
    import_snapshot(session, snapshot, "e" * 64)
    session.flush()
    assert session.scalar(select(Product.name).where(Product.id == product.id)) == "Локальное название CoreLab"
    assert session.scalar(select(ProductAttribute.value_string).where(ProductAttribute.product_id == product.id)) == "синий"
    assert session.scalar(select(SupplierOffer.price).where(SupplierOffer.sku == "SKU-001")) == 11000


def test_full_snapshot_marks_missing_offer_without_deleting_core_product(session):
    snapshot = sample_snapshot()
    import_snapshot(session, snapshot, "f" * 64)
    snapshot["items"] = snapshot["items"][:1]
    snapshot["totalElements"] = 1
    import_snapshot(session, snapshot, "1" * 64)
    missing = session.scalar(select(SupplierOffer).where(SupplierOffer.sku == "SKU-002"))
    product = session.scalar(select(Product).where(Product.sku == "p1:SKU-002"))
    assert missing.is_current is False
    assert product is not None
    assert session.scalar(select(func.count()).select_from(ProductSourceLink)) == 2
    assert session.scalar(select(func.count()).select_from(SupplierOffer).where(SupplierOffer.is_current.is_(True))) == 1


@pytest.mark.parametrize("change", [
    lambda data: data.update(totalElements=3),
    lambda data: data["items"].append(dict(data["items"][0])),
    lambda data: data["items"][0].update(priceLoan=float("nan")),
    lambda data: data.update(source="https://example.invalid/catalog"),
])
def test_rejects_incomplete_duplicate_or_unsafe_snapshots(session, change):
    snapshot = sample_snapshot()
    change(snapshot)
    with pytest.raises(ValueError):
        import_snapshot(session, snapshot, "c" * 64)
    session.flush()
    assert session.scalar(select(func.count()).select_from(Product)) == 0
