"""Run explicitly against corelab_test only; verifies v4 values and v6 archive."""
import os
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from alembic import command
from alembic.config import Config

url = make_url(os.environ["DATABASE_URL"]).set(database="corelab_test")
assert url.database == "corelab_test"
os.environ["DATABASE_URL"] = url.render_as_string(hide_password=False)
engine = create_engine(url)
assert set(inspect(engine).get_table_names()) <= {"alembic_version"}, "Test DB must be empty"
config = Config("alembic.ini")
command.stamp(config, "base")
command.upgrade(config, "0004_offer_current")
with engine.begin() as db:
    source = db.scalar(text("INSERT INTO catalog_sources(code,name,endpoint) VALUES ('migration','Migration','local://test') RETURNING id"))
    product = db.scalar(text("INSERT INTO products(source_id,sku,name,raw_data) VALUES (:source,'migration','Preserved','{}') RETURNING id"), {"source": source})
    attribute = db.scalar(text("INSERT INTO attributes(code,label,value_type) VALUES ('migration_bool','Existing boolean','boolean') RETURNING id"))
    db.execute(text("INSERT INTO product_attributes(product_id,attribute_id,value_boolean) VALUES (:product,:attribute,false)"), {"product": product, "attribute": attribute})
command.upgrade(config, "0005_property_rules")
with engine.begin() as db:
    db.execute(text("INSERT INTO property_rules(scope,code,source,definition) VALUES ('global','legacy_gtin','gmc',CAST(:definition AS jsonb))"), {"definition": '{"code":"legacy_gtin","label":"Legacy","source":"gmc","level":"required"}'})
    db.execute(text("INSERT INTO property_rules(scope,code,source,definition) VALUES ('global','google_product_category','internal',CAST(:definition AS jsonb))"), {"definition": '{"code":"google_product_category","label":"Legacy category","source":"internal","level":"recommended"}'})
command.upgrade(config, "head")
with engine.connect() as db:
    assert db.execute(text("SELECT value_boolean,value_state FROM product_attributes")).one() == (False, "known")
    archived = db.execute(text("SELECT active,revision FROM property_rules ORDER BY code")).all()
    assert archived == [(False, 2), (False, 2)]
command.downgrade(config, "0004_offer_current")
with engine.connect() as db:
    assert db.scalar(text("SELECT value_boolean FROM product_attributes")) is False
command.upgrade(config, "head")
with engine.connect() as db:
    assert db.execute(text("SELECT value_boolean,value_state FROM product_attributes")).one() == (False, "known")
command.downgrade(config, "base")
print("PASS: upgrade / downgrade / upgrade preserves existing product values (test DB only)")
