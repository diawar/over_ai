from io import BytesIO
import base64
from PIL import Image
from sqlalchemy import select
from app import db, main
from app.models import Organization, User, AuditLog, CatalogSource, Product
from app.security import hash_password, verify_password, issue_organization_context
from test_auth import client
import pytest
from fastapi import HTTPException


def login(client, username="test-admin", password="test-password"):
    result = client.post('/api/v1/admin/auth/login', json={"username":username,"password":password})
    assert result.status_code == 200, result.text
    return {"X-CSRF-Token": client.cookies.get("corelab_csrf")}


def platform_fixture():
    with db.SessionLocal() as session:
        org = Organization(name="Company Two"); session.add(org); session.flush()
        root = User(organization_id=1, username="platform-owner", password_hash=hash_password("root-password-long"), role="platform_admin")
        chief = User(organization_id=org.id, username="second-chief", password_hash=hash_password("second-password-long"), role="chief_admin")
        session.add_all([root, chief]); session.flush()
        for org_id in [1, org.id]:
            source = CatalogSource(organization_id=org_id, code="corelab", name="Core", endpoint="local://catalog")
            session.add(source); session.flush()
            session.add(Product(organization_id=org_id, source_id=source.id, sku=str(org_id), name=f"Product {org_id}", raw_data={}))
        session.commit()
        return root.id, org.id, chief.id


def test_platform_context_is_scoped_audited_bound_to_actor_and_does_not_move_account(client):
    root_id, org_id, _ = platform_fixture()
    headers = login(client, "platform-owner", "root-password-long")
    assert len(client.get('/api/v1/admin/platform/organizations').json()['items']) == 2
    assert client.post('/api/v1/admin/platform/organization-context', json={"organization_id":org_id}).status_code == 403
    entered = client.post('/api/v1/admin/platform/organization-context', json={"organization_id":org_id}, headers=headers)
    assert entered.status_code == 200, entered.text
    context = {**headers, "X-CoreLab-Organization-Context":entered.json()['organization_context']}
    me = client.get('/api/v1/admin/auth/me', headers=context).json()
    assert me['role'] == 'platform_admin' and me['organization']['id'] == org_id
    assert client.get('/api/v1/admin/auth/me').json()['organization']['id'] == 1
    assert [p['name'] for p in client.get('/api/v1/admin/catalog', headers=context).json()['items']] == [f'Product {org_id}']
    assert [p['name'] for p in client.get('/api/v1/admin/catalog').json()['items']] == ['Product 1']
    saved = client.put('/api/v1/admin/settings/organization/short-name', json={"short_name":"Changed"}, headers=context)
    assert saved.status_code == 200, saved.text
    events = client.get('/api/v1/admin/logs', headers=context).json()['items']
    assert any(event['author']=='platform-owner' for event in events)
    with db.SessionLocal() as session:
        assert session.get(User,root_id).organization_id == 1
        assert session.get(Organization,org_id).short_name == 'Changed'
        assert session.get(Organization,1).short_name is None
        event = session.scalar(select(AuditLog).where(AuditLog.action=='settings.platform_organization_entered'))
        assert event.user_id == root_id and event.organization_id == org_id
    assert client.get('/api/v1/admin/auth/me', headers={"X-CoreLab-Organization-Context":issue_organization_context(root_id+100, org_id)}).status_code == 403
    assert client.get('/api/v1/admin/auth/me', headers={"X-CoreLab-Organization-Context":"tampered"}).status_code == 403


def test_chief_cannot_enter_other_company_or_grant_platform_role(client):
    root_id, org_id, _ = platform_fixture()
    headers = login(client)
    assert client.get('/api/v1/admin/platform/organizations').status_code == 403
    assert client.get('/api/v1/admin/platform/users').status_code == 403
    assert client.post('/api/v1/admin/platform/organization-context', json={"organization_id":org_id}, headers=headers).status_code == 403
    token = issue_organization_context(root_id,org_id)
    assert client.get('/api/v1/admin/catalog',headers={"X-CoreLab-Organization-Context":token}).status_code == 403
    result=client.post('/api/v1/admin/settings/users', headers=headers,json={"username":"hacker","password":"a-long-password","role":"platform_admin"})
    assert result.status_code == 422


