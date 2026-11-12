import time

from sqlalchemy import select

from app import db
from app.models import AdminSession, User
from app.security import hash_password, issue_session, session_hash
from test_auth import client


def login(client):
    response = client.post('/api/v1/admin/auth/login', json={'username': 'test-admin', 'password': 'test-password'})
    assert response.status_code == 200
    return response.cookies['corelab_session'], response.json()['csrf_token']


def replay(client, token):
    return client.get('/api/v1/admin/auth/me', headers={'Cookie': 'corelab_session=' + token})


def test_logout_revokes_copied_token_but_preserves_other_login(client):
    first, _ = login(client)
    second, csrf = login(client)
    assert first != second
    assert client.post('/api/v1/admin/auth/logout', headers={'X-CSRF-Token': csrf}).status_code == 200
    assert replay(client, second).status_code == 401
    assert replay(client, first).status_code == 200


def test_change_password_revokes_all_previous_tokens_and_rotates_current_cookie(client):
    first, _ = login(client)
    second, csrf = login(client)
    changed = client.post('/api/v1/admin/auth/change-password', headers={'X-CSRF-Token': csrf},
                          json={'current_password': 'test-password', 'new_password': 'new-password!123'})
    assert changed.status_code == 200
    assert changed.cookies['corelab_session'] not in (first, second)
    assert replay(client, first).status_code == 401
    assert replay(client, second).status_code == 401
    assert client.get('/api/v1/admin/auth/me').status_code == 200
    assert client.post('/api/v1/admin/auth/login', json={'username': 'test-admin', 'password': 'new-password!123'}).status_code == 200


def test_password_reset_invalidates_existing_sessions_without_endpoint_specific_logic(client):
    token, _ = login(client)
    with db.SessionLocal() as session:
        user = session.scalar(select(User).where(User.username == 'test-admin'))
        user.password_hash = hash_password('reset-password!123')
        session.commit()
    assert replay(client, token).status_code == 401


def test_unregistered_and_expired_sessions_fail_closed(client):
    token, _ = login(client)
    with db.SessionLocal() as session:
        row = session.get(AdminSession, session_hash(token))
        user_id = row.user_id
        row.expires_at = int(time.time()) - 1
        session.commit()
    assert replay(client, token).status_code == 401
    assert replay(client, issue_session(user_id)).status_code == 401


def test_logout_is_available_when_password_change_is_required(client):
    _, csrf = login(client)
    with db.SessionLocal() as session:
        user = session.scalar(select(User).where(User.username == 'test-admin'))
        user.must_change_password = True
        session.commit()
    assert client.post('/api/v1/admin/auth/logout', headers={'X-CSRF-Token': csrf}).status_code == 200
