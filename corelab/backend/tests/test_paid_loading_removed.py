from pathlib import Path
from types import SimpleNamespace
import runpy

import pytest
from sqlalchemy import func, select, text

from app.models import Job, JobItem, ProductAttribute
from test_catalog_views import catalog_client
from test_property_views import csrf


@pytest.mark.parametrize('path', [
    '/categories/2/load', '/categories/2/generate', '/products/4/load',
    '/jobs/1', '/structure-jobs/1',
])
def test_removed_paid_loading_endpoints_cannot_create_jobs(catalog_client, path):
    client, db = catalog_client
    before_jobs = db.scalar(select(func.count()).select_from(Job))
    before_values = db.scalar(select(func.count()).select_from(ProductAttribute))
    url = '/api/v1/admin/properties' + path
    assert client.get(url).status_code == 404
    assert client.post(url, json={}, headers=csrf(client)).status_code == 404
    assert db.scalar(select(func.count()).select_from(Job)) == before_jobs
    assert db.scalar(select(func.count()).select_from(ProductAttribute)) == before_values


def test_retirement_removes_pending_billing_but_preserves_history(catalog_client):
    _, db = catalog_client
    pending = Job(organization_id=1, job_type='property_load', status='queued', total=1)
    history = Job(organization_id=1, job_type='property_structure', status='completed', total=1)
    unrelated = Job(organization_id=1, job_type='other', status='queued', total=1)
    db.add_all([pending, history, unrelated])
    db.flush()
    db.add_all([JobItem(organization_id=1, job_id=job.id, status=job.status)
                for job in (pending, history, unrelated)])
    db.commit()
    ids = pending.id, history.id, unrelated.id
    migration = runpy.run_path(str(Path(__file__).parents[1] / 'alembic/versions/0031_retire_paid_loading.py'))
    migration['upgrade'].__globals__['op'] = SimpleNamespace(execute=lambda sql: db.execute(text(sql)))
    migration['upgrade']()
    db.commit()
    db.expire_all()
    assert set(db.scalars(select(Job.id).where(Job.id.in_(ids)))) == {ids[1], ids[2]}
    assert set(db.scalars(select(JobItem.job_id).where(JobItem.job_id.in_(ids)))) == {ids[1], ids[2]}
