import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { PropertyRulesPage } from './properties'

const rule = { id: 5, attribute_id: 2, code: 'socket', label: 'Сокет A', scope: '2', source: 'internal', level: 'required', value_type: 'string', unit: null, condition: null, applies_when: null, allowed_values: [], normalization: {}, minimum: null, maximum: null, max_length: null, format: null, evidence_url: null, checked_on: null, note: '', ai_blocked: false, required_for_selection: true }
const category = (id: number) => ({
  category: { id, name: id === 2 ? 'Категория A' : 'Категория B', selection_category: true, required_for_build: false, template_code: null, can_generate_structure: id === 3 },
  items: id === 2 ? [rule] : [],
  check: { current: false, status: 'warning', structure_status: 'success', errors: [], warnings: [], ai_load_allowed: false, load_reason: 'Нужна проверка' },
})
const response = (body: unknown) => ({ ok: true, json: async () => body })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const fetchMock = vi.fn()
let generation: unknown = null
let loading: unknown = null
function renderCategories() {
  render(<MemoryRouter initialEntries={['/categories/2']}>
    <Link to="/categories/2">Открыть A</Link><Link to="/categories/3">Открыть B</Link>
    <Routes><Route path="/categories/:categoryId" element={<PropertyRulesPage />} /></Routes>
  </MemoryRouter>)
}
async function goToB() {
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Открыть B' })) })
  expect(screen.getByRole('heading', { name: 'Категория: Категория B' })).toBeInTheDocument()
}
beforeEach(() => {
  generation = null; loading = null
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET'
    if (method === 'POST' && url.endsWith('/categories/2/check')) return response({})
    if (method === 'GET') {
      if (url.endsWith('/templates')) return response({ items: [] })
      if (url.endsWith('/categories/2/generate')) return response({ job: generation })
      if (url.endsWith('/categories/2/load')) return response({ job: loading })
      if (url.endsWith('/categories/3/generate') || url.endsWith('/categories/3/load')) return response({ job: null })
      if (url.endsWith('/categories/2')) return response(category(2))
      if (url.endsWith('/categories/3')) return response(category(3))
      if (url.endsWith('/structure-jobs/9')) return response(generation)
      if (url.endsWith('/jobs/8')) return response(loading)
    }
    throw new Error(`Unexpected test request: ${method} ${url}`)
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); fetchMock.mockReset() })

it('clears the editor on category navigation without polling paid jobs', async () => {
  renderCategories()
  await screen.findByText('Сокет A')
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
  expect(screen.getByLabelText('Название свойства')).toHaveValue('Сокет A')
  await goToB()
  expect(screen.queryByLabelText('Название свойства')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Сформировать свойства с AI' })).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.some(([url]) => /\/(load|generate|structure-jobs|jobs)(\/|$)/.test(String(url)))).toBe(false)
})

it('ignores a category refresh started by a mutation on the previous page', async () => {
  const pending = deferred<ReturnType<typeof response>>()
  const normal = fetchMock.getMockImplementation()!
  let checking = false
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (url.endsWith('/categories/2/check')) checking = true
    if (checking && url.endsWith('/categories/2')) return pending.promise
    return normal(url, options)
  })
  renderCategories()
  await screen.findByText('Сокет A')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить структуру свойств' })) })
  await goToB()
  expect(screen.getByRole('button', { name: 'Добавить свойство' })).toBeEnabled()
  await act(async () => { pending.resolve(response(category(2))) })
  expect(screen.getByRole('heading', { name: 'Категория: Категория B' })).toBeInTheDocument()
  expect(screen.queryByText('Сокет A')).not.toBeInTheDocument()
})
