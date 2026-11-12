"""Finite, audited recovery of only the products excluded by a connector migration.

Uses the normal durable product loader and the configured provider; never reads or
prints credentials. --apply enqueues batches; --work runs bounded foreground workers.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from sqlalchemy import select
from app.db import SessionLocal
from app.kimi import active_provider
from app.models import AuditLog, Job, JobItem, Product, User
from app.product_loader import enqueue, process_one

CODES = {
    359: ['motherboard_fan_headers', 'motherboard_lighting_headers'],
    437: ['cooler_fan_connectors', 'cooling_lighting_connectors'],
    246: ['cooler_fan_connectors', 'aio_pump_connectors', 'cooling_lighting_connectors'],
}


def cohort(db, audit_id):
    migration = db.get(AuditLog, audit_id)
    if not migration or migration.action != 'properties.cooling_connectors_added':
        raise RuntimeError('Expected cooling connector migration audit')
    ids = [int(row.object_id) for row in db.scalars(select(AuditLog).where(
        AuditLog.created_at == migration.created_at, AuditLog.action == 'product.validity_changed'))
        if (row.details or {}).get('previous') is True and (row.details or {}).get('validity_check') is False]
    products = list(db.scalars(select(Product).where(Product.id.in_(ids)).order_by(Product.id)))
    for product in products:
        if product.organization_id != migration.organization_id or len(product.categories) != 1 or product.categories[0].id not in CODES:
            raise RuntimeError('Recovery cohort identity changed')
    return products


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--audit-id', type=int, required=True)
    parser.add_argument('--products', type=int, nargs='+')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--work', action='store_true')
    parser.add_argument('--workers', type=int, choices=[1, 2, 3], default=3)
    parser.add_argument('--remaining', action='store_true')
    args = parser.parse_args()
    with SessionLocal() as db:
        products = cohort(db, args.audit_id)
        if args.products:
            if set(args.products) - {product.id for product in products}:
                raise RuntimeError('Requested product is outside the audited cohort')
            products = [product for product in products if product.id in args.products]
        if args.remaining:
            products = [product for product in products if product.validity_check is not True]
        provider = active_provider(db, 1)
        print(json.dumps({'cohort': len(cohort(db, args.audit_id)), 'selected': len(products),
                          'provider': provider.provider if provider else None,
                          'model': provider.model_id if provider else None}, ensure_ascii=False), flush=True)
        for product in products:
            print(f'PRODUCT {product.id} CATEGORY {product.categories[0].id} {product.name}', flush=True)
        if args.apply:
            user_id = db.scalar(select(User.id).where(User.organization_id == 1, User.role == 'admin').order_by(User.id))
            if user_id is None or provider is None:
                raise RuntimeError('Configured provider and administrator required')
            busy = set(db.scalars(select(JobItem.product_id).join(Job).where(Job.job_type == 'property_load',
                JobItem.status.in_(['queued', 'running']))))
            for category_id, codes in CODES.items():
                ids = [product.id for product in products if product.categories[0].id == category_id and
                       product.id not in busy and not product.is_archived and product.selection_enabled]
                for start in range(0, len(ids), 5):
                    job = enqueue(db, ids[start:start + 5], category_id, user_id, fill_missing_codes=codes)
                    print(f'QUEUED {job["id"]} {ids[start:start + 5]}', flush=True)
        elif not args.work:
            print('DRY RUN: no writes', flush=True)
    if args.work:
        def work():
            while process_one():
                print('ITEM FINISHED', flush=True)
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            list(executor.map(lambda _: work(), range(args.workers)))
    with SessionLocal() as db:
        products = cohort(db, args.audit_id)
        print(json.dumps({'restored': sum(product.validity_check is True for product in products),
                          'total': len(products)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