def test_platform_user_management_revocation_and_last_chief_protection(client):
    root_id, org_id, chief_id = platform_fixture()
    headers = login(client,"platform-owner","root-password-long")
    own={"username":"platform-owner","role":"admin","is_active":True}
    assert client.patch(f'/api/v1/admin/platform/users/{root_id}',json=own,headers=headers).status_code==409
    assert client.patch(f'/api/v1/admin/platform/users/{chief_id}',json={"username":"second-chief","role":"admin","is_active":False},headers=headers).status_code==409
    body={"organization_id":org_id,"username":"new-member","password":"temporary-password","role":"admin","is_active":True}
    created=client.post('/api/v1/admin/platform/users',json=body,headers=headers)
    assert created.status_code==201,created.text
    assert created.json()['must_change_password']
    disabled=client.patch(f"/api/v1/admin/platform/users/{created.json()['id']}",json={"username":"new-member","role":"admin","is_active":False},headers=headers)
    assert disabled.status_code==200
    assert client.post('/api/v1/admin/auth/login',json={"username":"new-member","password":"temporary-password"}).status_code==401
    # Role changes take effect on existing sessions and organization contexts.
    entered=client.post('/api/v1/admin/platform/organization-context',json={"organization_id":org_id},headers=headers).json()
    with db.SessionLocal() as session:
        session.get(User,root_id).role='admin';session.commit()
    assert client.get('/api/v1/admin/platform/users').status_code==403
    assert client.get('/api/v1/admin/catalog',headers={"X-CoreLab-Organization-Context":entered['organization_context']}).status_code==403


def test_platform_creation_blocking_and_password_change_in_context(client):
    root_id, org_id, _=platform_fixture()
    headers=login(client,'platform-owner','root-password-long')
    response=client.post('/api/v1/admin/platform/organizations',json={"name":"Created by platform","username":"created-chief","password":"temporary-password"},headers=headers)
    assert response.status_code==201,response.text
    assert response.json()['onboarding_required']
    context=client.post('/api/v1/admin/platform/organization-context',json={"organization_id":org_id},headers=headers).json()['organization_context']
    changed=client.post('/api/v1/admin/auth/change-password',headers={**headers,"X-CoreLab-Organization-Context":context},json={"current_password":"root-password-long","new_password":"root-password-replaced"})
    assert changed.status_code==200,changed.text
    with db.SessionLocal() as session:
        assert verify_password(session.get(User,root_id).password_hash,'root-password-replaced')
    # Password change rotates both session and CSRF cookies. Reusing the old
    # CSRF header must fail; subsequent UI operations read the updated cookie.
    assert client.patch(f'/api/v1/admin/platform/organizations/{org_id}',json={"name":"Company Two","short_name":"Two","is_active":False},headers=headers).status_code==403
    headers={"X-CSRF-Token":client.cookies.get('corelab_csrf')}
    blocked=client.patch(f'/api/v1/admin/platform/organizations/{org_id}',json={"name":"Company Two","short_name":"Two","is_active":False},headers=headers)
    assert blocked.status_code==200
    assert client.get('/api/v1/admin/settings/organization',headers={"X-CoreLab-Organization-Context":context}).status_code==200
    assert client.post('/api/v1/admin/auth/login',json={"username":"second-chief","password":"second-password-long"}).status_code==403


def logo():
    buffer=BytesIO();Image.new('RGB',(512,512),'orange').save(buffer,format='PNG')
    return {"image_base64":base64.b64encode(buffer.getvalue()).decode()}


