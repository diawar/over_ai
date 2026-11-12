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
const result = { created: 1, models: [], research: { citations: [], model_id: 'test', checked_at: '2026-10-31' } }
const load = (completed = false) => ({ id: 8, status: completed ? 'completed' : 'running', total: 1, completed: completed ? 1 : 0, skipped: 0, failed: 0, items: [] })
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

it('clears running jobs and the editor on navigation, and restores A from the server on return', async () => {
  generation = { id: 9, status: 'running' }; loading = load()
  vi.useFakeTimers()
  await act(async () => { renderCategories() })
  expect(screen.getByText('AI ищет официальные страницы и формирует свойства')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
  expect(screen.getByLabelText('Название свойства')).toHaveValue('Сокет A')
  await goToB()
  expect(screen.queryByLabelText('Название свойства')).not.toBeInTheDocument()
  expect(screen.queryByText('AI ищет официальные страницы и формирует свойства')).not.toBeInTheDocument()
  expect(screen.queryByText('Загрузка свойств: выполняется')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сформировать свойства с AI' })).toBeEnabled()
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(fetchMock.mock.calls.some(([url]) => /\/(structure-jobs\/9|jobs\/8)$/.test(url))).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Открыть A' })) })
  expect(screen.getByText('AI ищет официальные страницы и формирует свойства')).toBeInTheDocument()
  expect(screen.queryByLabelText('Название свойства')).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
})

it.each(['completed', 'failed'] as const)('does not carry a %s generation result into another category', async status => {
  generation = { id: 9, status, result, error: 'Ошибка категории A' }
  renderCategories()
  if (status === 'completed') await screen.findByText('Добавлено свойств: 1')
  else await screen.findByText('Ошибка категории A')
  await goToB()
  expect(screen.queryByText('Добавлено свойств: 1')).not.toBeInTheDocument()
  expect(screen.queryByText('Ошибка категории A')).not.toBeInTheDocument()
})

it('ignores a load poll arriving after navigation', async () => {
  loading = load()
  const pending = deferred<ReturnType<typeof response>>()
  const normal = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((url: string, options?: RequestInit) => url.endsWith('/jobs/8') ? pending.promise : normal(url, options))
  vi.useFakeTimers()
  await act(async () => { renderCategories() })
  expect(screen.getByText('Загрузка свойств: выполняется')).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/jobs/8'))).toBe(true)
  await goToB()
  await act(async () => { pending.resolve(response(load(true))) })
  expect(screen.queryByText('Загрузка свойств: завершена')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Категория: Категория B' })).toBeInTheDocument()
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
  expect(screen.getByRole('button', { name: 'Сформировать свойства с AI' })).toBeEnabled()
  await act(async () => { pending.resolve(response(category(2))) })
  expect(screen.getByRole('heading', { name: 'Категория: Категория B' })).toBeInTheDocument()
  expect(screen.queryByText('Сокет A')).not.toBeInTheDocument()
})
