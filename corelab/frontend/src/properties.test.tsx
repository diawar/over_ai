import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PropertyRulesPage, ProductPropertyCheck } from './properties'

const rule = { id: 5, attribute_id: 2, scope: '2', revision: 1, code: 'socket', label: 'Сокет', source: 'internal', level: 'required', value_type: 'string', unit: null, condition: null, applies_when: null, allowed_values: [], normalization: {}, minimum: null, maximum: null, max_length: null, format: null, evidence_url: null, checked_on: null, note: '', ai_blocked: false, required_for_selection: true }
const researchResult = { created: 1, models: [{ manufacturer: 'ASUS', model: 'Test board', url: 'https://asus.com/test' }], research: { citations: ['https://asus.com/test'], model_id: 'test-model', checked_at: '2026-10-31' } }
type ResearchJob = { id: number; status: 'queued' | 'running' | 'completed' | 'failed'; result?: typeof researchResult; error?: string }
let researchJob: ResearchJob | null = null
let items = [rule]
let checked = false
let categoryTemplate: string | null = null
let categoryName = 'Процессоры'
let categoryRequired = false
let structureStatus = 'success'
let structureErrors: string[] = []
let structureWarnings = ['Официальные модели ещё не исследованы']
const mock = vi.fn()
const state = () => ({ category: { id: 2, name: categoryName, selection_category: true, required_for_build: categoryRequired, template_code: categoryTemplate, can_generate_structure: items.length === 0 }, items, check: { status: 'warning', structure_status: structureStatus, current: checked, errors: structureErrors, warnings: structureWarnings, ai_load_allowed: checked && structureStatus === 'success', load_reason: 'Пробная выборка' } })
beforeEach(() => {
  researchJob = null
  items = [{ ...rule }]; checked = false; categoryTemplate = null; categoryName = 'Процессоры'; categoryRequired = false; structureStatus = 'success'; structureErrors = []; structureWarnings = ['Официальные модели ещё не исследованы']
  document.cookie = 'corelab_csrf=property-test'
  vi.stubGlobal('fetch', mock)
  mock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const method = opts?.method ?? 'GET'
    if (method === 'GET' && url.endsWith('/generate')) return { ok: true, json: async () => ({ job: researchJob }) }
    if (method === 'GET' && url.endsWith('/load')) return { ok: true, json: async () => ({ job: null }) }
    if (method === 'GET' && url.endsWith('/structure-jobs/9')) return { ok: true, json: async () => researchJob }
    if (method === 'POST' && url.endsWith('/generate')) {
      researchJob = { id: 9, status: 'queued' }
      return { ok: true, json: async () => researchJob }
    }
    if (String(url).endsWith('/catalog/categories/2') && opts?.method === 'PATCH') {
      categoryRequired = JSON.parse(String(opts.body)).required_for_build
      return { ok: true, json: async () => ({ id: 2, required_for_build: categoryRequired }) }
    }
    if (opts?.method === 'PATCH') {
      const id = Number(url.split('/').at(-1))
      const update = JSON.parse(String(opts.body))
      items = items.map(item => item.id === id ? { ...item, ...update } : item)
      checked = false
    }
    if (method === 'POST' && url.endsWith('/check')) checked = true
    if (opts?.method === 'POST' && String(url).endsWith('/load')) return { ok: true, json: async () => ({ id: 8, status: 'completed', total: 1, completed: 1, skipped: 0, failed: 0, items: [{ product_id: 4, status: 'completed', property_count: 1 }] }) }
    if (opts?.method === 'DELETE') items = []
    if (opts?.method === 'POST' && String(url).endsWith('/defaults')) categoryTemplate = JSON.parse(String(opts.body)).template
    return { ok: true, json: async () => url.endsWith('/templates') ? { items: [{ code: 'cpu', label: 'Процессоры', attributes: [{ code: 'socket', label: 'Сокет', source: 'internal' }, { code: 'cores', label: 'Количество ядер', source: 'internal' }] }] } : state() }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); mock.mockReset() })
function renderRules() { render(<MemoryRouter initialEntries={['/categories/2']}><Routes><Route path="/categories/:categoryId" element={<PropertyRulesPage />} /></Routes></MemoryRouter>) }

it('changes category build requirement independently through the admin screen', async () => {
  renderRules()
  const checkbox = await screen.findByRole('checkbox', { name: /Обязательно включать категорию в сборку/ })
  expect(checkbox).not.toBeChecked()
  fireEvent.click(checkbox)
  await waitFor(() => expect(checkbox).toBeChecked())
  const call = mock.mock.calls.find(([url, options]) => String(url).endsWith('/catalog/categories/2') && options?.method === 'PATCH')
  expect(JSON.parse(call?.[1].body)).toEqual({ required_for_build: true })
  expect(call?.[1].headers['X-CSRF-Token']).toBe('property-test')
})

it('opens the selected property values from its name', async () => {
  render(<MemoryRouter initialEntries={['/categories/2']}><Routes><Route path="/categories/:categoryId" element={<PropertyRulesPage />} /><Route path="/admin/properties" element={<div>Значения выбранного свойства</div>} /></Routes></MemoryRouter>)
  const link = await screen.findByRole('link', { name: 'Сокет' })
  expect(link).toHaveAttribute('href', '/admin/properties?attribute=2')
  fireEvent.click(link)
  expect(screen.getByText('Значения выбранного свойства')).toBeInTheDocument()
})

