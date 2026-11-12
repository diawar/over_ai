from sqlalchemy import func, select
from test_catalog_views import catalog_client
from test_catalog_import import sample_snapshot
from app.catalog_import import import_snapshot
from app.models import CatalogSource, Product, SupplierOffer, ProductSourceLink


def test_archived_snapshot_browsable_with_links_but_refresh_stays_removed(catalog_client):
    client, db = catalog_client
    import_snapshot(db, sample_snapshot(), 'a' * 64)
    source = db.scalar(select(CatalogSource).where(CatalogSource.code == 'p1'))
    source.is_active = False
    source.endpoint = 'local://archive/p1'
    db.commit()
    sources = client.get('/api/v1/admin/sources').json()['items']
    assert len(sources) == 1
    assert sources[0]['id'] == source.id and sources[0]['is_active'] is False
    assert sources[0]['total'] == 2 and sources[0]['downloaded_at'] is not None
    response = client.get(f'/api/v1/admin/sources/{source.id}/products')
    assert response.status_code == 200
    assert response.json()['total'] == 2
    assert all(item['core_product_id'] is not None for item in response.json()['items'])
    for method in ('GET', 'PATCH', 'POST'):
        assert client.request(method, f'/api/v1/admin/sources/{source.id}/refresh').status_code == 404
    for model in (Product, SupplierOffer, ProductSourceLink):
        assert db.scalar(select(func.count()).select_from(model)) == 2


def test_other_active_sources_are_still_listed(catalog_client):
    client, db = catalog_client
    source = CatalogSource(code='client-list', name='Client list', endpoint='local://client-list')
    db.add(source); db.commit()
    assert [row['id'] for row in client.get('/api/v1/admin/sources').json()['items']] == [source.id]
