import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from './settings'

const fetchMock = vi.fn()
let configured = false
let aiEnabled = true
let profiles: { id: number; username: string; role: string; must_change_password: boolean }[] = []
beforeEach(() => {
  configured = false
  aiEnabled = true
  profiles = [{ id: 1, username: 'Diawar86', role: 'chief_admin', must_change_password: false }]
  document.cookie = 'corelab_csrf=settings-test'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/ai/active')) return { ok: true, json: async () => ({ provider: 'openai', enabled: aiEnabled }) }
    if (url.endsWith('/ai/mode')) {
      aiEnabled = JSON.parse(String(options?.body)).enabled
      return { ok: true, json: async () => ({ enabled: aiEnabled }) }
    }
    if (url.endsWith('/kimi')) return { ok: true, json: async () => ({ provider: 'Kimi', configured: options?.method === 'PUT', model_id: 'kimi-k2.5' }) }
    if (url.endsWith('/openrouter')) return { ok: true, json: async () => ({ provider: 'OpenRouter', configured: options?.method === 'PUT', model_id: 'moonshotai/kimi-k2.5' }) }
    if (url.endsWith('/organization')) return { ok: true, json: async () => ({ id: 1, name: 'ТОО "OVER-SHOP.KZ"', role: 'chief_admin' }) }
    if (url.endsWith('/users') && options?.method === 'POST') {
      const body = JSON.parse(String(options.body))
      profiles.push({ id: 2, username: body.username, role: 'admin', must_change_password: true })
      return { ok: true, json: async () => profiles.at(-1) }
    }
    if (url.endsWith('/users')) return { ok: true, json: async () => ({ items: profiles }) }
    if (options?.method === 'PUT') configured = true
    if (options?.method === 'DELETE') configured = false
    return { ok: true, json: async () => options?.method === 'POST' ? { status: 'success', model_id: 'gpt-5.5' } : { provider: 'OpenAI', configured, model_id: 'gpt-5.5' } }
  })
})

it('switches to Kimi, saves its own key and clears the secret', async () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByLabelText('API-ключ OpenAI')
  fireEvent.change(screen.getByLabelText('Провайдер AI'), { target: { value: 'kimi' } })
  const field = await screen.findByLabelText('API-ключ Kimi')
  await screen.findByDisplayValue('kimi-k2.5')
  fireEvent.change(field, { target: { value: 'sk-kimi-test-0123456789012345' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключ' }))
  await screen.findByText('Ключ сохранён в зашифрованном виде.')
  expect(field).toHaveValue('')
  const call = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith('/kimi') && options?.method === 'PUT')!
  expect(JSON.parse(String(call[1].body))).toEqual({ api_key: 'sk-kimi-test-0123456789012345', model_id: 'kimi-k2.5' })
})

it('activates an already configured provider on selection and restores it after reopening', async () => {
  const original = fetchMock.getMockImplementation()!
  let active = 'openai'
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/ai/active')) return { ok: true, json: async () => ({ provider: active, enabled: true }) }
    if (url.endsWith('/kimi')) return { ok: true, json: async () => ({ provider: 'Kimi', configured: true, model_id: 'kimi-k2.6' }) }
    if (url.endsWith('/ai/kimi/activate') && options?.method === 'POST') {
      active = 'kimi'
      return { ok: true, json: async () => ({ provider: active }) }
    }
    return original(url, options)
  })
  const view = render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByLabelText('API-ключ OpenAI')
  fireEvent.change(screen.getByLabelText('Провайдер AI'), { target: { value: 'kimi' } })
  await screen.findByText('Выбран Kimi. Настройка сохранена для каталога и мини-приложения.')
  expect(active).toBe('kimi')
  view.unmount()
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByDisplayValue('kimi-k2.6')
  expect(screen.getByLabelText('Провайдер AI')).toHaveValue('kimi')
})

it('does not activate a provider without a saved key', async () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByLabelText('API-ключ OpenAI')
  fireEvent.change(screen.getByLabelText('Провайдер AI'), { target: { value: 'kimi' } })
  await screen.findByText(/Пока действует прежнее подключение/)
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/activate'))).toBe(false)
})

it('keeps the active provider and permits retry when activation fails', async () => {
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/kimi')) return { ok: true, json: async () => ({ provider: 'Kimi', configured: true, model_id: 'kimi-k2.6' }) }
    if (url.endsWith('/activate')) return { ok: false, json: async () => ({ detail: 'Не удалось сохранить выбор' }) }
    return original(url, options)
  })
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByLabelText('API-ключ OpenAI')
  fireEvent.change(screen.getByLabelText('Провайдер AI'), { target: { value: 'kimi' } })
  await screen.findByText('Не удалось сохранить выбор')
  expect(screen.getByText(/Для всех функций используется: OpenAI/)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Использовать Kimi' })).toBeEnabled())
})