it('checks structure with CSRF, blocks AI and invalidates the old check', async () => {
  items = [{ ...rule }, { ...rule, id: 6, code: 'memory_type', label: 'Тип памяти', ai_blocked: false }]
  renderRules()
  await screen.findByText('Сокет')
  expect(screen.getByRole('columnheader', { name: 'Обязательность для карточки товара' })).toBeInTheDocument()
  const button = screen.getByRole('button', { name: 'Проверить структуру свойств' })
  expect(button).toBeEnabled()
  fireEvent.click(button)
  await screen.findByText('Проверка актуальна')
  expect(screen.getByText('Статус структуры: Успешно').closest('.property-structure-success')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Загрузить свойства' })).toBeEnabled()
  const socketRow = screen.getByText('Сокет').closest('tr')!
  const memoryRow = screen.getByText('Тип памяти').closest('tr')!
  fireEvent.click(within(socketRow).getByRole('button', { name: 'Блокировать для AI' }))
  expect(screen.getByRole('button', { name: 'Загрузить свойства' })).toBeDisabled()
  await within(socketRow).findByRole('button', { name: 'Разблокировать для AI' })
  expect(within(memoryRow).getByRole('button', { name: 'Блокировать для AI' })).toBeEnabled()
  expect(within(memoryRow).queryByRole('button', { name: 'Разблокировать для AI' })).not.toBeInTheDocument()
  expect(screen.getByText('Структуру необходимо проверить')).toBeInTheDocument()
  const loadButton = screen.getByRole('button', { name: 'Загрузить свойства' })
  expect(loadButton).toBeDisabled()
  fireEvent.click(loadButton)
  expect(mock.mock.calls.some(([url, options]) => String(url).endsWith('/load') && options?.method === 'POST')).toBe(false)
  expect(screen.getByText('Статус структуры: Успешно').closest('.property-structure-success')).not.toBeInTheDocument()
  const call = mock.mock.calls.find(([, options]) => options?.method === 'PATCH')
  expect(JSON.parse(call?.[1].body).ai_blocked).toBe(true)
  expect(call?.[1].headers['X-CSRF-Token']).toBe('property-test')
  fireEvent.click(within(socketRow).getByRole('button', { name: 'Разблокировать для AI' }))
  await within(socketRow).findByRole('button', { name: 'Блокировать для AI' })
  expect(loadButton).toBeDisabled()
  fireEvent.click(button)
  await waitFor(() => expect(loadButton).toBeEnabled())
})

it('starts a small property load only after structure check', async () => {
  renderRules()
  await screen.findByText('Сокет')
  expect(screen.getByRole('button', { name: 'Загрузить свойства' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Проверить структуру свойств' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Загрузить свойства' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить свойства' }))
  await screen.findByText(/Готово: 1/)
  const call = mock.mock.calls.find(([url, options]) => String(url).endsWith('/categories/2/load') && options?.method === 'POST')
  expect(call?.[1].headers['X-CSRF-Token']).toBe('property-test')
})

it('generates and saves a property structure from the empty category page', async () => {
  items = []
  renderRules()
  const button = await screen.findByRole('button', { name: 'Сформировать свойства с AI' })
  await waitFor(() => expect(button).toBeEnabled())
  expect(items).toEqual([])
  expect(checked).toBe(false)
  expect(mock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(button) })
  expect(screen.getByText('Задание ожидает запуска')).toBeInTheDocument()
  expect(button).toBeDisabled()
  researchJob = { id: 9, status: 'running' }
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByText('AI ищет официальные страницы и формирует свойства')).toBeInTheDocument()
  // Simulate the worker persisting rules before reporting completion.
  items = [{ ...rule }]; checked = true
  researchJob = { id: 9, status: 'completed', result: researchResult }
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByText('Добавлено свойств: 1')).toBeInTheDocument()
  expect(screen.getByText(/Test board/)).toBeInTheDocument()
  expect(screen.getByText('Сокет')).toBeInTheDocument()
  const starts = mock.mock.calls.filter(([url, options]) => String(url).endsWith('/generate') && options?.method === 'POST')
  expect(starts).toHaveLength(1)
  expect(starts[0][1].headers['X-CSRF-Token']).toBe('property-test')
  const polls = mock.mock.calls.filter(([url]) => String(url).endsWith('/structure-jobs/9')).length
  await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
  expect(mock.mock.calls.filter(([url]) => String(url).endsWith('/structure-jobs/9'))).toHaveLength(polls)
})

it('highlights an OpenAI quota error as a prominent alert', async () => {
  items = []
  renderRules()
  const button = await screen.findByRole('button', { name: 'Сформировать свойства с AI' })
  await waitFor(() => expect(button).toBeEnabled())
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(button) })
  researchJob = { id: 9, status: 'failed', error: 'OpenAI ограничил запрос: проверьте лимит или баланс аккаунта' }
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  const alert = screen.getByRole('alert')
  expect(alert).toHaveClass('property-api-limit-error')
  expect(alert).toHaveTextContent('OpenAI ограничил запрос')
  expect(button).toBeEnabled()
  expect(screen.queryByText('Добавлено свойств: 1')).not.toBeInTheDocument()
})

