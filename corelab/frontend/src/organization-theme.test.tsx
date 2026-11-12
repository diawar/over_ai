import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AdminLayout } from './pages'
import { E2E_COLOR, rememberColor, themeStyle } from './organization-theme'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })
function session(id = 1) { sessionStorage.setItem('corelab_session', JSON.stringify({ username:'admin', role:'chief_admin', organization:{id,name:'Test',short_name:'Test'} })) }
it('uses only the current organization cache on the first render and applies saved changes immediately', () => {
  session(); localStorage.setItem('corelab:brand-color:1','#fb7602')
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  const view = render(<MemoryRouter><AdminLayout /></MemoryRouter>)
  expect((view.container.querySelector('.admin-shell') as HTMLElement).style.getPropertyValue('--accent')).toBe('#fb7602')
  act(() => rememberColor(2, '#00aa00'))
  expect((view.container.querySelector('.admin-shell') as HTMLElement).style.getPropertyValue('--accent')).toBe('#fb7602')
  act(() => rememberColor(1, '#123456'))
  expect((view.container.querySelector('.admin-shell') as HTMLElement).style.getPropertyValue('--accent')).toBe('#123456')
})
it('shows neutral loading without a valid matching cache and uses the authenticated server color', async () => {
  session(2); localStorage.setItem('corelab:brand-color:1','#fb7602')
  let resolve!: (value: unknown) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r })))
  const view = render(<MemoryRouter><AdminLayout /></MemoryRouter>)
  expect(screen.getByRole('status')).toHaveTextContent('Загрузка оформления')
  expect(view.container.querySelector('.admin-shell')).toBeNull()
  await act(async () => resolve({ok:true,json:async()=>({username:'admin',role:'chief_admin',organization:{id:2,name:'Second',primary_color:'#005500'}})}))
  expect((view.container.querySelector('.admin-shell') as HTMLElement).style.getPropertyValue('--accent')).toBe('#005500')
  expect(localStorage.getItem('corelab:brand-color:2')).toBe('#005500')
})
it('ignores invalid colors and chooses readable text for light and dark backgrounds', () => {
  rememberColor(1, 'url(https://example.com)')
  expect(localStorage.getItem('corelab:brand-color:1')).toBeNull()
  expect(themeStyle('#fb7602')).toMatchObject({'--on-accent':'#171717'})
  expect(themeStyle('#222222')).toMatchObject({'--on-accent':'#ffffff'})
})

it('revalidates cached indigo and uses e2e until a saved company color arrives during setup', async () => {
  const current = {username:'admin',role:'chief_admin',onboarding_required:true,organization:{id:2,name:'New',primary_color:'#5146e5'}}
  sessionStorage.setItem('corelab_session',JSON.stringify(current))
  localStorage.setItem('corelab:brand-color:2','#5146e5')
  let resolve!: (value: unknown) => void
  vi.stubGlobal('fetch',vi.fn(()=>new Promise(r=>{resolve=r})))
  const view=render(<MemoryRouter initialEntries={['/admin/setup']}><AdminLayout /></MemoryRouter>)
  const shell=()=>view.container.querySelector('.admin-shell') as HTMLElement
  expect(shell().style.getPropertyValue('--accent')).toBe(E2E_COLOR)
  expect(screen.getByRole('img',{name:'Логотип e2e'})).toHaveTextContent('e2e')
  expect(view.container.querySelector('.brand')?.textContent).toBe('e2eend-to-end')
  await act(async()=>resolve({ok:true,json:async()=>({...current,organization:{...current.organization,primary_color:'#123456'}})}))
  expect(shell().style.getPropertyValue('--accent')).toBe('#123456')
  act(()=>rememberColor(2,'#5146e5'))
  expect(shell().style.getPropertyValue('--accent')).toBe('#5146e5')
})
