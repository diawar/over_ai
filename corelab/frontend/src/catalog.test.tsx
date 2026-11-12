import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { CatalogPage, CatalogProductPage } from './catalog'

const categories = [
  { id: 1, parent_id: null, name: 'Комплектующие', valid: 1, total: 2 },
  { id: 2, parent_id: 1, name: 'Процессоры', valid: 1, total: 2 },
]
const product = { id: 7, sku: 'p1:7', name: 'Ryzen 7', article: 'R7', manufacturer: 'AMD', categories: [{ id: 2, name: 'Процессоры' }], status: 'active', validity_check: true, selection_enabled: true, current_offer_count: 1, current_price: '12000.00', currency: 'KZT', attributes: [{ code: 'socket', label: 'Сокет', value: 'AM5', value_state: 'known', unit: null, source_url: null as string | null, source_kind: 'manual' }], available_attributes: [
  { code: 'socket', label: 'Сокет', value_type: 'string', unit: null, allowed_values: [], minimum: null, maximum: null, max_length: null, format: null, editable: true, edit_reason: null },
  { code: 'cores', label: 'Число ядер', value_type: 'integer', unit: null, allowed_values: [], minimum: 1, maximum: null, max_length: null, format: null, editable: true, edit_reason: null },
] }
const fetchMock = vi.fn()
let currentProduct = product
let currentCategories = categories

beforeEach(() => {
  sessionStorage.clear()
  currentProduct = structuredClone(product)
  currentCategories = structuredClone(categories)
  vi.stubGlobal('fetch', fetchMock)
  document.cookie = 'corelab_csrf=catalog-test'
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/properties/dictionary')) return { ok: true, json: async () => ({ items: [{ id: 5, code: 'socket' }, { id: 6, code: 'cores' }] }) }
    if (url.endsWith('/properties/dictionary/5/values')) return { ok: true, json: async () => ({ items: [{ key: 'AM5+', value: 'AM5+', count: 3 }, { key: 'AM5', value: 'AM5', count: 1 }] }) }
    if (url.endsWith('/properties/dictionary/6/values')) return { ok: true, json: async () => ({ items: [] }) }
    if (url.includes('/bulk-attributes/options')) return { ok: true, json: async () => ({ items: [currentProduct.available_attributes[0]] }) }
    if (options?.method === 'POST' && url.endsWith('/bulk-attributes/preview')) return { ok: true, json: async () => ({
      attribute: { code: 'socket', label: 'Сокет', value_type: 'string', unit: null }, value_state: 'known', value: 'AM4',
      selected_count: 1, overwrite_count: 1, insert_count: 0, preview_token: '1234567890.signature',
      items: [{ product_id: 7, name: 'Ryzen 7', sku: 'p1:7', category: 'Процессоры', will_overwrite: true,
        previous: { value_state: 'known', value: 'AM5', source_kind: 'manual', source_url: null } }],
    }) }
    if (options?.method === 'POST' && url.endsWith('/bulk-attributes/apply')) return { ok: true, json: async () => ({ updated_count: 1, overwrite_count: 1, insert_count: 0 }) }
    if (options?.method === 'PATCH' && url.includes('/catalog/categories/')) {
      const id = Number(url.split('/').at(-1))
      const body = JSON.parse(String(options.body))
      currentCategories = currentCategories.map(item => item.id === id ? { ...item, ...body } : item)
      return { ok: true, json: async () => ({ id, ...body }) }
    }
    if (options?.method === 'PATCH' && url.endsWith('/selection')) {
      currentProduct.selection_enabled = JSON.parse(String(options.body)).selection_enabled
      return { ok: true, json: async () => ({ selection_enabled: currentProduct.selection_enabled, validity_check: true }) }
    }
    if (options?.method === 'PATCH' && url.includes('/attributes/')) {
      const code = url.split('/').at(-1)!
      const body = JSON.parse(String(options.body))
      const option = currentProduct.available_attributes.find(item => item.code === code)!
      const edited = { code, label: option.label, unit: option.unit, ...body }
      currentProduct.attributes = [...currentProduct.attributes.filter(item => item.code !== code), edited]
      return { ok: true, json: async () => ({ ...body, code, validity_check: null }) }
    }
    if (options?.method === 'DELETE' && url.includes('/attributes/')) {
      const code = url.split('/').at(-1)!
      currentProduct.attributes = currentProduct.attributes.filter(item => item.code !== code)
      return { ok: true, json: async () => ({ code, validity_check: null }) }
    }
    return {
      ok: true,
      json: async () => options?.method === 'PATCH' ? { id: 1, selection_category: true } :
        url.endsWith('/categories') ? { items: currentCategories } :
          url.endsWith('/7') ? { ...currentProduct, validation_reasons: [], offers: [{ source: 'p1', sku: '7', price: '12000.00', currency: 'KZT', is_current: true }] } :
            { items: [currentProduct], total: 2 },
    }
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset() })

