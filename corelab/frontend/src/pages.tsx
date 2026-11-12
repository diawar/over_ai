import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { roleLabel } from './roles'
import { FormEvent, ReactNode, useEffect, useLayoutEffect, useState } from 'react'
import { E2E_COLOR, initialColor, rememberColor, themeStyle, validColor } from './organization-theme'
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import './auth.css'
import './onboarding.css'

const API = import.meta.env.VITE_API_URL ?? ''
type Session = { username: string; role: string; organization_context?: string; onboarding_required?: boolean; organization?: { id: number; name: string; short_name?: string | null; logo_url?: string | null; primary_color?: string }; csrf_token?: string; must_change_password?: boolean }

export function LoginPage() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const navigate = useNavigate()
  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Вход для администратора — e2e'
    return () => { document.title = previousTitle }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true)
    const data = new FormData(event.currentTarget)
    try {
      const response = await fetch(`${API}/api/v1/admin/auth/login`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: data.get('username'), password: data.get('password') }) })
      if (!response.ok) { setError(response.status === 401 ? 'Неверный логин или пароль' : 'Не удалось войти'); return }
      const session: Session = await response.json()
      if (session.organization) rememberColor(session.organization.id, session.organization.primary_color)
      sessionStorage.setItem('corelab_session', JSON.stringify(session))
      navigate(session.role === 'platform_admin' ? '/admin/organizations' : session.onboarding_required ? '/admin/setup' : '/admin/catalog', { replace: true })
    } catch { setError('Сервер пока недоступен') } finally { setBusy(false) }
  }
  return <AuthFrame showLoginHelp eyebrow="АДМИНИСТРАТИВНЫЙ ДОСТУП" title="Войти в систему" description="Используйте данные вашей организации для входа." onSubmit={submit} submitLabel={busy ? 'Входим…' : 'Войти в систему'} disabled={busy} secondaryAction={<p>Нет организации? <Link to="/register">Создать компанию</Link></p>}>
    <label htmlFor="login-username">Логин</label>
    <input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Введите логин" required aria-invalid={!!error} />
    <label htmlFor="login-password">Пароль</label>
    <div className="e2e-password-field"><input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Введите пароль" required aria-invalid={!!error} /><button type="button" aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Скрыть' : 'Показать'}</button></div>
    {error && <p className="e2e-auth-error" role="alert">{error}</p>}
  </AuthFrame>
}

export function AuthFrame({ eyebrow, title, description, submitLabel, disabled, onSubmit, children, showLoginHelp = false, registration = false, secondaryAction }: { eyebrow: string; title: string; description: string; submitLabel: string; disabled?: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode; showLoginHelp?: boolean; registration?: boolean; secondaryAction?: ReactNode }) {
  return <main className="e2e-auth-page">
    <header className="e2e-auth-header"><Link className="e2e-auth-brand" to="/" aria-label="e2e end-to-end — на главную"><span>e2e</span><small>end-to-end</small></Link><Link className="e2e-auth-home" to="/">На главную <span aria-hidden="true"><AppIcon name="arrow-up-right" /></span></Link></header>
    <div className="e2e-auth-layout">
      <section className="e2e-auth-intro" aria-label="Платформа e2e">
        <div className="e2e-auth-kicker"><i /> ПЛАТФОРМА ДЛЯ ТОВАРНОГО БИЗНЕСА</div>
        <h1>Каталог,<br /><span>который работает.</span></h1>
        <p>Товары, характеристики и инструменты продаж — в едином рабочем пространстве вашей компании.</p>
        <div className="e2e-auth-preview"><div className="e2e-auth-preview-head"><span><i /><i /><i /></span><b>Рабочее пространство</b><small>ДЕМО</small></div><div className="e2e-auth-preview-title">Каталог товаров <AppIcon name="arrow-up-right" /></div><div className="e2e-auth-preview-stats"><div><small>Товары</small><b>Каталог</b></div><div><small>Данные</small><b>Характеристики</b></div></div><div className="e2e-auth-preview-row"><span><AppIcon name="file-spreadsheet" /></span><b>Подготовка каталога</b><i>Готово</i></div><div className="e2e-auth-preview-row"><span><AppIcon name="sparkles" /></span><b>AI-подбор</b><i>Активен</i></div></div>
        <div className="e2e-auth-trust"><AppIcon name="shield-check" /><span>Доступ только для авторизованных сотрудников</span></div>
      </section>
      <section className="e2e-auth-form-wrap" aria-label={title}>
        {(registration || showLoginHelp) && <nav className="auth-tabs" aria-label="Доступ к платформе"><Link to="/admin/login" aria-current={showLoginHelp ? 'page' : undefined}>Вход</Link><Link to="/register" aria-current={registration ? 'page' : undefined}>Регистрация</Link></nav>}
        <form className="e2e-auth-card" onSubmit={onSubmit}>
        <p className="e2e-auth-eyebrow">{eyebrow}</p><h2>{title}</h2><p className="e2e-auth-description">{description}</p>
        {children}
        <button className="e2e-auth-submit" disabled={disabled}>{submitLabel}<span aria-hidden="true"><AppIcon name="arrow-right" /></span></button>
        {secondaryAction && <div className="auth-secondary">{secondaryAction}</div>}
        <p className="e2e-auth-secure"><span aria-hidden="true"><AppIcon name="shield-check" /></span> Доступ к рабочему пространству компании</p>
        {showLoginHelp && <details className="e2e-auth-help"><summary>Не получается войти?</summary><p>Проверьте раскладку клавиатуры и Caps Lock. Если вы забыли пароль или ещё не получили логин, обратитесь к администратору вашей организации.</p></details>}
      </form></section>
    </div>
    <footer className="e2e-auth-footer"><span>e2e · end-to-end</span><span>Интеллектуальные инструменты для бизнеса</span></footer>
  </main>
}

