import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AdminLayout, LoginPage } from './pages'

describe('admin routing smoke', () => {
  it('shows login screen', () => {
    render(<MemoryRouter initialEntries={['/admin/login']}><LoginPage /></MemoryRouter>)
    expect(document.title).toBe('Вход для администратора — e2e')
    expect(screen.getByRole('heading', { name: 'Войти в систему' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'e2e end-to-end — на главную' })).toHaveAttribute('href', '/')
    expect(screen.getByLabelText('Логин')).toBeInTheDocument()
    expect(screen.getByLabelText('Пароль')).toBeInTheDocument()
  })

  it('redirects unauthenticated admin routes to login', async () => {
    sessionStorage.clear()
    render(<MemoryRouter initialEntries={['/admin/catalog']}><Routes><Route path="/admin/login" element={<LoginPage />} /><Route path="/admin" element={<AdminLayout />}><Route path="catalog" element={<h1>Каталог</h1>} /></Route></Routes></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: 'Войти в систему' })).toBeInTheDocument()
  })
})
