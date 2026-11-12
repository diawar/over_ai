from datetime import date
from types import SimpleNamespace
import pytest
from pydantic import ValidationError
from sqlalchemy import select
from app import main
from app.models import Organization, User
from app.organization_operations import Operations, Estimate, estimate, add_workdays
from test_catalog_views import catalog_client
from test_property_views import csrf

def settings(**kwargs):
    return Operations(branches=[dict(code=code, name=code, city=code, address='Address') for code in ('A', 'B')],
                      routes=[dict(from_branch='A', to_branch='B', workdays=1)], **kwargs)

def test_calendar_holidays_working_override_and_zero_days():
    config = settings(calendar_exceptions=[dict(date='2026-11-02', working=False)])
    result = estimate(config, Estimate(from_branch='A', to_branch='B', start_date='2026-10-30'))
    assert result['arrival_date'] == date(2026, 11, 3)
    assert result['ready_date'] == date(2026, 11, 5)
    assert add_workdays(date(2026, 10, 31), 0, config.branches[0]) == date(2026, 11, 3)
    config.branches[0].calendar_exceptions[0].date = date(2026, 10, 31)
    config.branches[0].calendar_exceptions[0].working = True
    assert add_workdays(date(2026, 10, 30), 1, config.branches[0]) == date(2026, 10, 31)
    with pytest.raises(ValueError, match='не разрешено'):
        estimate(config, Estimate(from_branch='B', to_branch='A', start_date='2026-10-30'))

@pytest.mark.parametrize('bad', [
    {'weekly_days_off': list(range(7))}, {'weekly_days_off':[True]}, {'weekly_days_off':[6,6]},
    {'assembly_workdays': -1}, {'assembly_workdays': 1.5},
    {'calendar_exceptions':[{'date':'2026-11-01','working':False},{'date':'2026-11-01','working':True}]},
    {'routes':[{'from_branch':'missing','to_branch':'missing','workdays':1}]},
])
def test_invalid_settings_rejected(bad):
    with pytest.raises(ValidationError): Operations(**bad)

def test_save_reload_conflict_tenant_and_csrf(catalog_client):
    client, db = catalog_client
    user = db.scalar(select(User))
    main.app.dependency_overrides[main.chief_admin_user] = lambda: user
    db.add(Organization(id=2, name='Other')); db.commit()
    url = '/api/v1/admin/settings/organization/operations'
    body = settings(calendar_exceptions=[dict(date='2026-11-02', working=False, note='Праздник')]).model_dump(mode='json')
    assert client.put(url, json=body).status_code == 403
    headers = csrf(client)
    saved = client.put(url, json=body, headers=headers)
    assert saved.status_code == 200, saved.text
    assert client.get(url).json()['branches'][0]['calendar_exceptions'] == body['branches'][0]['calendar_exceptions']
    assert client.put(url, json=body, headers=headers).status_code == 409
    result = client.post(url+'/estimate', headers=headers, json=dict(from_branch='A', to_branch='B',start_date='2026-10-30'))
    assert result.json()['ready_date'] == '2026-11-05'
    main.app.dependency_overrides[main.admin_user] = lambda: SimpleNamespace(id=user.id, organization_id=2)
    assert 'calendar_exceptions' not in client.get(url).json()
    assert db.get(Organization, 2).operations is None
    template = client.get('/api/v1/admin/sources/price-list-template.xls')
    assert template.status_code == 200
    assert template.content[:8] == bytes.fromhex('D0CF11E0A1B11AE1')

def test_regular_admin_cannot_save(catalog_client):
    client, db = catalog_client
    main.app.dependency_overrides[main.admin_user] = lambda: db.scalar(select(User))
    # Real chief dependency must still reject requests without chief authorization.
    response = client.put('/api/v1/admin/settings/organization/operations', json={}, headers=csrf(client))
    assert response.status_code in (401,403)


def test_independent_sender_receiver_and_assembly_calendars():
    config = settings()
    config.branches[0].weekly_days_off = [6]  # Sender works Saturdays.
    config.branches[1].weekly_days_off = [0, 5, 6]  # Receiver also closes Mondays.
    result = estimate(config, Estimate(from_branch='A', to_branch='B', start_date='2026-10-30'))
    assert result['start_date'] == date(2026, 10, 30)
    assert result['arrival_date'] == date(2026, 11, 3)
    assert result['ready_date'] == date(2026, 11, 5)
    # Local stock still waits for the assembly branch's next working day.
    local = estimate(config, Estimate(from_branch='B', to_branch='B', start_date='2026-10-31'))
    assert local['arrival_date'] == date(2026, 11, 3)
    assert local['ready_date'] == date(2026, 11, 5)


def test_old_calendar_is_copied_to_independent_branches_and_not_exposed():
    config = settings(calendar_exceptions=[dict(date='2026-11-02', working=False)])
    assert 'calendar_exceptions' not in config.model_dump()
    config.branches[0].calendar_exceptions[0].working = True
    assert config.branches[1].calendar_exceptions[0].working is False
    invalid = config.model_dump(mode='json')
    invalid['branches'][1]['weekly_days_off'] = list(range(7))
    with pytest.raises(ValidationError):
        Operations.model_validate(invalid)


def test_migration_preserves_routes_and_existing_branch_calendars():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('branch_migration', Path(__file__).parents[1] / 'alembic/versions/0022_branch_calendars.py')
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    original = {'version': 4, 'weekly_days_off': [6], 'calendar_exceptions': [{'date':'2026-11-02','working':False}],
                'branches': [{'code':'A'}, {'code':'B', 'weekly_days_off':[]}], 'routes':[{'from_branch':'A','to_branch':'B','workdays':1}]}
    result = migration.migrate_operations(original)
    assert result['version'] == 5
    assert result['routes'] == original['routes']
    assert result['branches'][0]['weekly_days_off'] == [6]
    assert result['branches'][1]['weekly_days_off'] == []
    assert 'calendar_exceptions' not in result
    result['branches'][0]['calendar_exceptions'][0]['working'] = True
    assert result['branches'][1]['calendar_exceptions'][0]['working'] is False
