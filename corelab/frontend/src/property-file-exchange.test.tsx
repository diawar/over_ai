import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PropertyFileExchange } from './property-file-exchange'

const request = vi.fn()
beforeEach(() => { vi.stubGlobal('fetch', request); request.mockReset(); sessionStorage.clear(); document.cookie = 'corelab_csrf=xls-test' })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('uploads for preview and applies only after confirmation', async () => {
  const applied = vi.fn()
  const preview = { applied: 0, properties: 1, products: 1, skipped: 2, error_count: 0, errors: [],
    can_apply: true, preview_token: 'signed-preview', items: [{ product: 'ASRock', property: 'Сокет', value: 'AM5' }] }
  request.mockResolvedValueOnce(new Response(JSON.stringify(preview)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ applied: 1, products: 1, skipped: 2, error_count: 0 })))
  render(<PropertyFileExchange categoryId={17} query="ASRock" onApplied={applied} />)
  const file = new File(['xls'], 'filled.xls', { type: 'application/vnd.ms-excel' })
  fireEvent.change(screen.getByLabelText('Загрузить заполненные характеристики XLS'), { target: { files: [file] } })
  expect(screen.getByRole('progressbar', { name: /Загружаем файл и проверяем/ })).toBeInTheDocument()
  await screen.findByRole('dialog')
  expect(applied).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.getByText('AM5')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Применить характеристики' }))
  expect(screen.getByRole('progressbar', { name: /Сохраняем характеристики/ })).toBeInTheDocument()
  await waitFor(() => expect(applied).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  expect(request.mock.calls[1][0]).toContain('apply=true')
  expect(request.mock.calls[1][1].headers['X-Import-Preview']).toBe('signed-preview')
  expect(request.mock.calls[1][1].headers['X-CSRF-Token']).toBe('xls-test')
})

it('keeps apply disabled when a row has a validation error', async () => {
  request.mockResolvedValue(new Response(JSON.stringify({ applied: 0, properties: 0, products: 0, skipped: 0,
    error_count: 1, errors: [{ sheet: 'Характеристики 1', row: 2, message: 'Ожидается целое число' }],
    can_apply: false, preview_token: '', items: [] })))
  render(<PropertyFileExchange categoryId={null} query="" onApplied={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Загрузить заполненные характеристики XLS'), {
    target: { files: [new File(['xls'], 'filled.xls')] },
  })
  await screen.findByRole('dialog')
  expect(screen.getByRole('button', { name: 'Применить характеристики' })).toBeDisabled()
  expect(screen.getByText(/строка 2: Ожидается целое число/)).toBeInTheDocument()
})

it('rejects files in a different format before making a request', async () => {
  render(<PropertyFileExchange categoryId={null} query="" onApplied={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Загрузить заполненные характеристики XLS'), {
    target: { files: [new File(['csv'], 'filled.csv')] },
  })
  await screen.findByRole('alert')
  expect(request).not.toHaveBeenCalled()
})

it('downloads the filtered archive of ten-product XLS parts', async () => {
  request.mockResolvedValue(new Response('zip', { headers: { 'X-Property-Rows': '42' } }))
  const create = vi.fn(() => 'blob:parts')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  render(<PropertyFileExchange categoryId={17} query="ASRock" onApplied={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Скачать XLS по 10 товаров' }))
  await screen.findByText(/Архив подготовлен/)
  const url = new URL(request.mock.calls[0][0], 'http://localhost')
  expect(url.searchParams.get('archive')).toBe('true')
  expect(url.searchParams.get('category_id')).toBe('17')
  expect(url.searchParams.get('q')).toBe('ASRock')
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('corelab-missing-properties.zip')
  expect(screen.getByText(/Строк для заполнения: 42/)).toBeInTheDocument()
  click.mockRestore()
})

it('accepts a ZIP archive for preview and sends it as ZIP', async () => {
  request.mockResolvedValue(new Response(JSON.stringify({ applied: 0, properties: 2, products: 2,
    skipped: 0, error_count: 0, errors: [], can_apply: true, preview_token: 'zip-preview', items: [] })))
  render(<PropertyFileExchange categoryId={null} query="" onApplied={vi.fn()} />)
  const input = screen.getByLabelText('Загрузить заполненные характеристики XLS')
  expect(input.getAttribute('accept')).toContain('.zip')
  fireEvent.change(input, { target: { files: [new File(['zip'], 'filled.zip')] } })
  await screen.findByRole('dialog')
  expect(screen.getByText('filled.zip')).toBeInTheDocument()
  expect(request.mock.calls[0][1].headers['Content-Type']).toBe('application/zip')
  expect(screen.getByRole('button', { name: 'Применить характеристики' })).toBeEnabled()
})

it('shows a clear error when the server returns plain text instead of JSON', async () => {
  request.mockResolvedValue(new Response('Internal Server Error', { status: 500 }))
  render(<PropertyFileExchange categoryId={null} query="" onApplied={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Загрузить заполненные характеристики XLS'), {
    target: { files: [new File(['zip'], 'filled.zip')] },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка сервера при обработке файла (500)')
})
