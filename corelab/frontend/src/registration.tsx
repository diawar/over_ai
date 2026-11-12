import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AuthFrame } from './pages'
import { adminFetch as fetch } from './admin-fetch'

export function RegistrationPage() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = useState(false)
  useEffect(() => { const previous = document.title; document.title = 'Регистрация компании — e2e'; return () => { document.title = previous } }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const form = new FormData(event.currentTarget)
    if (form.get('password') !== form.get('confirmation')) { setError('Пароли не совпадают.'); return }
    setBusy(true)
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/v1/admin/auth/register`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), username: form.get('username'), password: form.get('password') }) })
      const session = await response.json()
      if (!response.ok) throw new Error(response.status === 429 ? 'Слишком много попыток регистрации. Попробуйте позже.' : typeof session.detail === 'string' ? session.detail : 'Проверьте обязательные поля.')
      sessionStorage.setItem('corelab_session', JSON.stringify(session))
      navigate('/admin/setup', { replace: true })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <AuthFrame registration eyebrow="НОВАЯ КОМПАНИЯ" title="Регистрация организации" description="Создайте организацию и учётную запись её главного администратора. * — обязательные поля." onSubmit={submit} submitLabel={busy ? 'Создаём…' : 'Зарегистрировать компанию'} disabled={busy} secondaryAction={<p>Уже зарегистрированы? <Link to="/admin/login">Войти</Link></p>}>
    <label>Название организации *<input name="name" required maxLength={200} autoComplete="organization" placeholder="Название вашей компании" /></label>
    <label>Логин главного админа *<input name="username" required minLength={3} maxLength={80} pattern="[a-zA-Z0-9._-]+" autoComplete="username" placeholder="Например, company_admin" autoCapitalize="none" spellCheck={false} /></label>
    <label htmlFor="register-password">Пароль *</label>
    <div className="e2e-password-field"><input id="register-password" name="password" type={showPassword ? 'text' : 'password'} aria-describedby="password-hint" required minLength={8} pattern={String.raw`.*[\p{P}\p{S}].*`} title="Минимум 8 символов и хотя бы один спецсимвол" maxLength={256} autoComplete="new-password" /><button type="button" aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Скрыть' : 'Показать'}</button></div>
    <p className="auth-field-hint" id="password-hint">Не менее 8 символов и хотя бы один спецсимвол.</p>
    <label>Повторите пароль *<input name="confirmation" type="password" required minLength={8} pattern={String.raw`.*[\p{P}\p{S}].*`} title="Минимум 8 символов и хотя бы один спецсимвол" autoComplete="new-password" /></label>
    {error && <p role="alert" className="e2e-auth-error">{error}</p>}
  </AuthFrame>
}
