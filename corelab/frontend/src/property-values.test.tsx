import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PropertyValuesPage } from './property-values'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('lists actual values and merges a duplicate only after confirmation', async () => {
  const requests: { url: string; options?: RequestInit }[] = []
  let merged = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    requests.push({ url, options })
    if (url.endsWith('/dictionary')) return { ok: true, json: async () => ({ items: [
      { id: 33, code: 'gpu_graphics_processor', label: 'Графический процессор', value_type: 'string', filled_count: 2 },
    ] }) }
    if (url.endsWith('/merge')) { merged = true; return { ok: true, json: async () => ({ updated_products: 1, target: 'GeForce RTX 5080' }) } }
    return { ok: true, json: async () => ({ attribute: { id: 33, code: 'gpu_graphics_processor', label: 'Графический процессор', value_type: 'string' },
      items: merged ? [{ key: 'GeForce RTX 5080', value: 'GeForce RTX 5080', count: 2 }] : [
        { key: 'GeForce RTX 5080', value: 'GeForce RTX 5080', count: 1 }, { key: 'NVIDIA GeForce RTX 5080', value: 'NVIDIA GeForce RTX 5080', count: 1 },
      ], total_products: 2, merge_supported: true }) }
  }))
  document.cookie = 'corelab_csrf=values-test'
  render(<MemoryRouter><PropertyValuesPage /></MemoryRouter>)
  expect(await screen.findByText('NVIDIA GeForce RTX 5080')).toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Объединить NVIDIA GeForce RTX 5080'))
  fireEvent.click(screen.getByLabelText('Объединить GeForce RTX 5080'))
  fireEvent.click(screen.getByRole('button', { name: 'Объединить значения' }))
  expect(screen.getByRole('dialog', { name: 'Объединение значений' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Оставить значение'), { target: { value: 'GeForce RTX 5080' } })
  fireEvent.click(screen.getByRole('button', { name: 'Предпросмотр объединения' }))
  expect(screen.getByText(/Будет обновлено товаров:/)).toBeInTheDocument()
  expect(merged).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить объединение' }))
  await waitFor(() => expect(merged).toBe(true))
  const call = requests.find(item => item.url.endsWith('/merge'))!
  expect(call.options?.headers).toMatchObject({ 'X-CSRF-Token': 'values-test' })
  expect(JSON.parse(String(call.options?.body))).toEqual({
    sources: ['NVIDIA GeForce RTX 5080'], target: 'GeForce RTX 5080',
    expected_counts: { 'NVIDIA GeForce RTX 5080': 1, 'GeForce RTX 5080': 1 },
  })
  expect(await screen.findByText(/Обновлено товаров: 1/)).toBeInTheDocument()
})

it('sorts values alphabetically and by product count in both directions', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/dictionary')
    ? { ok: true, json: async () => ({ items: [{ id: 33, code: 'gpu_graphics_processor', label: 'Графический процессор', value_type: 'string', filled_count: 6 }] }) }
    : { ok: true, json: async () => ({ attribute: { id: 33, code: 'gpu_graphics_processor', label: 'Графический процессор', value_type: 'string' },
      items: [{ key: 'RTX 10', value: 'RTX 10', count: 1 }, { key: 'RTX 2', value: 'RTX 2', count: 3 }, { key: 'RTX 1', value: 'RTX 1', count: 2 }], total_products: 6, merge_supported: true }) }))
  render(<MemoryRouter><PropertyValuesPage /></MemoryRouter>)
  expect(await screen.findByText('RTX 10')).toBeInTheDocument()
  const values = () => Array.from(document.querySelectorAll('tbody tr'), row => row.children[1].textContent)
  expect(values()).toEqual(['RTX 1', 'RTX 2', 'RTX 10'])
  expect(screen.getByRole('columnheader', { name: /Значение/ })).toHaveAttribute('aria-sort', 'ascending')
  fireEvent.click(screen.getByRole('button', { name: /Значение/ }))
  expect(values()).toEqual(['RTX 10', 'RTX 2', 'RTX 1'])
  fireEvent.click(screen.getByRole('button', { name: /Значение/ }))
  expect(values()).toEqual(['RTX 1', 'RTX 2', 'RTX 10'])
  fireEvent.click(screen.getByRole('button', { name: /Товаров/ }))
  expect(values()).toEqual(['RTX 2', 'RTX 1', 'RTX 10'])
  fireEvent.click(screen.getByRole('button', { name: /Товаров/ }))
  expect(values()).toEqual(['RTX 10', 'RTX 1', 'RTX 2'])
  fireEvent.change(screen.getByLabelText('Найти значение'), { target: { value: 'RTX 2' } })
  expect(values()).toEqual(['RTX 2'])
  fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск значений' }))
  expect(values()).toHaveLength(3)
  fireEvent.change(screen.getByLabelText('Найти свойство'), { target: { value: 'нет' } })
  expect(screen.queryByRole('button', { name: /Графический процессор/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Очистить поиск свойств' }))
  expect(screen.getByRole('button', { name: /Графический процессор/ })).toBeInTheDocument()
})

it('confirms deletion of the selected property and all linked product values', async () => {
  const requests: { url: string; options?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    requests.push({ url, options })
    if (options?.method === 'DELETE') return { ok: true, json: async () => ({ deleted: true, linked_products: 2 }) }
    if (url.endsWith('/dictionary')) return { ok: true, json: async () => ({ items: [
      { id: 83, code: 'cores', label: 'Количество ядер', value_type: 'integer', filled_count: 2 },
      { id: 84, code: 'socket', label: 'Сокет', value_type: 'string', filled_count: 1 },
    ] }) }
    const socket = url.endsWith('/84/values')
    return { ok: true, json: async () => ({ attribute: socket
      ? { id: 84, code: 'socket', label: 'Сокет', value_type: 'string' }
      : { id: 83, code: 'cores', label: 'Количество ядер', value_type: 'integer' },
    items: [], total_products: socket ? 1 : 2, linked_products: socket ? 1 : 2, merge_supported: true }) }
  }))
  document.cookie = 'corelab_csrf=values-test'
  render(<MemoryRouter initialEntries={['/admin/properties?attribute=83']}><PropertyValuesPage /></MemoryRouter>)
  expect(await screen.findByRole('heading', { name: 'Количество ядер' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Удалить свойство' }))
  expect(screen.getByRole('alertdialog')).toHaveTextContent('2 карточек товаров')
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
  expect(requests.some(request => request.options?.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Удалить свойство' }))
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить удаление свойства' }))
  await screen.findByRole('heading', { name: 'Сокет' })
  const deletion = requests.find(request => request.options?.method === 'DELETE')!
  expect(deletion.url).toMatch(/\/dictionary\/83$/)
  expect(deletion.options?.headers).toMatchObject({ 'X-CSRF-Token': 'values-test' })
  expect(JSON.parse(String(deletion.options?.body))).toEqual({ code: 'cores', expected_product_count: 2 })
})

it('offers merge for numbers with the target chosen from selected values', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/dictionary')
    ? { ok: true, json: async () => ({ items: [{ id: 5, code: 'base_clock_ghz', label: 'Базовая частота', value_type: 'number', filled_count: 2 }] }) }
    : { ok: true, json: async () => ({ attribute: { id: 5, code: 'base_clock_ghz', label: 'Базовая частота', value_type: 'number' },
      items: [{ key: '3.500000', value: '3.500000', count: 1 }, { key: '3.600000', value: '3.600000', count: 1 }], total_products: 2, merge_supported: true }) }))
  render(<MemoryRouter><PropertyValuesPage /></MemoryRouter>)
  expect(await screen.findByText('3.500000')).toBeInTheDocument()
  const open = screen.getByRole('button', { name: 'Объединить значения' })
  expect(open).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Объединить 3.500000'))
  expect(open).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Объединить 3.600000'))
  expect(open).toBeEnabled()
  fireEvent.click(open)
  const preview = screen.getByRole('button', { name: 'Предпросмотр объединения' })
  expect(preview).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Оставить значение'), { target: { value: '3.600000' } })
  expect(preview).toBeEnabled()
  fireEvent.click(preview)
  expect(screen.getByText(/Будет обновлено товаров:/)).toBeInTheDocument()
})

it('creates, edits, and confirms deletion of property values in dialogs', async () => {
  const writes: { method: string; body: Record<string, unknown> }[] = []
  let items: { key: string; value: string; count: number; registered: boolean }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/dictionary')) return { ok: true, json: async () => ({ items: [
      { id: 5, code: 'base_clock_ghz', label: 'Базовая частота', value_type: 'number', filled_count: 0 },
    ] }) }
    if (options?.method) {
      const body = JSON.parse(String(options.body))
      writes.push({ method: options.method, body })
      if (options.method === 'POST') {
        items = [{ key: '3.500000', value: '3.500000', count: 0, registered: true }]
        return { ok: true, json: async () => ({ key: '3.500000', value: '3.500000', count: 0 }) }
      }
      if (options.method === 'PATCH') {
        items = [{ key: '3.600000', value: '3.600000', count: 0, registered: true }]
        return { ok: true, json: async () => ({ key: '3.600000', updated_products: 0 }) }
      }
      items = []
      return { ok: true, json: async () => ({ key: '3.600000', updated_products: 0 }) }
    }
    return { ok: true, json: async () => ({ attribute: { id: 5, code: 'base_clock_ghz', label: 'Базовая частота', value_type: 'number' },
      items, total_products: 0, merge_supported: true }) }
  }))
  render(<MemoryRouter><PropertyValuesPage /></MemoryRouter>)
  await screen.findByText('Значений нет.')
  fireEvent.click(screen.getByRole('button', { name: 'Добавить значение' }))
  fireEvent.change(screen.getByLabelText('Значение свойства'), { target: { value: '3.5' } })
  fireEvent.click(screen.getByRole('button', { name: /^Добавить$/ }))
  expect(await screen.findByText('3.500000')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' }))
  fireEvent.change(screen.getByLabelText('Значение свойства'), { target: { value: '3.6' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить изменение' }))
  expect(await screen.findByText('3.600000')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Удалить$/ }))
  expect(screen.getByRole('dialog', { name: 'Удалить значение' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Подтвердить удаление' }))
  await screen.findByText('Значений нет.')
  expect(writes).toEqual([
    { method: 'POST', body: { value: '3.5' } },
    { method: 'PATCH', body: { key: '3.500000', value: '3.6', expected_count: 0 } },
    { method: 'DELETE', body: { key: '3.600000', expected_count: 0 } },
  ])
})