export function AdminLayout() {
  const location = useLocation(); const navigate = useNavigate()
  const [session, setSession] = useState<Session | null>(() => { try { return JSON.parse(sessionStorage.getItem('corelab_session') ?? 'null') } catch { return null } })
  const [color, setColor] = useState<string | null>(() => initialColor(session?.organization?.id, session?.organization?.primary_color))
  useLayoutEffect(() => {
    const id = session?.organization?.id
    const update = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail.id === id && validColor(detail.color)) setColor(detail.color) }
    window.addEventListener('corelab:brand-color', update)
    const sync = (event: StorageEvent) => { if (id && event.key === `corelab:brand-color:${id}` && validColor(event.newValue)) setColor(event.newValue) }
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener('corelab:brand-color', update); window.removeEventListener('storage', sync) }
  }, [session?.organization?.id])
  useEffect(() => {
    if (!session) return
    fetch(`${API}/api/v1/admin/auth/me`, { credentials: 'include' }).then(async r => {
      if (!r.ok) { sessionStorage.removeItem('corelab_session'); setSession(null); return }
      const current: Session = { ...await r.json(), ...(session.organization_context ? { organization_context: session.organization_context } : {}) }
      if (current.organization) rememberColor(current.organization.id, current.organization.primary_color)
      setColor(validColor(current.organization?.primary_color) ? current.organization.primary_color : E2E_COLOR)
      setSession(current); sessionStorage.setItem('corelab_session', JSON.stringify(current))
    }).catch(() => { sessionStorage.removeItem('corelab_session'); setSession(null) })
  }, [])
  if (!session) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />
  if (session.must_change_password) return <PasswordChange onComplete={() => {
    const updated = { ...session, must_change_password: false }
    sessionStorage.setItem('corelab_session', JSON.stringify(updated)); setSession(updated)
  }} />
  if (session.onboarding_required && location.pathname !== '/admin/setup' && !(session.role === 'platform_admin' && ['/admin/organizations', '/admin/platform-users'].includes(location.pathname))) return <Navigate to="/admin/setup" replace />
  const platformPage = session.role === 'platform_admin' && ['/admin/organizations', '/admin/platform-users'].includes(location.pathname)
  const setupLocked = !!session.onboarding_required && !platformPage
  const brandName = setupLocked ? 'e2e' : platformPage ? 'CoreLab' : session.organization?.short_name?.trim() || 'CoreLab'
  const brandLogo = !platformPage && session.organization?.logo_url ? `${API}${session.organization.logo_url}` : '/corelab-logo.png'
  function menuItem(to: string, label: string, icon: ReactNode) {
    return setupLocked
      ? <span key={to} className="onboarding-nav-disabled" role="link" aria-disabled="true" aria-label={label} title="Доступно после завершения настройки"><span>{icon}</span>{label}</span>
      : <Link key={to} aria-label={label} className={(to === '/admin/properties' ? location.pathname.includes('properties') : location.pathname.startsWith(to)) ? 'active' : ''} to={to}><span>{icon}</span>{label}</Link>
  }
  async function logout() {
    const csrf = document.cookie.split('; ').find(x => x.startsWith('corelab_csrf='))?.split('=').slice(1).join('=') ?? session?.csrf_token ?? ''
    await fetch(`${API}/api/v1/admin/auth/logout`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': decodeURIComponent(csrf) } }).catch(() => undefined)
    sessionStorage.removeItem('corelab_session'); setSession(null); navigate('/admin/login', { replace: true })
  }
  if (!color && !setupLocked) return <main className="content" role="status">Загрузка оформления организации…</main>
  return <div className={`admin-shell${setupLocked ? ' onboarding-shell' : ''}`} style={themeStyle(color || E2E_COLOR)}><aside className="sidebar"><div className={`brand${setupLocked ? ' onboarding-brand' : ''}`}>{setupLocked ? <><span className="onboarding-brand-logo" role="img" aria-label="Логотип e2e">e2e</span><span className="onboarding-brand-caption">end-to-end</span></> : <><span className="brand-mark small"><img src={brandLogo} alt={brandName} /></span><span>{brandName}</span></>}</div><p className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p><nav aria-label="Рабочее пространство">
    {session.role === 'platform_admin' && <>{menuItem('/admin/organizations', 'Организации', <AppIcon name="globe" />)}{menuItem('/admin/platform-users', 'Пользователи CoreLab', <AppIcon name="user-plus" />)}</>}
    {menuItem('/admin/catalog', 'Каталог', <AppIcon name="layout-grid" />)}
    {menuItem('/admin/properties', 'Свойства и значения', <AppIcon name="sliders-horizontal" />)}
    {menuItem('/admin/sources', 'Источники', <AppIcon name="arrow-left-right" />)}
    {menuItem('/admin/logs', 'Журнал', <AppIcon name="history" />)}
    {menuItem('/admin/settings', 'Настройки', <AppIcon name="settings" />)}
  </nav>{setupLocked && <p className="onboarding-nav-note"><AppIcon name="shield-check" />Разделы откроются после настройки организации.</p>}<div className="sidebar-foot">{session.organization?.name ?? 'Организация'}</div></aside>
    <div className="main-column"><header><span>{platformPage ? 'Администрирование CoreLab' : session.organization?.name ?? 'Панель управления'}</span><div className="user-menu"><span className="avatar">{session.username.slice(0, 1).toUpperCase()}</span><span>{session.username} · {roleLabel(session.role)}</span><button onClick={logout}>Выйти</button></div></header><main className="content">{session.role === 'platform_admin' && !platformPage && <div className="platform-context"><AppIcon name="shield-check" /><span>Администратор CoreLab · {session.organization?.name} · права главного админа</span><Link to="/admin/organizations">Сменить организацию</Link></div>}<Outlet /></main></div>
  </div>
}

