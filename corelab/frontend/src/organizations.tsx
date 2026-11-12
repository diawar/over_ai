import { useEffect, useState, type FormEvent } from 'react'
import { platformRequest } from './platform-api'
import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { rememberColor } from './organization-theme'
import './settings.css'

const API = import.meta.env.VITE_API_URL ?? ''
type Organization = { id: number; name: string; short_name: string | null; is_active: boolean; onboarding_required: boolean }
export function OrganizationsPage() {
  const [items, setItems] = useState<Organization[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<Partial<Organization> | null>(null)
  const [message, setMessage] = useState('')
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return
    const form = new FormData(event.currentTarget)
    const body = editing.id ? { name: form.get('name'), short_name: form.get('short_name'), is_active: form.has('is_active') } : { name: form.get('name'), username: form.get('username'), password: form.get('password') }
    setBusy(editing.id ?? 0); setError(''); setMessage('')
    try { await platformRequest(editing.id ? `/organizations/${editing.id}` : '/organizations', editing.id ? 'PATCH' : 'POST', body); setItems((await platformRequest('/organizations')).items); setEditing(null); setMessage('Организация сохранена.') }
    catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  useEffect(() => {
    fetch(`${API}/api/v1/admin/platform/organizations`, { credentials: 'include' }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? 'Доступ только для администратора CoreLab.' : 'Не удалось загрузить организации.')
      setItems((await response.json()).items); setLoaded(true)
    }).catch(e => setError(e.message))
  }, [])
  async function enter(organization: Organization) {
    setBusy(organization.id); setError('')
    const previous = sessionStorage.getItem('corelab_session')
    try {
      const csrf = decodeURIComponent(document.cookie.split('; ').find(v => v.startsWith('corelab_csrf='))?.slice(13) ?? '')
      const response = await fetch(`${API}/api/v1/admin/platform/organization-context`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ organization_id: organization.id }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Не удалось открыть организацию.')
      sessionStorage.setItem('corelab_session', JSON.stringify({ ...JSON.parse(previous ?? '{}'), organization_context: result.organization_context }))
      const me = await fetch(`${API}/api/v1/admin/auth/me`, { credentials: 'include' })
      if (!me.ok) throw new Error('Не удалось проверить доступ к организации.')
      const session = await me.json()
      sessionStorage.setItem('corelab_session', JSON.stringify({ ...session, organization_context: result.organization_context }))
      rememberColor(session.organization.id, session.organization.primary_color)
      window.location.assign(session.onboarding_required ? '/admin/setup' : '/admin/catalog')
    } catch (e) {
      if (previous) sessionStorage.setItem('corelab_session', previous); else sessionStorage.removeItem('corelab_session')
      setError((e as Error).message); setBusy(null)
    }
  }
  const visible = items.filter(org => `${org.name} ${org.short_name ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  return <div className="settings-page"><div className="catalog-heading"><div><p className="catalog-kicker">CORELAB</p><h1>Организации</h1><p>Откройте компанию с правами главного администратора. Действия записываются от вашего имени.</p></div><button className="catalog-button button-cta" onClick={() => { setEditing({ is_active: true }); setError('') }}><AppIcon name="plus" />Добавить организацию</button></div>
    {message && <p role="status">{message}</p>}
    {editing && <section className="settings-card"><form key={editing.id ?? 'new'} className="settings-user-form" onSubmit={save}><h2>{editing.id ? 'Изменить организацию' : 'Новая организация'}</h2><fieldset disabled={busy !== null}>
      <label>Название организации *<input name="name" required maxLength={200} defaultValue={editing.name} /></label>
      {editing.id ? <><label>Короткое название<input name="short_name" maxLength={100} defaultValue={editing.short_name ?? ''} /></label><label className="operations-checkbox"><input name="is_active" type="checkbox" defaultChecked={editing.is_active} />Доступ организации разрешён</label><p className="settings-help">Отключение закрывает доступ сотрудников и клиентов мини-приложения. Данные сохраняются.</p></> : <><label>Логин главного админа *<input name="username" required minLength={3} maxLength={80} pattern="[a-zA-Z0-9._-]+" /></label><label>Временный пароль *<input name="password" type="password" autoComplete="new-password" required minLength={8} pattern={String.raw`.*[\p{P}\p{S}].*`} title="Минимум 8 символов и хотя бы один спецсимвол" maxLength={256} /></label><p>При первом входе главный админ сменит пароль и заполнит обязательные настройки.</p></>}
      <div className="settings-inline-actions"><button className="catalog-button button-cta"><AppIcon name="save" />Сохранить организацию</button><button type="button" className="catalog-button" onClick={() => setEditing(null)}><AppIcon name="x" />Отмена</button></div>
    </fieldset></form></section>}
    <section className="settings-card"><label>Поиск организации<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Название компании" /></label>
      {error && <p role="alert" className="settings-message error">{error}</p>}
      {!loaded && !error && <p role="status">Загрузка организаций…</p>}
      {loaded && !visible.length && <p>Организации не найдены.</p>}
      <div className="settings-users-list">{visible.map(org => <div key={org.id} className="settings-user-row"><div><strong>{org.name}</strong><small>{org.short_name}</small><small>{org.is_active ? 'Доступ разрешён' : 'Доступ заблокирован'}{org.onboarding_required ? ' · Первоначальная настройка' : ''}</small></div><div className="settings-inline-actions"><button className="catalog-button button-cta" disabled={busy !== null} onClick={() => void enter(org)}><AppIcon name="arrow-right" />{busy === org.id ? 'Открываем…' : 'Войти в организацию'}</button><button className="catalog-button" disabled={busy !== null} onClick={() => { setEditing(org); setError('') }}><AppIcon name="pencil" />Изменить</button></div></div>)}</div>
    </section></div>
}
