import { useEffect, useState, type FormEvent } from 'react'
import { adminFetch as fetch } from './admin-fetch'
import { OrganizationOperations } from './organization-operations'
import { AppIcon } from './icons'
import './settings.css'
import './onboarding.css'

const API = import.meta.env.VITE_API_URL ?? ''
async function request(path: string, body?: unknown) {
  const csrf = decodeURIComponent(document.cookie.split('; ').find(v => v.startsWith('corelab_csrf='))?.slice(13) ?? '')
  const response = await fetch(`${API}/api/v1/admin/${path}`, { method: body === undefined ? 'GET' : path.endsWith('/complete') ? 'POST' : 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.missing?.join('; ') || 'Проверьте обязательные поля.')
  return data
}
type Setup = { required: boolean; name: string; short_name: string; username: string; mini_app_enabled: boolean; logo_url: string | null; missing: string[] }
export function OnboardingPage() {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function refresh() { const data = await request('onboarding'); setSetup(data); return data }
  useEffect(() => { void refresh().catch(e => setError(e.message)) }, [])
  async function save(event: FormEvent) {
    event.preventDefault(); if (!setup) return
    setBusy(true); setError(''); setMessage('')
    try { await request('onboarding/profile', { name: setup.name, short_name: setup.short_name, mini_app_enabled: setup.mini_app_enabled }); setDirty(false); await refresh(); setMessage('Данные организации сохранены.') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function upload(file?: File) {
    if (!file) return
    setBusy(true); setError('')
    try {
      if (file.size > 2500000) throw new Error('Размер логотипа — не более 2,5 МБ.')
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл.')); reader.readAsDataURL(file) })
      const data = await request('settings/organization/logo', { image_base64: base64 })
      setSetup(previous => previous && ({ ...previous, logo_url: data.logo_url, missing: previous.missing.filter(value => value !== 'Логотип организации') })); setMessage('Логотип сохранён.')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function complete() {
    setBusy(true); setError('')
    try { await request('onboarding/complete', {}); const current = await request('auth/me'); const previous = JSON.parse(sessionStorage.getItem('corelab_session') ?? '{}'); sessionStorage.setItem('corelab_session', JSON.stringify({ ...previous, ...current })); window.location.assign('/admin/catalog') }
    catch (e) { setError((e as Error).message); await refresh().catch(() => undefined) } finally { setBusy(false) }
  }
  const change = (patch: Partial<Setup>) => { setSetup(value => value && ({ ...value, ...patch })); setDirty(true) }
  return <div className="settings-page onboarding-page"><div className="catalog-heading"><div><p className="catalog-kicker">ДОБРО ПОЖАЛОВАТЬ В E2E</p><h1>Настройка организации</h1><p>Заполните данные компании и добавьте логотип. Обязательные поля отмечены *.</p></div><span className="onboarding-stage"><AppIcon name="settings" />Первоначальная настройка</span></div>
    {error && <p role="alert" className="settings-message error">{error}</p>}{message && <p role="status">{message}</p>}
    {!setup ? <p>Загрузка…</p> : <>
      <div className="onboarding-profile-grid">
      <section className="settings-card onboarding-profile"><div className="onboarding-section-heading"><span>01</span><div><h2>Организация и главный админ</h2><p>Основные данные вашего рабочего пространства.</p></div></div><form onSubmit={save}><fieldset disabled={busy}>
        <div className="onboarding-fields">
        <label>Название организации *<input required maxLength={200} value={setup.name} onChange={e => change({ name: e.target.value })} /></label>
        <label>Короткое название для приложения *<input required maxLength={100} placeholder="Название для покупателей" value={setup.short_name} onChange={e => change({ short_name: e.target.value })} /></label>
        <label>Главный администратор *<input readOnly value={setup.username} /><small>Учётная запись, созданная при регистрации.</small></label>
        </div>
        <div className="onboarding-mini-option"><label className="onboarding-checkbox"><input type="checkbox" checked={setup.mini_app_enabled} onChange={e => change({ mini_app_enabled: e.target.checked })} /><span>Включить мини-приложение</span></label>
        <p className="settings-help">При включении обязательны филиал получения, его город, адрес, календарь и срок сборки. Подбор станет доступен после загрузки прайс-листа и сопоставления товаров.</p></div>
        <div className="onboarding-actions"><button className="catalog-button button-cta" disabled={!dirty}><AppIcon name="save" />{busy ? 'Сохраняем…' : 'Сохранить данные организации'}</button></div>
      </fieldset></form></section>
      <section className="settings-card onboarding-logo"><div className="onboarding-section-heading"><span>02</span><div><h2>Логотип организации *</h2><p>Для оформления вашей компании.</p></div></div><div className="onboarding-logo-preview">{setup.logo_url ? <img src={`${API}${setup.logo_url}`} alt="Логотип организации" width={96} height={96} /> : <><AppIcon name="upload" /><span>Добавьте логотип компании</span></>}</div><p className="settings-help">PNG, JPEG или WebP<br />512 × 512 пикселей, до 2,5 МБ.</p><label className={`onboarding-upload${busy ? ' is-disabled' : ''}`}><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /><span><AppIcon name="upload" />Загрузить логотип *</span></label></section>
      </div>
      {setup.mini_app_enabled && <OrganizationOperations editable requiredFields onSaved={() => { if (!dirty) void refresh().catch(e => setError(e.message)) }} />}
      <section className="settings-card onboarding-readiness"><div><h2>Готовность к работе</h2>{setup.missing.length > 0 ? <><p>Для открытия рабочей панели осталось заполнить:</p><ul>{setup.missing.map(field => <li key={field}>{field} *</li>)}</ul></> : <p>Обязательные настройки заполнены. Можно начать работу.</p>}
        {dirty && <p>Сначала сохраните данные организации.</p>}</div><button className="catalog-button button-cta" disabled={busy || dirty || setup.missing.length > 0} onClick={() => void complete()}><AppIcon name="check" />Завершить настройку</button>
      </section>
    </>}
  </div>
}