def register(client):
    result=client.post('/api/v1/admin/auth/register',json={"name":"New Company","username":"new-chief","password":"registered-password"})
    assert result.status_code==201,result.text
    assert result.json()['role']=='chief_admin' and result.json()['onboarding_required']
    assert result.json()['organization']['primary_color']=='#ff416c'
    return result.json()['organization']['id'],{"X-CSRF-Token":client.cookies.get('corelab_csrf')}


def test_registration_requires_setup_and_rejects_role_injection_duplicates_and_weak_password(client):
    assert client.post('/api/v1/admin/auth/register',json={"name":"New","username":"member","password":"short"}).status_code==422
    assert client.post('/api/v1/admin/auth/register',json={"name":"New","username":"member","password":"registered-password","role":"platform_admin"}).status_code==422
    org_id,headers=register(client)
    assert client.get('/api/v1/admin/catalog').status_code==403
    assert client.post('/api/v1/admin/onboarding/complete',json={},headers=headers).status_code==422
    assert client.post('/api/v1/admin/onboarding/complete',json={}).status_code==403
    assert client.put('/api/v1/admin/onboarding/profile',json={"name":"New Company","short_name":"New","mini_app_enabled":False},headers=headers).status_code==200
    assert client.put('/api/v1/admin/settings/organization/logo',json=logo(),headers=headers).status_code==200
    assert client.post('/api/v1/admin/onboarding/complete',json={},headers=headers).status_code==200
    assert client.get('/api/v1/admin/auth/me').json()['onboarding_required'] is False
    assert client.get('/api/v1/admin/catalog').status_code==200
    assert client.post('/api/v1/admin/auth/register',json={"name":"New Company","username":"other-user","password":"registered-password"}).status_code==409
    with db.SessionLocal() as session:
        assert session.get(Organization,1).onboarding_required is False
        assert session.get(Organization,org_id).mini_app_enabled is False
        assert len(list(session.scalars(select(Organization))))==2


def test_mini_app_requires_saved_branches_addresses_and_calendars(client):
    org_id,headers=register(client)
    client.put('/api/v1/admin/onboarding/profile',json={"name":"New Company","short_name":"New","mini_app_enabled":True},headers=headers)
    client.put('/api/v1/admin/settings/organization/logo',json=logo(),headers=headers)
    assert client.post('/api/v1/admin/onboarding/complete',json={},headers=headers).status_code==422
    body={"assembly_workdays":2,"branches":[{"code":"HOME","name":"Main","city":"Караганда","address":"","active":True,"kind":"branch","weekly_days_off":[5,6]}],"routes":[]}
    saved=client.put('/api/v1/admin/settings/organization/operations',json=body,headers=headers)
    assert saved.status_code==200,saved.text
    assert client.post('/api/v1/admin/onboarding/complete',json={},headers=headers).status_code==422
    body=saved.json();body['branches'][0]['address']='Тестовая, 1'
    client.put('/api/v1/admin/settings/organization/operations',json=body,headers=headers)
    assert client.post('/api/v1/admin/onboarding/complete',json={},headers=headers).status_code==200
    with db.SessionLocal() as session:
        assert session.get(Organization,org_id).operations['assembly_workdays']==2


def test_registration_preserves_password_spaces_and_blocked_company_cannot_use_dialogue(client, monkeypatch):
    from app.main import RegistrationInput
    from app.platform_admin import PlatformUserCreate
    from app import dialogue_views
    password='  meaningful-password  '
    assert RegistrationInput(name=' Name ',username=' user ',password=password).password==password
    assert PlatformUserCreate(organization_id=1,username=' user ',role='admin',password=password).password==password
    with db.SessionLocal() as session:
        session.get(Organization,1).is_active=False;session.commit()
        monkeypatch.setattr(dialogue_views,'active_provider',lambda *args: pytest.fail('Blocked company must not reach AI provider'))
        with pytest.raises(HTTPException) as rejected:
            dialogue_views._provider(session,1)
        assert rejected.value.status_code==404
