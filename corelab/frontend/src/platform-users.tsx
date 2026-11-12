import { useEffect, useState, type FormEvent } from 'react'
import { AppIcon } from './icons'
import { platformRequest } from './platform-api'
import { roleLabel } from './roles'
import './settings.css'

type Profile = { id: number; username: string; role: string; is_active: boolean; organization_id: number; organization_name: string; must_change_password: boolean }
type Organization = { id: number; name: string }
export function PlatformUsersPage() {
  const [users, setUsers] = useState<Profile[]>([])
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [query, setQuery] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [editing, setEditing] = useState<Partial<Profile> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function refresh() {
    const [profiles, orgs] = await Promise.all([platformRequest('/users'), platformRequest('/organizations')])
    setUsers(profiles.items); setOrganizations(orgs.items)
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)) }, [])
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return
    const form = new FormData(event.currentTarget)
    const body = { username: form.get('username'), role: form.get('role'), is_active: form.has('is_active'),
      password: form.get('password') || null, ...(!editing.id ? { organization_id: Number(form.get('organization_id')) } : {}) }
    setBusy(true); setError(''); setMessage('')
    try { await platformRequest(editing.id ? `/users/${editing.id}` : '/users', editing.id ? 'PATCH' : 'POST', body); setEditing(null); await refresh(); setMessage('Пользователь сохранён.') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const visible = users.filter(user => (!organizationId || user.organization_id === Number(organizationId)) && `${user.username} ${user.organization_name} ${roleLabel(user.role)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <div className="settings-page"><div className="catalog-heading"><div><p className="catalog-kicker">CORELAB</p><h1>Пользователи</h1><p>Учётные записи всех организаций и права доступа.</p></div><button className="catalog-button button-cta" onClick={() => { setEditing({ role: 'admin', is_active: true }); setError('') }}><AppIcon name="user-plus" />Добавить пользователя</button></div>
    {error && <p role="alert" className="settings-message error">{error}</p>}{message && <p role="status">{message}</p>}
    {editing && <section className="settings-card"><form key={editing.id ?? 'new'} className="settings-user-form" onSubmit={save}><h2>{editing.id ? 'Изменить пользователя' : 'Новый пользователь'}</h2><fieldset disabled={busy}>
      <label>Логин *<input name="username" required minLength={3} maxLength={80} pattern="[a-zA-Z0-9._-]+" defaultValue={editing.username} /></label>
      {!editing.id ? <label>Организация *<select name="organization_id" required defaultValue=""><option value="" disabled>Выберите организацию</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label> : <p>{editing.organization_name}</p>}
      <label>Роль *<select name="role" defaultValue={editing.role}>{['admin', 'chief_admin', 'platform_admin'].map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}</select></label>
      <label>{editing.id ? 'Новый временный пароль (необязательно)' : 'Временный пароль *'}<input name="password" type="password" required={!editing.id} minLength={8} pattern={String.raw`.*[\p{P}\p{S}].*`} title="Минимум 8 символов и хотя бы один спецсимвол" maxLength={256} autoComplete="new-password" /></label>
      <p className="settings-help">После назначения временного пароля пользователь сменит его при входе.</p>
      <label className="operations-checkbox"><input name="is_active" type="checkbox" defaultChecked={editing.is_active} />Доступ разрешён</label>
      <div className="settings-inline-actions"><button className="catalog-button button-cta"><AppIcon name="save" />Сохранить пользователя</button><button className="catalog-button" type="button" onClick={() => setEditing(null)}><AppIcon name="x" />Отмена</button></div>
    </fieldset></form></section>}
    <section className="settings-card"><div className="operations-grid"><label>Поиск пользователя<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Логин, организация или роль" /></label><label>Организация<select value={organizationId} onChange={e => setOrganizationId(e.target.value)}><option value="">Все организации</option>{organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label></div>
      <div className="settings-users-list">{visible.map(user => <div key={user.id} className="settings-user-row"><div><strong>{user.username}</strong><small>{roleLabel(user.role)} · {user.organization_name}</small><small>{user.is_active ? 'Доступ разрешён' : 'Доступ заблокирован'}{user.must_change_password ? ' · Нужна смена пароля' : ''}</small></div><button className="catalog-button" disabled={busy} onClick={() => { setEditing(user); setError('') }}><AppIcon name="pencil" />Изменить</button></div>)}</div>{!visible.length && <p>Пользователи не найдены.</p>}
    </section></div>
}