it.each(['completed', 'failed'] as const)('restores a %s structure job without starting generation', async status => {
  researchJob = { id: 9, status, ...(status === 'completed' ? { result: researchResult } : { error: 'Ошибка сохранённого задания' }) }
  renderRules()
  if (status === 'completed') expect(await screen.findByText('Добавлено свойств: 1')).toBeInTheDocument()
  else expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка сохранённого задания')
  expect(mock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('shows a rejected generation start and allows a retry', async () => {
  items = []
  renderRules()
  const button = await screen.findByRole('button', { name: 'Сформировать свойства с AI' })
  await waitFor(() => expect(button).toBeEnabled())
  const normalResponse = mock.getMockImplementation()!
  mock.mockImplementation((url: string, options?: RequestInit) => options?.method === 'POST' && url.endsWith('/generate')
    ? Promise.resolve({ ok: false, json: async () => ({ detail: 'AI выключен или API-ключ не задан' }) })
    : normalResponse(url, options))
  fireEvent.click(button)
  expect(await screen.findByRole('alert')).toHaveTextContent('AI выключен или API-ключ не задан')
  expect(button).toBeEnabled()
})

it('highlights structure errors and their research warning together', async () => {
  structureStatus = 'error'
  structureErrors = ['Не задана техническая структура категории']
  structureWarnings = ['Исследование 2–5 официальных моделей не прикреплено к категории в CoreLab']
  renderRules()
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveClass('property-structure-error')
  expect(alert).toHaveTextContent('Статус структуры: Ошибка')
  expect(alert).toHaveTextContent('Не задана техническая структура категории')
  expect(alert).toHaveTextContent('Исследование 2–5 официальных моделей не прикреплено к категории в CoreLab')
})

it('cancel does not save and archive asks for explicit confirmation', async () => {
  categoryName = 'Материнские платы'
  renderRules(); await screen.findByText('Сокет')
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
  fireEvent.change(screen.getByLabelText('Название свойства'), { target: { value: 'Изменение' } })
  fireEvent.click(screen.getByRole('button', { name: /^Отмена$/ }))
  expect(mock.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false)
  fireEvent.change(screen.getByLabelText('Шаблон категории'), { target: { value: 'cpu' } })
  fireEvent.click(screen.getByRole('button', { name: 'Назначить шаблон и добавить свойства' }))
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('Категория: Материнские платы')
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Будет закреплён шаблон: Процессоры')
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Количество ядер')
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
  expect(mock.mock.calls.some(([url, options]) => String(url).endsWith('/defaults') && options?.method === 'POST')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /^Удалить$/ }))
  expect(mock.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
  const deletion = await screen.findByRole('alertdialog', { name: 'Подтвердите удаление' })
  expect(deletion).toHaveClass('property-delete-confirmation')
  expect(deletion).toHaveTextContent('Удалить правило «Сокет» из структуры?')
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить удаление' }))
  await waitFor(() => expect(screen.queryByText('Сокет')).not.toBeInTheDocument())
})

it('applies a matching template in one click and saves the category assignment', async () => {
  renderRules(); await screen.findByText('Сокет')
  fireEvent.change(screen.getByLabelText('Шаблон категории'), { target: { value: 'cpu' } })
  fireEvent.click(screen.getByRole('button', { name: 'Назначить шаблон и добавить свойства' }))
  await waitFor(() => expect(mock.mock.calls.some(([url, options]) => String(url).endsWith('/defaults') && options?.method === 'POST')).toBe(true))
  const call = mock.mock.calls.find(([url, options]) => String(url).endsWith('/defaults') && options?.method === 'POST')
  expect(JSON.parse(call?.[1].body)).toEqual({ template: 'cpu' })
  await screen.findByText('Закреплённый шаблон: Процессоры.')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it('scrolls to the editor and saves an edited property', async () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  const scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
  try {
    renderRules(); await screen.findByText('Сокет')
    fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Название свойства'), { target: { value: 'Сокет процессора' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить свойство' }))
    await screen.findByText('Сокет процессора')
    expect(mock.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(true)
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: originalScrollIntoView })
  }
})

it('shows only internal category validation findings', async () => {
  mock.mockResolvedValue({ ok: true, json: async () => ({ status: 'warning', scope: 'Проверка внутренних правил', groups: { internal: { status: 'warning', findings: [{ label: 'Сокет', message: 'Рекомендуется заполнить', severity: 'warning' }] } } }) })
  render(<ProductPropertyCheck productId={7} />)
  fireEvent.click(screen.getByRole('button', { name: 'Проверить данные товара' }))
  await screen.findByText('Внутренние требования — Предупреждение')
  const validation = mock.mock.calls.find(([url]) => String(url).endsWith('/validate'))
  expect(JSON.parse(validation?.[1].body)).toEqual({})
})
