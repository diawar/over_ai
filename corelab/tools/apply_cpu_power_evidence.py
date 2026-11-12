"""Apply reviewed numeric CPU evidence directly to DB, no HTTP/AI calls."""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from decimal import Decimal
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Product, Category, Attribute, ProductAttribute, AuditLog
from app.validity import lock_validation, revalidate_product

parser=argparse.ArgumentParser()
parser.add_argument('--apply',action='store_true')
args=parser.parse_args()
evidence=json.loads(Path('/evidence/offline-cpu-power-evidence-2026-11-04.json').read_text(encoding='utf-8-sig'))
with SessionLocal() as db:
    lock_validation(db)
    changes=[]; missing=[]; reviewed=0
    products=list(db.scalars(select(Product).where(Product.categories.any(Category.name=='Процессоры')).order_by(Product.id).with_for_update()))
    for p in products:
        matches=[]
        for group in evidence['groups']:
            for model,value in group['values'].items():
                if re.search(r'(?<![a-z0-9])'+re.escape(model)+r'(?![a-z0-9])',p.name,re.I):
                    matches.append((group,model,value))
        assert len(matches)<=1, (p.id,matches)
        if not matches:
            missing.append({'id':p.id,'name':p.name});continue
        group,model,value=matches[0]
        reviewed+=1
        code=group['code']
        assert code in ('cpu_max_turbo_power_w','cpu_ppt_w') and 0<value<1000
        assert ('Intel' in p.name)==(code=='cpu_max_turbo_power_w')
        db.info['organization_id']=p.organization_id
        attr=db.scalar(select(Attribute).where(Attribute.organization_id==p.organization_id,Attribute.code==code))
        assert attr
        row=db.scalar(select(ProductAttribute).where(ProductAttribute.product_id==p.id,ProductAttribute.attribute_id==attr.id).with_for_update())
        before=None if row is None else {k:str(getattr(row,k)) if k in ('value_number','updated_at') and getattr(row,k) is not None else getattr(row,k)
            for k in ('value_number','value_string','value_json','value_boolean','value_state','source_url','source_kind','updated_at')}
        if row and row.value_state=='known' and row.value_number==Decimal(str(value)):
            continue
        # Existing contradictory numeric evidence is reviewed separately, not silently overwritten.
        assert row is None or row.value_number is None or row.value_state!='known', (p.id,'Existing value differs',before,value)
        changes.append({'product_id':p.id,'sku':p.sku,'model':model,'code':code,'before':before,'after':value,
            'source':group['source'],'source_kind':group['kind']})
        if args.apply:
            if row is None:
                row=ProductAttribute(organization_id=p.organization_id,product_id=p.id,attribute_id=attr.id)
                db.add(row)
            row.value_number=Decimal(str(value));row.value_string=None;row.value_json=None;row.value_boolean=None
            row.value_state='known';row.source_url=group['source'];row.source_kind=group['kind']
            row.updated_at=datetime.now(timezone.utc)
            db.flush()
            revalidate_product(db,p)
    if args.apply and changes:
        audit=AuditLog(organization_id=1,action='properties.cpu_power_offline_filled',object_type='products',
            object_id='cpu_power_2026_11_04',details={'evidence_file':'offline-cpu-power-evidence-2026-11-04.json',
                'ai_api_calls':0,'changes':changes})
        db.add(audit);db.flush();audit_id=audit.id;db.commit()
        print('AUDIT',audit_id)
    print(json.dumps({'mode':'apply' if args.apply else 'preview','total':len(products),'reviewed':reviewed,
        'changed':len(changes),'remaining':missing},ensure_ascii=False))
