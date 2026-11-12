import { canManageOrganization, roleLabel } from './roles'
import { adminFetch as fetch } from './admin-fetch'
import { FormEvent, useEffect, useRef, useState } from 'react'
import { AppIcon } from './icons'
import { E2E_COLOR, rememberColor } from './organization-theme'
import './settings.css'
import { MiniAppSettings } from './mini-app-settings'
import { OrganizationOperations } from './organization-operations'
import { ProductLinksSettings } from './product-links-settings'

const API = import.meta.env.VITE_API_URL ?? ''
const DEFAULT_WELCOME_HEADLINE = ['Ваши задачи.', 'Ваш характер.', 'Ваш компьютер.']
type ProviderState = { provider: string; configured: boolean; model_id: string }
type Organization = { id: number; name: string; short_name?: string | null; role: 'chief_admin' | 'admin' | 'platform_admin'; primary_color?: string; logo_url?: string | null; logo_palette?: string[]; welcome_headline?: string[] }
type Profile = { id: number; username: string; role: 'chief_admin' | 'admin' | 'platform_admin'; must_change_password: boolean }

async function api(path: string, method = 'GET', body?: unknown) {
  const csrf = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
  const response = await fetch(`${API}/api/v1/admin/settings${path}`, {
    method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Не удалось выполнить операцию')
  return data
}

export function SettingsPage() {
  const [provider, setProvider] = useState('openai')
  const [activeProvider, setActiveProvider] = useState('openai')
  const [aiEnabled, setAiEnabled] = useState(true)
  const providerName = provider === 'openrouter' ? 'OpenRouter' : provider === 'kimi' ? 'Kimi' : 'OpenAI'
  const [state, setState] = useState<ProviderState | null>(null)
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('gpt-5.5')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function refresh(selected = provider) {
    const [result, org] = await Promise.all([api(`/${selected}`), api('/organization')]) as [ProviderState, Organization]
    setState(result); setModelId(result.model_id); setOrganization(org)
    return { result, org }
  }
  useEffect(() => {
    api('/ai/active').then(async result => {
      const selected = ['openai', 'kimi', 'openrouter'].includes(result.provider) ? result.provider : 'openai'
      setProvider(selected); setActiveProvider(selected); setAiEnabled(result.enabled !== false); await refresh(selected)
    }).catch(e => setError(e.message))
  }, [])

  async function changeProvider(selected: string) {
    setBusy(true); setError(''); setMessage(''); setApiKey(''); setState(null)
    setProvider(selected)
    try {
      const { result, org } = await refresh(selected)
      if (canManageOrganization(org.role) && result.configured && selected !== activeProvider) {
        await api(`/ai/${selected}/activate`, 'POST', {})
        setActiveProvider(selected)
        setMessage(`Выбран ${result.provider}. Настройка сохранена для каталога и мини-приложения.`)
      } else if (!result.configured) {
        setMessage('Чтобы использовать этого провайдера, добавьте и сохраните его API-ключ. Пока действует прежнее подключение.')
      }
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить настройки') }
    finally { setBusy(false) }
  }

  async function changeAiMode(enabled: boolean) {
    setBusy(true); setError(''); setMessage('')
    try {
      await api('/ai/mode', 'PUT', { enabled })
      setAiEnabled(enabled)
      setMessage(enabled ? 'AI включён.' : 'AI выключен для каталога и мини-приложения.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось изменить режим AI') }
    finally { setBusy(false) }
  }

  async function activateProvider() {
    setBusy(true); setError(''); setMessage('')
    try {
      await api(`/ai/${provider}/activate`, 'POST', {})
      setActiveProvider(provider); setMessage(`Для каталога и мини-приложения выбран ${providerName}.`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось выбрать провайдер') }
    finally { setBusy(false) }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const result = await api(`/${provider}`, 'PUT', { api_key: apiKey, model_id: modelId }) as ProviderState
      setState(result); setActiveProvider(provider); setApiKey(''); setMessage('Ключ сохранён в зашифрованном виде.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить ключ') }
    finally { setBusy(false) }
  }

  async function testConnection() {
    setBusy(true); setError(''); setMessage('')
    try { await api(`/${provider}/test`, 'POST', {}); setMessage(`Подключение работает. Модель ${state?.model_id} доступна.`) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось проверить подключение') }
    finally { setBusy(false) }
  }

  async function removeKey() {
    setBusy(true); setError(''); setMessage('')
    try {
      await api(`/${provider}`, 'DELETE'); await refresh()
      const active = await api('/ai/active'); setActiveProvider(active.provider)
      setMessage('Ключ удалён.')
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось удалить ключ') }
    finally { setBusy(false) }
  }

  return <section className="settings-page">
    <div className="catalog-heading"><div><p className="catalog-kicker">СИСТЕМА</p><h1>Настройки</h1><p>Организация, оформление, логистика и параметры приложения</p></div></div>
    <OrganizationUsers />
    <OrganizationOperations editable={canManageOrganization(organization?.role)} />
    <MiniAppSettings />
    <ProductLinksSettings editable={canManageOrganization(organization?.role)} />
    <section className="settings-card" aria-labelledby="openai-settings-title">
      <div className="settings-card-heading"><div><h2 id="openai-settings-title">AI для мини приложения</h2><p>Для характеристик AI ищет официальные страницы; в мини-приложении отвечает клиенту.</p></div>
        <span className={`settings-status ${aiEnabled && state?.configured ? 'connected' : ''}`}>{aiEnabled ? (state?.configured ? 'AI включён' : 'Ключ не добавлен') : 'AI выключен'}</span></div>
      <p className="settings-help">Один выбранный провайдер используется для исследования категорий, загрузки характеристик товаров и диалога мини-приложения.</p>
      <label>Режим AI<select aria-label="Режим AI" value={aiEnabled ? 'on' : 'off'} disabled={busy || !canManageOrganization(organization?.role)} onChange={event => void changeAiMode(event.target.value === 'on')}><option value="on">Включён</option><option value="off">Выключен</option></select></label>
      <p className="settings-help">При выключении исследование категорий, загрузка характеристик и диалог мини-приложения не обращаются к AI. Ключи и выбранный провайдер сохраняются.</p>
      <label>Провайдер AI<select aria-label="Провайдер AI" value={provider} disabled={busy || !organization} onChange={event => void changeProvider(event.target.value)}><option value="openai">OpenAI</option><option value="kimi">Kimi (Moonshot AI)</option><option value="openrouter">OpenRouter</option></select></label>
      <p className="settings-help">Для всех функций используется: {activeProvider === 'openrouter' ? 'OpenRouter' : activeProvider === 'kimi' ? 'Kimi' : 'OpenAI'}. Выбор провайдера с сохранённым ключом применяется сразу. Для нового подключения сначала сохраните ключ.</p>
      {canManageOrganization(organization?.role) ? <form onSubmit={save}>
        <label>API-ключ<input aria-label={`API-ключ ${providerName}`} type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={state?.configured ? 'Введите новый ключ, чтобы заменить сохранённый' : 'sk-…'} required /></label>
        <label>Модель<input aria-label={`Модель ${providerName}`} value={modelId} onChange={event => setModelId(event.target.value)} placeholder={provider === 'openrouter' ? 'moonshotai/kimi-k2.5' : provider === 'kimi' ? 'kimi-k2.5' : 'gpt-5.5'} required /></label>
        {provider === 'kimi' && <p className="settings-help">Используйте API-ключ платформы Moonshot / Kimi и ID доступной модели, например kimi-k2.5. <a href="https://platform.kimi.ai/console/api-keys" target="_blank" rel="noreferrer">Получить API-ключ</a></p>}
        {provider === 'openrouter' && <p className="settings-help">Укажите ключ OpenRouter и точный ID модели из <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">каталога моделей</a>, например moonshotai/kimi-k2.5. Бесплатные варианты и лимиты могут меняться. Для исследования характеристик используется веб-поиск OpenRouter, который может тарифицироваться отдельно.</p>}
        <p className="settings-help">Ключ хранится зашифрованным на сервере. Его значение не показывается и не попадает в журнал. Запросы через {providerName} могут расходовать средства аккаунта.</p>
        {error && <p className="settings-message error" role="alert">{error}</p>}
        {message && <p className="settings-message" role="status">{message}</p>}
        <div className="property-actions"><button className="catalog-button button-cta" disabled={busy || !apiKey.trim() || !modelId.trim()}><AppIcon name="save" />{busy ? 'Сохраняем…' : 'Сохранить ключ'}</button>
          <button type="button" className="catalog-button button-cta" disabled={busy || !state?.configured} onClick={testConnection}><AppIcon name="activity" />Проверить подключение</button>
          {state?.configured && activeProvider !== provider && <button type="button" className="catalog-button button-cta" disabled={busy} onClick={activateProvider}><AppIcon name="check" />Использовать {providerName}</button>}
          <button type="button" className="catalog-button settings-danger" disabled={busy || !state?.configured} onClick={removeKey}><AppIcon name="trash" />Удалить ключ</button></div>
      </form> : <div className="settings-provider-readonly"><p className="settings-help">Ключ {providerName} может изменять только главный админ.</p>{error && <p className="settings-message error" role="alert">{error}</p>}{message && <p className="settings-message" role="status">{message}</p>}</div>}
    </section>
  </section>
}

function OrganizationUsers() {
  const logoInput = useRef<HTMLInputElement>(null)
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [users, setUsers] = useState<Profile[]>([])
  const [editing, setEditing] = useState<Profile | null>(null)
  const [deleting, setDeleting] = useState<Profile | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [primaryColor, setPrimaryColor] = useState('')
  const [shortName, setShortName] = useState('')
  const [welcomeHeadline, setWelcomeHeadline] = useState<string[]>(DEFAULT_WELCOME_HEADLINE)

  async function refresh() {
    const [org, profiles] = await Promise.all([api('/organization'), api('/users')])
    setOrganization(org as Organization)
    rememberColor((org as Organization).id, (org as Organization).primary_color)
    setPrimaryColor((org as Organization).primary_color ?? E2E_COLOR)
    setShortName((org as Organization).short_name ?? '')
    setWelcomeHeadline((org as Organization).welcome_headline ?? DEFAULT_WELCOME_HEADLINE)
    setUsers((profiles as { items: Profile[] }).items)
  }
  useEffect(() => { refresh().catch(reason => setError(reason.message)) }, [])

  function openEditor(profile?: Profile) {
    setEditing(profile ?? { id: 0, username: '', role: 'admin', must_change_password: true })
    setUsername(profile?.username ?? '')
    setPassword('')
    setError(''); setMessage('')
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editing) return
    setBusy(true); setError(''); setMessage('')
    try {
      if (editing.id) await api(`/users/${editing.id}`, 'PATCH', { username: username.trim(), password: password || null })
      else await api('/users', 'POST', { username: username.trim(), password })
      setEditing(null); await refresh()
      setMessage(editing.id ? 'Профиль изменён.' : 'Админ добавлен. При первом входе он сменит пароль.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить профиль') }
    finally { setBusy(false) }
  }
  async function deleteProfile() {
    if (!deleting) return
    setBusy(true); setError(''); setMessage('')
    try {
      await api(`/users/${deleting.id}`, 'DELETE')
      setDeleting(null); await refresh(); setMessage('Профиль удалён.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось удалить профиль') }
    finally { setBusy(false) }
  }

  async function savePrimaryColor() {
    setBusy(true); setError(''); setMessage('')
    try {
      await api('/organization/branding', 'PUT', { primary_color: primaryColor })
      await refresh(); setMessage('Основной цвет сохранён.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить цвет') }
    finally { setBusy(false) }
  }

  async function saveShortName() {
    setBusy(true); setError(''); setMessage('')
    try {
      await api('/organization/short-name', 'PUT', { short_name: shortName.trim() })
      await refresh(); setMessage('Сокращённое название сохранено.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить сокращённое название') }
    finally { setBusy(false) }
  }

  async function saveWelcomeHeadline(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true); setError(''); setMessage('')
    try {
      await api('/organization/welcome', 'PUT', { welcome_headline: welcomeHeadline.map(line => line.trim()) })
      await refresh(); setMessage('Заголовок первого экрана сохранён.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить заголовок') }
    finally { setBusy(false) }
  }

  async function uploadLogo(file?: File) {
    if (!file) return
    setError(''); setMessage('')
    if (file.size > 2_500_000) { setError('Размер файла не должен превышать 2,5 МБ.'); return }
    try {
      const image = await createImageBitmap(file)
      const validSize = image.width === 512 && image.height === 512
      image.close()
      if (!validSize) { setError('Логотип должен быть размером 512 × 512 пикселей.'); return }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('Не удалось прочитать файл логотипа.'))
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Не удалось прочитать файл логотипа.'))
        reader.readAsDataURL(file)
      })
      setBusy(true)
      await api('/organization/logo', 'PUT', { image_base64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
      await refresh(); setMessage('Логотип сохранён.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось загрузить логотип') }
    finally { setBusy(false) }
  }

  async function removeLogo() {
    setBusy(true); setError(''); setMessage('')
    try { await api('/organization/logo', 'DELETE'); await refresh(); setMessage('Логотип удалён.') }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось удалить логотип') }
    finally { setBusy(false) }
  }

  return <section className="settings-card" aria-labelledby="organization-settings-title">
    <div className="settings-card-heading"><div><h2 id="organization-settings-title">Организация</h2><p>{organization?.name ?? 'Загружаем организацию…'}</p></div>
      {organization && <span className="settings-status connected">{roleLabel(organization.role)}</span>}</div>
    <div className="settings-users-section"><div className="settings-users-heading"><h3>Пользователи</h3>{canManageOrganization(organization?.role) && <button className="catalog-button button-cta" type="button" onClick={() => openEditor()}><AppIcon name="user-plus" />Добавить пользователя</button>}</div>
    <div className="settings-users-list">{users.map(profile => <div key={profile.id} className="settings-user-row"><div><strong>{profile.username}</strong><small>{roleLabel(profile.role)}{profile.must_change_password ? ' · Смена пароля при входе' : ''}</small></div>
      {canManageOrganization(organization?.role) && profile.role === 'admin' && <div className="settings-inline-actions"><button className="catalog-button" type="button" onClick={() => openEditor(profile)}><AppIcon name="pencil" />Изменить</button><button className="catalog-button settings-danger" type="button" onClick={() => { setDeleting(profile); setError('') }}><AppIcon name="trash" />Удалить</button></div>}</div>)}</div>
    </div><div className="settings-branding">
      <h3>Оформление организации</h3>
      <p className="settings-help">Сокращённое название, цвет и логотип используются в админке и Mini App этой организации.</p>
      <div className="settings-branding-controls">
        <div className="settings-branding-logo">
          {organization?.logo_url ? <img src={`${API}${organization.logo_url}`} alt="Логотип организации" /> : <div className="settings-branding-placeholder">Логотип не загружен</div>}
          {canManageOrganization(organization?.role) && <><span className="settings-help">Логотип 512 × 512 px</span><input ref={logoInput} hidden aria-label="Логотип организации 512 на 512" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { void uploadLogo(event.target.files?.[0]); event.target.value = '' }} /><button className="catalog-button button-cta" type="button" disabled={busy} onClick={() => logoInput.current?.click()}><AppIcon name="upload" />{organization.logo_url ? 'Заменить логотип' : 'Загрузить логотип'}</button>{organization.logo_url && <button className="catalog-button settings-danger" type="button" disabled={busy} onClick={() => void removeLogo()}><AppIcon name="trash" />Удалить логотип</button>}</>}
        </div>
        <div className="settings-branding-color">
          <p className="settings-help">{!organization?.logo_url ? 'Добавьте логотип, чтобы выбрать основной цвет.' : organization.logo_palette?.length ? 'Палитра из цветов логотипа' : 'В логотипе не найдены непрозрачные цвета. Можно указать HEX-код вручную.'}</p>
          <div className="settings-branding-palette" role="group" aria-label="Палитра цветов логотипа" aria-disabled={!organization?.logo_url}>
            {(organization?.logo_url ? organization.logo_palette ?? [] : []).map(color => <button key={color} type="button" title={color} aria-label={`Выбрать цвет ${color}`} aria-pressed={primaryColor.toUpperCase() === color} disabled={busy || !canManageOrganization(organization?.role)} style={{ backgroundColor: color }} onClick={() => setPrimaryColor(color)} />)}
          </div>
          <label>HEX-код основного цвета<input aria-label="HEX-код основного цвета организации" type="text" inputMode="text" autoCapitalize="characters" maxLength={7} placeholder="#RRGGBB" value={primaryColor} disabled={busy || !organization?.logo_url || !canManageOrganization(organization?.role)} onChange={event => setPrimaryColor(event.target.value)} /></label>
          <span className="settings-branding-swatch" aria-label="Образец основного цвета" style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : 'transparent' }} />
          {canManageOrganization(organization?.role) && <button className="catalog-button button-cta" type="button" disabled={busy || !organization.logo_url || !/^#[0-9a-fA-F]{6}$/.test(primaryColor) || primaryColor.toLowerCase() === organization.primary_color?.toLowerCase()} onClick={() => void savePrimaryColor()}><AppIcon name="save" />Сохранить цвет</button>}
        </div>
        <div className="settings-branding-short-name">
          <label>Сокращённое название организации<input aria-label="Сокращённое название организации" type="text" maxLength={100} placeholder="Например, OVER-SHOP" value={shortName} disabled={busy || !canManageOrganization(organization?.role)} onChange={event => setShortName(event.target.value)} /></label>
          {canManageOrganization(organization?.role) && <button className="catalog-button button-cta" type="button" disabled={busy || shortName.trim() === (organization.short_name ?? '')} onClick={() => void saveShortName()}><AppIcon name="save" />Сохранить название</button>}
        </div>
      </div>
      {!canManageOrganization(organization?.role) && <p className="settings-help">Изменять оформление организации может только главный админ.</p>}
    </div>
    <form className="settings-welcome" onSubmit={saveWelcomeHeadline}>
      <h3>Первый экран мини-приложения</h3>
      <p className="settings-help">Три строки заголовка. Последняя выделяется цветом организации. До 80 символов в каждой строке.</p>
      <div className="settings-welcome-grid"><div className="settings-welcome-fields">
        {welcomeHeadline.map((line, index) => <label key={index}>Строка {index + 1}{index === 2 ? ' — акцент' : ''}<input aria-label={`Строка заголовка ${index + 1}`} value={line} required maxLength={80} disabled={busy || !canManageOrganization(organization?.role)} onChange={event => setWelcomeHeadline(lines => lines.map((value, position) => position === index ? event.target.value : value))} /></label>)}
      </div><div className="settings-welcome-preview" aria-label="Предпросмотр заголовка">{welcomeHeadline.map((line, index) => <span key={index} className={index === 2 ? 'settings-welcome-accent' : undefined}>{line || '…'}</span>)}</div></div>
      {canManageOrganization(organization?.role) && <div className="settings-inline-actions"><button className="catalog-button" type="button" disabled={busy || JSON.stringify(welcomeHeadline) === JSON.stringify(DEFAULT_WELCOME_HEADLINE)} onClick={() => setWelcomeHeadline([...DEFAULT_WELCOME_HEADLINE])}>Вернуть исходный текст</button><button className="catalog-button button-cta" disabled={busy || welcomeHeadline.some(line => !line.trim()) || JSON.stringify(welcomeHeadline.map(line => line.trim())) === JSON.stringify(organization?.welcome_headline ?? DEFAULT_WELCOME_HEADLINE)}><AppIcon name="save" />Сохранить заголовок</button></div>}
    </form>
    {editing && <form className="settings-user-form" onSubmit={saveProfile}><h3>{editing.id ? 'Изменить профиль' : 'Новый пользователь'}</h3>
      <label>Логин<input aria-label="Логин профиля" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={80} pattern="[a-zA-Z0-9._-]+" /></label>
      <label>{editing.id ? 'Новый пароль (необязательно)' : 'Временный пароль'}<input aria-label="Пароль профиля" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required={!editing.id} minLength={8} pattern={String.raw`.*[\p{P}\p{S}].*`} title="Минимум 8 символов и хотя бы один спецсимвол" /></label>
      <p className="settings-help">Роль: Пользователь. После создания или смены пароля пользователь задаст свой пароль при входе.</p>
      <div className="property-actions"><button className="catalog-button button-cta" disabled={busy}><AppIcon name="save" />{busy ? 'Сохраняем…' : 'Сохранить профиль'}</button><button className="catalog-button" type="button" disabled={busy} onClick={() => setEditing(null)}><AppIcon name="x" />Отмена</button></div></form>}
    {deleting && <div className="settings-delete-confirm" role="dialog" aria-label="Удалить профиль"><p>Удалить профиль {deleting.username}? Пользователь больше не сможет войти.</p><button className="catalog-button" type="button" disabled={busy} onClick={() => setDeleting(null)}><AppIcon name="x" />Отмена</button><button className="catalog-button settings-danger button-danger" type="button" disabled={busy} onClick={() => void deleteProfile()}><AppIcon name="trash" />Подтвердить удаление</button></div>}
    {error && <p className="settings-message error" role="alert">{error}</p>}
    {message && <p className="settings-message" role="status">{message}</p>}
  </section>
}