it('lets the chief admin turn AI off and back on without deleting a key', async () => {
  configured = true
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  const mode = await screen.findByLabelText('Режим AI')
  fireEvent.change(mode, { target: { value: 'off' } })
  expect(await screen.findByText('AI выключен для каталога и мини-приложения.')).toBeInTheDocument()
  expect(screen.getByText('AI выключен')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Удалить ключ' })).toBeEnabled()
  fireEvent.change(mode, { target: { value: 'on' } })
  expect(await screen.findByText('AI включён.')).toBeInTheDocument()
  const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/ai/mode'))
  expect(calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([{ enabled: false }, { enabled: true }])
})

it('saves an OpenRouter model for all AI functions', async () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByLabelText('API-ключ OpenAI')
  fireEvent.change(screen.getByLabelText('Провайдер AI'), { target: { value: 'openrouter' } })
  const field = await screen.findByLabelText('API-ключ OpenRouter')
  await screen.findByDisplayValue('moonshotai/kimi-k2.5')
  fireEvent.change(field, { target: { value: 'sk-or-test-0123456789012345' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключ' }))
  await screen.findByText('Ключ сохранён в зашифрованном виде.')
  const call = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith('/openrouter') && options?.method === 'PUT')!
  expect(JSON.parse(String(call[1].body))).toEqual({ api_key: 'sk-or-test-0123456789012345', model_id: 'moonshotai/kimi-k2.5' })
  expect(field).toHaveValue('')
})

it('lets the chief admin create an admin profile', async () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Добавить пользователя' }))
  fireEvent.change(screen.getByLabelText('Логин профиля'), { target: { value: 'new-admin' } })
  fireEvent.change(screen.getByLabelText('Пароль профиля'), { target: { value: 'temporary-password-123' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить профиль' }))
  expect(await screen.findByText('new-admin')).toBeInTheDocument()
  const call = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith('/users') && options?.method === 'POST')!
  expect(JSON.parse(String(call[1]?.body))).toEqual({ username: 'new-admin', password: 'temporary-password-123' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset() })

it('saves the key through the settings page and clears the input', async () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  const field = await screen.findByLabelText('API-ключ OpenAI') as HTMLInputElement
  expect(field).toHaveValue('')
  fireEvent.change(field, { target: { value: 'sk-test-0123456789abcdef' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить ключ' }))
  expect(await screen.findByText('Ключ сохранён в зашифрованном виде.')).toBeInTheDocument()
  expect(field).toHaveValue('')
  const call = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')
  expect(JSON.parse(call?.[1].body)).toEqual({ api_key: 'sk-test-0123456789abcdef', model_id: 'gpt-5.5' })
  expect(call?.[1].headers['X-CSRF-Token']).toBe('settings-test')
})

it('tests and deletes a previously configured provider key', async () => {
  configured = true
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: 'Проверить подключение' }))
  expect(await screen.findByText('Подключение работает. Модель gpt-5.5 доступна.')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Удалить ключ' }))
  expect(await screen.findByText('Ключ удалён.')).toBeInTheDocument()
  expect(screen.getByText('Ключ не добавлен')).toBeInTheDocument()
})

it('keeps color controls unavailable until a logo is uploaded', async () => {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  await screen.findByRole('button', { name: 'Добавить пользователя' })
  expect(screen.getByLabelText('HEX-код основного цвета организации')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Сохранить цвет' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: /Выбрать цвет/ })).not.toBeInTheDocument()
})

it('shows only the logo palette and clears it after removing the logo', async () => {
  const original = fetchMock.getMockImplementation()!
  let logo = true
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/organization/logo') && options?.method === 'DELETE') { logo = false; return { ok:true, json:async()=>({logo_url:null}) } }
    if (url.endsWith('/organization')) return {ok:true,json:async()=>({id:1,name:'Organization',role:'chief_admin',primary_color:'#ff6020',logo_url:logo?'/logo?v=1':null,logo_palette:logo?['#FF6020','#00A050']:[]})}
    return original(url,options)
  })
  render(<MemoryRouter><SettingsPage /></MemoryRouter>)
  const green = await screen.findByRole('button', {name:'Выбрать цвет #00A050'})
  expect(screen.getAllByRole('button', {name:/Выбрать цвет/})).toHaveLength(2)
  fireEvent.click(green)
  expect(screen.getByLabelText('HEX-код основного цвета организации')).toHaveValue('#00A050')
  expect(screen.getByRole('button', {name:'Сохранить цвет'})).toBeEnabled()
  fireEvent.click(screen.getByRole('button', {name:'Удалить логотип'}))
  await screen.findByText('Логотип удалён.')
  expect(screen.queryByRole('button', {name:/Выбрать цвет/})).not.toBeInTheDocument()
  expect(screen.getByLabelText('HEX-код основного цвета организации')).toBeDisabled()
})
