from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, LargeBinary, Numeric, String, Table, Column, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    short_name: Mapped[str | None] = mapped_column(String(100))
    welcome_headline: Mapped[list[str] | None] = mapped_column(JSONB)
    product_links: Mapped[dict | None] = mapped_column(JSONB)
    mini_app_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    ai_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    primary_color: Mapped[str] = mapped_column(String(7), nullable=False, default="#ff416c", server_default="#ff416c")
    logo_data: Mapped[bytes | None] = mapped_column(LargeBinary)
    logo_content_type: Mapped[str | None] = mapped_column(String(32))
    operations: Mapped[dict | None] = mapped_column(JSONB)
    onboarding_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")


class OrganizationOwned:
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), nullable=False,
                                                 default=1, server_default="1", index=True)


class AIExplanationReceipt(Base):
    __tablename__ = "ai_explanation_receipts"
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    started_at: Mapped[int] = mapped_column(Integer, nullable=False)
    result: Mapped[dict | None] = mapped_column(JSONB().with_variant(JSON(), "sqlite"))
    error_code: Mapped[str | None] = mapped_column(String(40))


class User(OrganizationOwned, Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="admin")
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


product_categories = Table(
    "product_categories", Base.metadata,
    Column("product_id", ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
    Column("category_id", ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True),
    UniqueConstraint("product_id", name="uq_product_single_category"),
)


class CatalogSource(OrganizationOwned, Base):
    __tablename__ = "catalog_sources"
    __table_args__ = (UniqueConstraint("organization_id", "code", name="uq_source_organization_code"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(500), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Category(OrganizationOwned, Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("source_id", "source_category_id", name="uq_category_source_key"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False)
    source_category_id: Mapped[str] = mapped_column(String(300), nullable=False)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    selection_category: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    required_for_build: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    property_template_code: Mapped[str | None] = mapped_column(String(80))
    products: Mapped[list["Product"]] = relationship(secondary=product_categories, back_populates="categories")


class Product(OrganizationOwned, Base):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("source_id", "sku", name="uq_product_source_sku"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False)
    sku: Mapped[str] = mapped_column(String(120), nullable=False)
    name: Mapped[str] = mapped_column(String(1000), nullable=False)
    manufacturer_article: Mapped[str | None] = mapped_column(String(300))
    manufacturer: Mapped[str | None] = mapped_column(String(300))
    price: Mapped[object | None] = mapped_column(Numeric(18, 2))
    price_bonus: Mapped[object | None] = mapped_column(Numeric(18, 2))
    price_special: Mapped[object | None] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KZT", server_default="KZT")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active", server_default="active")
    is_archived: Mapped[bool | None] = mapped_column(Boolean)
    validity_check: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    selection_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    image_url: Mapped[str | None] = mapped_column(String(2000))
    image_path: Mapped[str | None] = mapped_column(String(1000))
    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    imported_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    categories: Mapped[list[Category]] = relationship(secondary=product_categories, back_populates="products")


class SupplierOffer(OrganizationOwned, Base):
    """A supplier's current price/stock row, separate from canonical products."""
    __tablename__ = "supplier_offers"
    __table_args__ = (UniqueConstraint("source_id", "sku", name="uq_offer_source_sku"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False)
    sku: Mapped[str] = mapped_column(String(120), nullable=False)
    raw_data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    price: Mapped[object | None] = mapped_column(Numeric(18, 2))
    price_bonus: Mapped[object | None] = mapped_column(Numeric(18, 2))
    price_special: Mapped[object | None] = mapped_column(Numeric(18, 2))
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="KZT", server_default="KZT")
    is_archived: Mapped[bool | None] = mapped_column(Boolean)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    imported_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ProductSourceLink(OrganizationOwned, Base):
    """Explicit, auditable relation from a canonical product to a source offer."""
    __tablename__ = "product_source_links"
    __table_args__ = (UniqueConstraint("product_id", "offer_id", name="uq_product_offer_link"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    offer_id: Mapped[int] = mapped_column(ForeignKey("supplier_offers.id", ondelete="CASCADE"), nullable=False, unique=True)


class Attribute(OrganizationOwned, Base):
    __tablename__ = "attributes"
    __table_args__ = (UniqueConstraint("organization_id", "code", name="uq_attribute_organization_code"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(160), nullable=False)
    label: Mapped[str] = mapped_column(String(300), nullable=False)
    value_type: Mapped[str] = mapped_column(String(40), nullable=False)
    unit: Mapped[str | None] = mapped_column(String(80))
    normalization: Mapped[dict | None] = mapped_column(JSONB)


class PropertyValue(OrganizationOwned, Base):
    __tablename__ = "property_values"
    __table_args__ = (UniqueConstraint("attribute_id", "value_key", name="uq_property_value_key"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    attribute_id: Mapped[int] = mapped_column(ForeignKey("attributes.id", ondelete="CASCADE"), nullable=False)
    value_key: Mapped[str] = mapped_column(String, nullable=False)
    value_json: Mapped[object] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CategoryAttribute(OrganizationOwned, Base):
    __tablename__ = "category_attributes"
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)
    attribute_id: Mapped[int] = mapped_column(ForeignKey("attributes.id", ondelete="CASCADE"), primary_key=True)
    required_for_selection: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    ai_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")


class ProductAttribute(OrganizationOwned, Base):
    __tablename__ = "product_attributes"
    __table_args__ = (UniqueConstraint("product_id", "attribute_id", name="uq_product_attribute"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    attribute_id: Mapped[int] = mapped_column(ForeignKey("attributes.id", ondelete="RESTRICT"), nullable=False)
    value_string: Mapped[str | None] = mapped_column(String)
    value_number: Mapped[object | None] = mapped_column(Numeric(20, 2))
    value_boolean: Mapped[bool | None] = mapped_column(Boolean)
    value_json: Mapped[dict | list | None] = mapped_column(JSONB)
    value_state: Mapped[str] = mapped_column(String(24), nullable=False, default="known", server_default="known")
    source_url: Mapped[str | None] = mapped_column(String(2000))
    source_kind: Mapped[str | None] = mapped_column(String(40))
    updated_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Job(OrganizationOwned, Base):
    __tablename__ = "jobs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_type: Mapped[str] = mapped_column(String(80), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="queued")
    total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class JobItem(OrganizationOwned, Base):
    __tablename__ = "job_items"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(40), nullable=False)
    details: Mapped[dict | None] = mapped_column(JSONB)


class AuditLog(OrganizationOwned, Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    object_type: Mapped[str | None] = mapped_column(String(80))
    object_id: Mapped[str | None] = mapped_column(String(160))
    details: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class ImportLog(OrganizationOwned, Base):
    __tablename__ = "import_logs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("catalog_sources.id", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False)
    records_expected: Mapped[int] = mapped_column(Integer, nullable=False)
    records_imported: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_downloaded_at: Mapped[object | None] = mapped_column(DateTime(timezone=True))
    snapshot_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    finished_at: Mapped[object | None] = mapped_column(DateTime(timezone=True))
    error_summary: Mapped[str | None] = mapped_column(String(1000))


class ValidationReason(OrganizationOwned, Base):
    __tablename__ = "validation_reasons"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), nullable=False)
    code: Mapped[str] = mapped_column(String(120), nullable=False)
    message: Mapped[str] = mapped_column(String(1000), nullable=False)
    created_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class PropertyRule(OrganizationOwned, Base):
    __tablename__ = "property_rules"
    __table_args__ = (UniqueConstraint("organization_id", "scope", "source", "code", name="uq_property_rule_scope"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scope: Mapped[str] = mapped_column(String(40), nullable=False)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="RESTRICT"))
    attribute_id: Mapped[int | None] = mapped_column(ForeignKey("attributes.id", ondelete="RESTRICT"))
    code: Mapped[str] = mapped_column(String(160), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    definition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")


class CategoryStructureCheck(OrganizationOwned, Base):
    __tablename__ = "category_structure_checks"
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    report: Mapped[dict] = mapped_column(JSONB, nullable=False)
    checked_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class AIProviderSetting(OrganizationOwned, Base):
    __tablename__ = "ai_provider_settings"
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), primary_key=True)
    provider: Mapped[str] = mapped_column(String(40), primary_key=True)
    encrypted_api_key: Mapped[str] = mapped_column(String(4000), nullable=False)
    model_id: Mapped[str] = mapped_column(String(120), nullable=False)
    updated_at: Mapped[object] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
