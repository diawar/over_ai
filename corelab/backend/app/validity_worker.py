"""Lifecycle-managed periodic reconciliation; no host daemon or external API calls."""
import asyncio
import logging

from sqlalchemy import select

from .db import SessionLocal
from .models import CatalogSource, Category, Product
from .validity import lock_validation, revalidate_product

INTERVAL_SECONDS = 15 * 60
logger = logging.getLogger(__name__)


def sweep():
    last_id = 0
    while True:
        with SessionLocal() as db:
            lock_validation(db)
            products = list(db.scalars(select(Product).join(CatalogSource).where(
                CatalogSource.code == "corelab", Product.id > last_id,
                Product.categories.any(Category.selection_category.is_(True)) | Product.validity_check.is_not(None)
            ).order_by(Product.id).limit(100)))
            if not products:
                return
            for product in products:
                db.info["organization_id"] = product.organization_id
                revalidate_product(db, product)
                db.flush()
                db.info.pop("organization_id", None)
            last_id = products[-1].id
            db.commit()


async def run_worker(stop, run=sweep, interval=INTERVAL_SECONDS):
    while not stop.is_set():
        try:
            await asyncio.to_thread(run)
        except Exception:
            logger.exception("Eligibility reconciliation failed; retrying next interval")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            pass
