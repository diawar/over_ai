import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { adminFetch } from './admin-fetch'
import { RegistrationPage } from './registration'
import { OnboardingPage } from './onboarding'
import { PlatformUsersPage } from './platform-users'
import { AdminLayout } from './pages'

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals() })

it('sends the current tab context only to this API, preserving CSRF and not leaking to external hosts', async () => {
  const fetcher = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetcher)
  sessionStorage.setItem('corelab_session', JSON.stringify({ organization_context: 'signed-A' }))
  await adminFetch('/api/v1/admin/catalog', { headers: { 'X-CSRF-Token': 'csrf' } })
  const headers = (fetcher.mock.calls[0] as any)[1].headers as Headers
  expect(headers.get('X-CoreLab-Organization-Context')).toBe('signed-A')
  expect(headers.get('X-CSRF-Token')).toBe('csrf')
  await adminFetch('https://example.com/api/v1/admin/catalog')
  expect((fetcher.mock.calls[1] as any)[1]).toBeUndefined()
  await adminFetch('/api/v1/admin/auth/logout')
  expect((fetcher.mock.calls[2] as any)[1]).toBeUndefined()
  sessionStorage.setItem('corelab_session', JSON.stringify({ organization_context: 'signed-B' }))
  await adminFetch('/api/v1/admin/catalog')
  expect(((fetcher.mock.calls[3] as any)[1].headers as Headers).get('X-CoreLab-Organization-Context')).toBe('signed-B')
})

it('registration marks required fields and rejects different passwords without sending a request', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  render(<MemoryRouter><RegistrationPage /></MemoryRouter>)
  fireEvent.change(screen.getByLabelText('Название организации *'), { target: { value: 'Company' } })
  fireEvent.change(screen.getByLabelText('Логин главного админа *'), { target: { value: 'chief' } })
  fireEvent.change(screen.getByLabelText('Пароль *'), { target: { value: 'long-password-one' } })
  fireEvent.change(screen.getByLabelText('Повторите пароль *'), { target: { value: 'long-password-two' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Зарегистрировать компанию' }).closest('form')!)
  expect(screen.getByRole('alert')).toHaveTextContent('Пароли не совпадают')
  expect(fetcher).not.toHaveBeenCalled()
})

it('onboarding displays logistics only when mini app is enabled and cannot skip missing fields', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: !url.endsWith('/complete'), json: async () => url.endsWith('/operations') ? {version:0,assembly_workdays:2,branches:[],routes:[]} : url.endsWith('/complete') ? {detail:{missing:['Логотип организации']}} : {required:true,name:'Company',short_name:'Co',username:'chief',mini_app_enabled:false,logo_url:null,missing:['Логотип организации']} })))
  render(<OnboardingPage />)
  expect(await screen.findByLabelText('Название организации *')).toBeRequired()
  expect(screen.queryByText('Филиалы, сроки и календари')).not.toBeInTheDocument()
  fireEvent.click(screen.getByLabelText('Включить мини-приложение'))
  expect(await screen.findByLabelText('Время на сборку, рабочих дней *')).toBeRequired()
  expect(screen.getByRole('button',{name:'Завершить настройку'})).toBeDisabled()
})

it('platform menu and session refresh retain the signed organization context', async () => {
  sessionStorage.setItem('corelab_session',JSON.stringify({username:'owner',role:'platform_admin',organization_context:'signed',organization:{id:2,name:'Two',primary_color:'#123456'}}))
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({username:'owner',role:'platform_admin',organization:{id:2,name:'Two',primary_color:'#123456'}})})))
  render(<MemoryRouter><AdminLayout /></MemoryRouter>)
  expect(screen.getByRole('link',{name:'Пользователи CoreLab'})).toBeInTheDocument()
  await waitFor(()=>expect(JSON.parse(sessionStorage.getItem('corelab_session')!).organization_context).toBe('signed'))
})

it('locks workspace navigation and keeps e2e branding until organization setup is complete', async () => {
  const session = {username:'chief',role:'chief_admin',onboarding_required:true,organization:{id:3,name:'Company',short_name:'Changed name',logo_url:'/company.png',primary_color:'#123456'}}
  sessionStorage.setItem('corelab_session',JSON.stringify(session))
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>session})))
  render(<MemoryRouter initialEntries={['/admin/catalog']}><Routes><Route path="/admin" element={<AdminLayout />}><Route path="setup" element={<h1>Setup form</h1>} /><Route path="catalog" element={<h1>Catalog content</h1>} /></Route></Routes></MemoryRouter>)
  expect(await screen.findByRole('heading',{name:'Setup form'})).toBeInTheDocument()
  expect(screen.getByRole('img',{name:'Логотип e2e'})).toBeInTheDocument()
  for (const name of ['Каталог','Свойства и значения','Источники','Журнал','Настройки']) {
    const item = screen.getByRole('link',{name})
    expect(item).toHaveAttribute('aria-disabled','true')
    expect(item).not.toHaveAttribute('href')
    fireEvent.click(item)
  }
  expect(screen.getByRole('heading',{name:'Setup form'})).toBeInTheDocument()
  expect(screen.queryByRole('heading',{name:'Catalog content'})).not.toBeInTheDocument()
})

it('restores workspace links and company branding after setup', async () => {
  const session = {username:'chief',role:'chief_admin',onboarding_required:false,organization:{id:3,name:'Company',short_name:'Brand',logo_url:'/company.png',primary_color:'#123456'}}
  sessionStorage.setItem('corelab_session',JSON.stringify(session))
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>session})))
  render(<MemoryRouter initialEntries={['/admin/catalog']}><AdminLayout /></MemoryRouter>)
  expect(await screen.findByRole('img',{name:'Brand'})).toHaveAttribute('src','/company.png')
  expect(screen.getByRole('link',{name:'Каталог'})).toHaveAttribute('href','/admin/catalog')
  expect(screen.getByRole('link',{name:'Каталог'})).not.toHaveAttribute('aria-disabled')
})

it('user management lists three role labels and protects passwords from being prefilled', async () => {
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>url.endsWith('/users')?{items:[{id:2,username:'member',role:'admin',organization_id:1,organization_name:'Company',is_active:true}]}:{items:[{id:1,name:'Company'}]}})))
  render(<PlatformUsersPage />)
  expect(await screen.findByText('member')).toBeInTheDocument()
  expect(screen.getByText('Пользователь · Company')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Изменить'}))
  expect(screen.getByLabelText('Новый временный пароль (необязательно)')).toHaveValue('')
  expect(screen.getByRole('option',{name:'Администратор CoreLab'})).toBeInTheDocument()
})
