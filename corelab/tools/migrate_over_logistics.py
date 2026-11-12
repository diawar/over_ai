"""One-time, guarded import of the owner's delivery table into Over settings."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Organization, AuditLog
from app.organization_operations import Operations

parser = argparse.ArgumentParser()
parser.add_argument('policy')
parser.add_argument('--apply', action='store_true')
args = parser.parse_args()
content = Path(args.policy).read_bytes()
policy = json.loads(content.decode('utf-8-sig'))
code = lambda label: re.sub(r'[^A-Za-z0-9_-]', '_', label).upper()
targets = {'Алматы':'OVER ALP','Астана':'OVER AS','Павлодар':'OVER PAV'}
excluded = set(policy['availabilityPolicy']['excludedSupplierLabels'])
branches = []
routes = []
for row in policy['warehouses']:
    branches.append(dict(code=code(row['label']),name=row['label'],city=row['city'],address='',
                         kind='branch' if row['label'] in targets.values() else 'warehouse' if row['label'].startswith('OVER ') else 'supplier_warehouse',
                         source_label=row['label'],active=row.get('active',True) and row['label'] not in excluded and not row.get('excludeInventory',False)))
    for city, days in row['deliveries'].items():
        if days is None or row['label'] == targets[city]: continue
        routes.append(dict(from_branch=code(row['label']),to_branch=code(targets[city]),workdays=days))

with SessionLocal() as db:
    org = db.scalar(select(Organization).where(Organization.id==1).with_for_update())
    if not org or org.name != 'ТОО "OVER-SHOP.KZ"': raise SystemExit('Unexpected target organization')
    current = Operations.model_validate(org.operations or {})
    if current.branches or current.routes:
        if [r.model_dump() for r in current.branches] == branches and [r.model_dump() for r in current.routes] == routes:
            print('Already migrated; no changes'); raise SystemExit(0)
        raise SystemExit('Existing logistics settings found: refusing to overwrite')
    new = Operations.model_validate({**current.model_dump(mode='json'),'branches':branches,'routes':routes,'version':current.version+1})
    summary = {'organization_id':org.id,'branches':len(branches),'routes':len(routes),
               'own_branches':[b['name'] for b in branches if b['kind']=='branch'],
               'disabled':[b['name'] for b in branches if not b['active']],
               'source':policy['source'],'source_sha256':hashlib.sha256(content).hexdigest()}
    print(json.dumps(summary,ensure_ascii=False))
    if args.apply:
        before = org.operations
        org.operations = new.model_dump(mode='json')
        db.add(AuditLog(organization_id=org.id,action='settings.organization_logistics_migrated',object_type='organization',
                        object_id=str(org.id),details={**summary,'before':before,'version':new.version}))
        db.commit()
        print('APPLIED AND COMMITTED')
    else:
        print('DRY RUN; no changes')
