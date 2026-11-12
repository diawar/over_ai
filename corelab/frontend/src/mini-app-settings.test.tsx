import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MiniAppSettings } from './mini-app-settings'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('previews the current organization through bearer-authenticated read-only API', async () => {
  document.cookie = 'corelab_csrf=preview-csrf'
  const requests: { url: string; options?: RequestInit }[] = []
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
    value: function(this: HTMLDialogElement) { this.open = true } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    requests.push({ url, options })
    let data: unknown = {}
    if (url.endsWith('/mini-app/settings')) data = { enabled: false }
    if (url.endsWith('/settings/organization')) data = { role: 'chief_admin' }
    if (url.endsWith('/mini-app/preview')) data = { access_token: 'preview-only', organization: { id: 1, short_name: 'Shop One', logo_url: null } }
    if (url.includes('/api/v1/products?')) data = { total: 1, page: 1, page_size: 10, items: [{ id: 9, name: 'Approved processor', price: '1200.00', currency: 'KZT', attributes: [{ code: 'cores', label: 'Ядра', value: 8, unit: null }] }] }
    return { ok: true, json: async () => data }
  }))
  render(<MiniAppSettings />)
  await screen.findByLabelText('Магазин доступен в Mini App')
  fireEvent.click(screen.getByRole('button', { name: 'Товары для Mini App' }))
  expect(await screen.findByText('Approved processor')).toBeInTheDocument()
  expect(screen.getByText('Shop One')).toBeInTheDocument()
  const productRequest = requests.find(r => r.url.includes('/api/v1/products?'))!
  expect(productRequest.options?.headers).toEqual({ Authorization: 'Bearer preview-only' })
  expect(productRequest.options?.credentials).toBe('omit')
  const previewRequest = requests.find(r => r.url.endsWith('/mini-app/preview'))!
  expect(previewRequest.options?.method).toBe('POST')
  expect(previewRequest.options?.headers).toMatchObject({ 'X-CSRF-Token': 'preview-csrf' })
})
