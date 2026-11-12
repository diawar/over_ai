import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourcesPage } from './sources'

const product = { id: 1, sku: '123', name: 'Процессор Ryzen', article: 'AMD-123', manufacturer: 'AMD', category: 'Процессоры', price: 65000, price_bonus: null, price_special: 0, archived: false, is_current: true, warehouses: ['Склад Алматы (3)'], link_status: 'linked', core_product_id: 4, core_product_name: 'Процессор Ryzen' }
const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/sources') ? { items: [{ id: 1, code: 'p1', name: 'p1.overclockers.kz', total: 30, downloaded_at: null }] } : { items: [product], total: 30, categories: ['Процессоры'] } }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset() })

describe('supplier browsing', () => {
  it('shows a retained snapshot and its CoreLab links without update controls', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/sources')
      ? { items: [{ id: 1, code: 'p1', name: 'p1.overclockers.kz', is_active: false, total: 30, downloaded_at: '2026-10-15T03:26:19Z' }] }
      : { items: [product], total: 30, categories: ['Процессоры'] } }))
    render(<SourcesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Процессор Ryzen' }))
    expect(screen.getByText('Сохранённый снимок')).toBeInTheDocument()
    expect(screen.getByText(/Подключение к источнику отключено/)).toBeInTheDocument()
    expect(screen.getByText('Связано: Процессор Ryzen · ID 4')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Обновить' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Автообновление' })).not.toBeInTheDocument()
  })
  it('does nothing when selecting the current supplier, including with filters and pagination', async () => {
    render(<SourcesPage />)
    await screen.findByRole('button', { name: 'Процессор Ryzen' })
    // Let the initial search debounce settle before checking request counts.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    const selectedSource = screen.getByRole('button', { name: /p1.overclockers.kz/ })
    let requestCount = fetchMock.mock.calls.length
    fireEvent.click(selectedSource)
    expect(screen.getByRole('button', { name: 'Процессор Ryzen' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)

    fireEvent.change(screen.getByLabelText('Поиск товаров'), { target: { value: 'AMD' } })
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('q=AMD'))
    fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'Процессоры' } })
    await screen.findByRole('button', { name: 'Процессор Ryzen' })
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    await screen.findByRole('button', { name: 'Процессор Ryzen' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    requestCount = fetchMock.mock.calls.length
    fireEvent.click(selectedSource)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(screen.getByLabelText('Поиск товаров')).toHaveValue('AMD')
    expect(screen.getByLabelText('Категория')).toHaveValue('Процессоры')
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Процессор Ryzen' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(requestCount)

  })
  it('still loads another supplier when its button is clicked', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith('/sources')
      ? { items: [{ id: 1, code: 'p1', name: 'Supplier One', total: 30, downloaded_at: null }, { id: 2, code: 'p2', name: 'Supplier Two', total: 1, downloaded_at: null }] }
      : { items: [{ ...product, name: url.includes('/sources/2/') ? 'Second supplier CPU' : product.name }], total: 1, categories: ['Процессоры'] } }))
    render(<SourcesPage />)
    await screen.findByRole('button', { name: 'Процессор Ryzen' })
    fireEvent.click(screen.getByRole('button', { name: /Supplier Two/ }))
    expect(await screen.findByRole('button', { name: 'Second supplier CPU' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Supplier Two/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Процессор Ryzen' })).not.toBeInTheDocument()
  })
  it('shows supplier prices and opens original warehouse details', async () => {
    render(<SourcesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Процессор Ryzen' }))
    expect(screen.getByRole('dialog')).toHaveAttribute('open')
    expect(screen.getByText('Склад Алматы (3)')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Закрыть карточку'))
    expect(screen.queryByText('Склад Алматы (3)')).not.toBeInTheDocument()
  })
  it('sends pagination, search and filters to the API and resets the page', async () => {
    render(<SourcesPage />)
    await screen.findByRole('button', { name: 'Процессор Ryzen' })
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('page=2'))
    fireEvent.change(screen.getByLabelText('Категория'), { target: { value: 'Процессоры' } })
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('page=1'))
    fireEvent.change(screen.getByLabelText('Поиск товаров'), { target: { value: 'AMD-123' } })
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('q=AMD-123'))
  })
  it('shows an honest empty state before import', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    render(<SourcesPage />)
    expect(await screen.findByText('Здесь появится прайс-лист')).toBeInTheDocument()
    expect(screen.queryByText('p1.overclockers.kz')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
  it('offers retry after a failed request', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Сервер недоступен'))
    render(<SourcesPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('button', { name: 'Процессор Ryzen' })).toBeInTheDocument()
  })
})