function PasswordChange({ onComplete }: { onComplete: () => void }) {
  const [error, setError] = useState('')
  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Смена пароля — e2e'
    return () => { document.title = previousTitle }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const data = new FormData(event.currentTarget)
    const csrf = document.cookie.split('; ').find(x => x.startsWith('corelab_csrf='))?.split('=').slice(1).join('=') ?? ''
    const response = await fetch(`${API}/api/v1/admin/auth/change-password`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: JSON.stringify({ current_password: data.get('current_password'), new_password: data.get('new_password') }) }).catch(() => null)
    if (!response?.ok) { setError('Проверьте текущий пароль; новый пароль должен содержать не менее 8 символов и хотя бы один спецсимвол.'); return }
    onComplete()
  }
  return <AuthFrame eyebrow="ПЕРВЫЙ ВХОД" title="Смените пароль" description="Перед продолжением задайте постоянный пароль из 8 или более символов, включая хотя бы один спецсимвол." onSubmit={submit} submitLabel="Сохранить пароль">
    <label>Текущий пароль<input name="current_password" type="password" autoComplete="current-password" required /></label>
    <label>Новый пароль<input name="new_password" type="password" autoComplete="new-password" minLength={8} pattern={String.raw`.*[\p{P}\p{S}].*`} title="Минимум 8 символов и хотя бы один спецсимвол" required /></label>
    {error && <p className="e2e-auth-error" role="alert">{error}</p>}
  </AuthFrame>
}