describe('CoreLab catalog', () => {
  it('restores searches, category, sorting and pagination after product and category navigation', async () => {
    const originalFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (...args) => {
      const response = await originalFetch(...args)
      if (String(args[0]).includes('/catalog?')) return { ...response, json: async () => ({ ...(await response.json()), total: 150 }) }
      return response
    })
    render(<MemoryRouter initialEntries={['/admin/catalog']}><Routes>
      <Route path="/admin/catalog" element={<CatalogPage />} />
      <Route path="/admin/catalog/:productId" element={<CatalogProductPage />} />
      <Route path="/admin/categories/:categoryId/properties" element={<Link to="/admin/catalog">Каталог из категории</Link>} />
    </Routes></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Развернуть Комплектующие' }))
    fireEvent.change(screen.getByLabelText('Поиск категории по названию'), { target: { value: 'Процессоры' } })
    fireEvent.click(screen.getByRole('button', { name: 'Процессоры' }))
    fireEvent.change(screen.getByLabelText('Поиск в каталоге'), { target: { value: 'Ryzen' } })
    fireEvent.change(screen.getByLabelText('Сортировка'), { target: { value: 'price_desc' } })
    fireEvent.change(screen.getByLabelText('Товаров на странице'), { target: { value: '50' } })
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('q=Ryzen'))).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Далее' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    await screen.findByText('2 / 3')
    fireEvent.click(await screen.findByRole('link', { name: 'Ryzen 7' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Вернуться в каталог' }))
    await screen.findByRole('link', { name: 'Ryzen 7' })
    const assertView = () => {
      expect(screen.getByLabelText('Поиск категории по названию')).toHaveValue('Процессоры')
      expect(screen.getByLabelText('Поиск в каталоге')).toHaveValue('Ryzen')
      expect(screen.getByRole('button', { name: 'Процессоры' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByLabelText('Сортировка')).toHaveValue('price_desc')
      expect(screen.getByLabelText('Товаров на странице')).toHaveValue('50')
      expect(screen.getByText('2 / 3')).toBeInTheDocument()
    }
    assertView()
    // A restored query must not reset the saved page when the debounce interval expires.
    await new Promise(resolve => setTimeout(resolve, 350))
    assertView()
    fireEvent.click(screen.getByRole('link', { name: 'Ryzen 7' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Свойства категории: Процессоры' }))
    fireEvent.click(screen.getByRole('link', { name: 'Каталог из категории' }))
    await screen.findByRole('link', { name: 'Ryzen 7' })
    assertView()
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры' }))
    expect(screen.getByLabelText('Поиск категории по названию')).toHaveValue('')
    expect(screen.getByLabelText('Поиск в каталоге')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Все товары' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('previews a mass property edit and only writes after confirmation', async () => {
    render(<MemoryRouter><CatalogPage /></MemoryRouter>)
    await screen.findByRole('link', { name: 'Ryzen 7' })
    fireEvent.click(screen.getByLabelText('Выбрать Ryzen 7'))
    fireEvent.click(screen.getByRole('button', { name: 'Изменить свойства' }))
    fireEvent.change(await screen.findByLabelText('Свойство'), { target: { value: 'socket' } })
    fireEvent.change(screen.getByLabelText('Значение свойства для массового изменения'), { target: { value: 'AM4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Предпросмотр изменений' }))
    expect(await screen.findByText(/сейчас: AM5/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/bulk-attributes/apply') && options?.method === 'POST')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить и сохранить' }))
    await screen.findByText(/Сохранено товаров: 1/)
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/bulk-attributes/apply') && options?.method === 'POST')).toBe(true)
  })
  it('rechecks selection and independently excludes a valid product', async () => {
    render(<MemoryRouter initialEntries={['/admin/catalog/7']}><Routes><Route path="/admin/catalog/:productId" element={<CatalogProductPage />} /></Routes></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Проверить для подбора' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/recheck') && call[1]?.method === 'POST')).toBe(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Проверить для подбора' })).toBeEnabled())
    fireEvent.click(screen.getByLabelText('Разрешить участие в подборе при успешной проверке'))
    expect(await screen.findByText('Исключён вручную')).toBeInTheDocument()
    expect(screen.getByLabelText('Разрешить участие в подборе при успешной проверке')).not.toBeChecked()
  })
  it('expands page attributes and opens the product card', async () => {
    render(<MemoryRouter initialEntries={['/admin/catalog']}><Routes><Route path="/admin/catalog" element={<CatalogPage />} /><Route path="/admin/catalog/:productId" element={<CatalogProductPage />} /></Routes></MemoryRouter>)
    await screen.findByRole('link', { name: 'Ryzen 7' })
    fireEvent.click(screen.getByRole('button', { name: 'Раскрыть все' }))
    expect(screen.getByText('AM5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Ryzen 7' }))
    expect(await screen.findByRole('heading', { name: 'Предложения источников' })).toBeInTheDocument()
    expect(screen.getByText('ID 7')).toHaveClass('catalog-product-id')
    expect(screen.getByText('Доступен для Конфигуратора').closest('.catalog-product-meta')).toHaveTextContent('SKU p1:7')
    expect(screen.queryByText(/ТОВАР CORELAB/)).not.toBeInTheDocument()
  })

  it('selects an existing value and saves it as manual input without a source URL', async () => {
    currentProduct.attributes[0].source_kind = 'manufacturer_site'
    currentProduct.attributes[0].source_url = 'https://amd.com/spec'
    render(<MemoryRouter initialEntries={['/admin/catalog/7']}><Routes><Route path="/admin/catalog/:productId" element={<CatalogProductPage />} /></Routes></MemoryRouter>)
    await screen.findByText('AM5')
    fireEvent.click(screen.getByRole('button', { name: 'Изменить Сокет' }))
    expect(screen.queryByLabelText('Источник')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Ссылка на источник')).not.toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('Выбрать существующее значение'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить Сокет' }))
    await screen.findByText('AM5+')
    const call = fetchMock.mock.calls.find(([url, options]) => String(url).includes('/attributes/socket') && options?.method === 'PATCH')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ value_state: 'known', value: 'AM5+', source_kind: 'manual', source_url: null })
    expect(screen.queryByRole('link', { name: 'Открыть' })).not.toBeInTheDocument()
  })

  it('deletes a product attribute only after confirmation', async () => {
    render(<MemoryRouter initialEntries={['/admin/catalog/7']}><Routes><Route path="/admin/catalog/:productId" element={<CatalogProductPage />} /></Routes></MemoryRouter>)
    await screen.findByText('AM5')
    fireEvent.click(screen.getByRole('button', { name: 'Удалить Сокет' }))
    expect(screen.getByRole('dialog', { name: 'Удалить свойство товара' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith('/attributes/socket') && options?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить удаление' }))
    await waitFor(() => expect(screen.queryByText('AM5')).not.toBeInTheDocument())
    const call = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith('/attributes/socket') && options?.method === 'DELETE')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ expected_value_state: 'known', expected_value: 'AM5', expected_source_kind: 'manual', expected_source_url: null })
  })

  it('cancels without writing and can add a category-defined property', async () => {
    render(<MemoryRouter initialEntries={['/admin/catalog/7']}><Routes><Route path="/admin/catalog/:productId" element={<CatalogProductPage />} /></Routes></MemoryRouter>)
    await screen.findByText('AM5')
    fireEvent.click(screen.getByRole('button', { name: 'Изменить Сокет' }))
    fireEvent.change(screen.getByLabelText('Значение свойства'), { target: { value: 'discarded' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отменить Сокет' }))
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/attributes/') && options?.method === 'PATCH')).toBe(false)
    fireEvent.change(screen.getByLabelText('Добавить свойство'), { target: { value: 'cores' } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
    fireEvent.change(screen.getByLabelText('Состояние'), { target: { value: 'known' } })
    fireEvent.change(screen.getByLabelText('Значение свойства'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить Число ядер' }))
    await screen.findByText('8')
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/attributes/cores') && options?.method === 'PATCH')).toBe(true)
  })

  it('filters by descendant category and configurator eligibility without category-setting controls', async () => {
    render(<MemoryRouter><CatalogPage /></MemoryRouter>)
    await screen.findByRole('link', { name: 'Ryzen 7' })
    fireEvent.click(screen.getByRole('button', { name: 'Развернуть Комплектующие' }))
    fireEvent.click(screen.getByRole('button', { name: 'Процессоры' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).includes('category_id=2'))).toBe(true))
    expect(screen.getByRole('link', { name: 'Структура свойств' })).toHaveClass('catalog-properties-link')
    fireEvent.change(screen.getByLabelText('Допуск к конфигуратору'), { target: { value: 'true' } })
    await waitFor(() => expect(fetchMock.mock.calls.some(call => String(call[0]).includes('validity=true'))).toBe(true))
    expect(screen.getByText('Допуск к конфигуратору')).toBeInTheDocument()
    expect(screen.queryByLabelText('Подбор: Комплектующие')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Все товары' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(call => call[1]?.method === 'PATCH')).toBe(false))
  })
})
