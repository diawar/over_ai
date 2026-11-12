"""Read CPU catalog and existing power evidence directly from the local DB."""
import json
from sqlalchemy import select
from app.db import SessionLocal
from app.models import Product, ProductAttribute, Attribute, Category
with SessionLocal() as db:
    result=[]
    for p in db.scalars(select(Product).where(Product.categories.any(Category.name == 'Процессоры')).order_by(Product.id)):
        values={}
        for a,v in db.execute(select(Attribute,ProductAttribute).join(ProductAttribute,ProductAttribute.attribute_id==Attribute.id).where(
            ProductAttribute.product_id==p.id, Attribute.code.in_(['cpu_tdp_w','cpu_max_turbo_power_w','cpu_ppt_w','socket','cpu_series']))):
            values[a.code]={'value':str(v.value_number) if v.value_number is not None else v.value_string,
                'state':v.value_state,'source_url':v.source_url}
        result.append({'id':p.id,'org':p.organization_id,'sku':p.sku,'name':p.name,'manufacturer':p.manufacturer,'values':values})
    print(json.dumps(result,ensure_ascii=False))
