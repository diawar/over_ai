"""Record manufacturer-confirmed physical GPU cable counts, dry run by default."""
import argparse
from datetime import datetime, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Attribute, AuditLog, Product, ProductAttribute
from app.validity import lock_validation


# product_id: (PCIe 6+2 cables, PCIe 16-pin cables, official source)
FACTS = {
    25731: (2, 1, 'https://www.fsplifestyle.com/en/product/VICBD750W.html'),
    25735: (1, None, 'https://www.fsplifestyle.com/en/product/VICBD550W.html'),
    4459: (1, None, 'https://www.fsplifestyle.com/en/product/VICBD650W.html'),
    5658: (2, 1, 'https://www.fsplifestyle.com/en/product/VICGD850W.html'),
    18500: (2, 1, 'https://www.fsplifestyle.com/en/product/VITAGM850W.html'),
    2240: (2, 1, 'https://www.fsplifestyle.com/en/product/VITAGM1000W.html'),
    26137: (2, 1, 'https://www.fsplifestyle.com/en/product/VITAGM1000W_WHITE.html'),
    4596: (1, None, 'https://seasonic.com/core-gc-atx-3-1/'),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    with SessionLocal() as db:
        attr = db.scalar(select(Attribute).where(Attribute.code == 'psu_pcie_connectors'))
        if attr is None or attr.value_type != 'list':
            raise RuntimeError('PSU PCIe property mismatch')
        changes = []
        for product_id, (eight_cables, sixteen_cables, source) in FACTS.items():
            product = db.get(Product, product_id)
            if not product or not product.validity_check:
                raise RuntimeError(f'PSU eligibility changed: {product_id}')
            row = db.scalar(select(ProductAttribute).where(
                ProductAttribute.product_id == product_id,
                ProductAttribute.attribute_id == attr.id))
            if not row or row.source_url != source or not isinstance(row.value_json, list):
                raise RuntimeError(f'PSU source/value changed: {product_id}')
            values = [dict(entry) for entry in row.value_json]
            expected = {'pcie_8': eight_cables, 'pcie_16': sixteen_cables}
            for kind, cables in expected.items():
                entries = [entry for entry in values if entry.get('kind') == kind]
                if cables is None and entries:
                    raise RuntimeError(f'Unexpected connector {kind} on {product_id}')
                if cables is not None and (len(entries) != 1 or entries[0]['count'] < cables):
                    raise RuntimeError(f'Connector count mismatch for {product_id}: {kind}')
                if entries:
                    entries[0]['cables'] = cables
            if values != row.value_json:
                changes.append((row, values, product_id))
                print(f'VALUE product={product_id}: 8pin_cables={eight_cables} 16pin_cables={sixteen_cables}')
        if not args.apply:
            print(f'DRY RUN: {len(changes)} products; no writes.')
            return
        if not changes:
            print('UNCHANGED')
            return
        lock_validation(db)
        now = datetime.now(timezone.utc)
        for row, values, product_id in changes:
            row.value_json = values
            row.updated_at = now
            db.add(AuditLog(action='properties.psu_gpu_cables_verified', object_type='product',
                object_id=str(product_id), details={'source_url': row.source_url,
                    'cables': {entry['kind']: entry.get('cables') for entry in values}}))
        db.commit()
        print(f'APPLIED: {len(changes)} products.')


if __name__ == '__main__':
    main()
