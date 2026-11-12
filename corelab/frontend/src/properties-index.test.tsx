import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PropertiesIndexPage } from './properties-index'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('finds categories, filters empty structures and links to the existing editor', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [
    { id: 1, parent_id: null, name: 'Комплектующие', selection_category: false, property_count: 0 },
    { id: 2, parent_id: 1, name: 'Процессоры', selection_category: true, property_count: 10 },
    { id: 3, parent_id: 1, name: 'Видеокарты', selection_category: false, property_count: 0 },
  ] }) })))
  render(<MemoryRouter><PropertiesIndexPage /></MemoryRouter>)
  expect(await screen.findByRole('link', { name: 'Процессоры' })).toHaveAttribute('href', '/admin/categories/2/properties')
  expect(screen.getByText('Комплектующие / Процессоры')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Фильтр свойств'), { target: { value: 'configured' } })
  expect(screen.queryByRole('link', { name: 'Видеокарты' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Фильтр свойств'), { target: { value: 'all' } })
  fireEvent.change(screen.getByLabelText('Поиск категории'), { target: { value: 'видео' } })
  expect(screen.getByRole('link', { name: 'Видеокарты' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Процессоры' })).not.toBeInTheDocument()
})
