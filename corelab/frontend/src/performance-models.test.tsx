import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PerformanceModelsPage } from './performance-models'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('shows unrated models, exact product links and changes workload without stale data', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ total: 1, summary: { models: 2, pending: 1, products: 3 },
    items: [{ type: 'gpu', model: 'Radeon AI PRO R9700', memory_gb: 32, status: 'not_evaluated', evidence: [],
      products: [{ id: 42, name: 'Gigabyte AI PRO', sku: '123', selection_enabled: true, validity_check: true }] }] }) }))
  vi.stubGlobal('fetch', fetch)
  render(<MemoryRouter><PerformanceModelsPage /></MemoryRouter>)
  expect(await screen.findByText('Производительность не оценена')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Gigabyte AI PRO' })).toHaveAttribute('href', '/admin/catalog/42')
  fireEvent.change(screen.getByLabelText('Сценарий'), { target: { value: 'photoshop' } })
  expect(screen.getByText(/Учитываются только тесты выбранной программы/)).toBeInTheDocument()
  await waitFor(() => expect(fetch.mock.calls.length).toBe(2))
})
