import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LogsPage } from './logs'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows saved job progress and filters paginated events', async () => {
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url)
    if (url.includes('/logs/imports')) return { ok: true, json: async () => ({ items: [{ id: 3, source_id: 1, status: 'completed', expected: 30, imported: 30, started_at: '2026-10-18T10:00:00+00:00', finished_at: '2026-10-18T10:00:01+00:00' }], total: 1, page: 1, page_size: 5 }) }
    if (url.includes('/logs/jobs')) return { ok: true, json: async () => ({ items: [{
      id: 8, status: 'running', total: 2, completed: 1, skipped: 0, failed: 0, initiated_by: 'admin-two',
      created_at: '2026-10-18T10:00:00+00:00', items: [
        { product_id: 7, status: 'completed', reason: null, property_count: 3 },
        { product_id: 9, status: 'running', reason: null, property_count: null },
      ],
    }], total: 1, page: 1, page_size: 5 }) }
    const params = new URL(url, 'http://localhost').searchParams
    return { ok: true, json: async () => ({ items: [{
      id: Number(params.get('page') ?? 1), action: 'properties.ai_load_skipped', status: 'skipped', author: 'Система', initiated_by: 'admin-two',
      object_type: 'product', object_id: '7', created_at: '2026-10-18T10:00:00+00:00',
      reason: 'Товар больше не относится к выбранной категории', property_count: 0,
      job_id: 8, error_count: null, warning_count: null,
    }, {
      id: 99, action: 'properties.ai_structure_generated', status: 'completed', author: 'admin-two', initiated_by: null,
      object_type: 'category', object_id: '124', created_at: '2026-10-18T10:00:00+00:00', reason: null,
      property_count: null, job_id: 9, error_count: null, warning_count: null,
      sources: [{ url: 'https://www.asus.com/motherboards/model-a/', label: 'www.asus.com' }],
    }], total: 26, page: Number(params.get('page') ?? 1), page_size: 25 }) }
  }))
  render(<MemoryRouter><LogsPage /></MemoryRouter>)
  expect((await screen.findAllByText('Задание #8')).length).toBeGreaterThan(0)
  expect(screen.getByLabelText('Прогресс задания 8')).toHaveAttribute('value', '1')
  expect(screen.getByText('Товар пропущен')).toBeInTheDocument()
  expect(screen.getByText('Сайты источников:')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'www.asus.com' })).toHaveAttribute('href', 'https://www.asus.com/motherboards/model-a/')
  expect(screen.getByText(/Импорт #3/)).toBeInTheDocument()
  expect(screen.getByRole('columnheader', { name: 'Автор' })).toBeInTheDocument()
  expect(screen.getAllByText('Запустил: admin-two').length).toBeGreaterThan(0)
  fireEvent.change(screen.getByLabelText('Тип события'), { target: { value: 'load' } })
  await waitFor(() => expect(requests.some(url => url.includes('kind=load'))).toBe(true))
  fireEvent.click(screen.getAllByRole('button', { name: 'Далее' }).at(-1)!)
  await waitFor(() => expect(requests.some(url => url.includes('kind=load') && url.includes('page=2'))).toBe(true))
  fireEvent.change(screen.getByLabelText('Статус события'), { target: { value: 'skipped' } })
  await waitFor(() => expect(requests.some(url => url.includes('status=skipped'))).toBe(true))
  fireEvent.change(screen.getByLabelText('ID товара'), { target: { value: '7' } })
  await waitFor(() => expect(requests.some(url => url.includes('product_id=7'))).toBe(true))
})
