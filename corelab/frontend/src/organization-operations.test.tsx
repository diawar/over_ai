import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { OrganizationOperations } from './organization-operations'
const initial = { version: 0, assembly_workdays: 2, branches: [{code:'TEST', name:'Тестовый склад', city:'Алматы', address:'', active:true, weekly_days_off:[5,6], calendar_exceptions:[]}], routes: [] }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear() })
it('adds a nonworking date, saves it with CSRF, and restores it on reload', async () => {
  let stored: any = structuredClone(initial)
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'PUT') stored = { ...JSON.parse(String(init.body)), version: 1 }
    return { ok: true, json: async () => stored }
  })
  vi.stubGlobal('fetch', fetcher); document.cookie = 'corelab_csrf=calendar-test'
  const view = render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить филиал Тестовый склад'}))
  fireEvent.change(screen.getByLabelText('Дата'), {target:{value:'2026-11-02'}})
  fireEvent.change(screen.getByLabelText('Причина (необязательно)'), {target:{value:'Закрыто'}})
  fireEvent.click(screen.getByText('Добавить дату'))
  fireEvent.click(screen.getByText('Сохранить изменения филиалов и складов'))
  await screen.findByText('Филиалы, сроки и календари сохранены.')
  expect(stored.branches[0].calendar_exceptions).toEqual([{date:'2026-11-02',working:false,note:'Закрыто'}])
  expect(fetcher.mock.calls.find(([,init])=>init.method==='PUT')?.[1].headers).toMatchObject({'X-CSRF-Token':'calendar-test'})
  view.unmount(); render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить филиал Тестовый склад'}))
  expect(screen.getByText('02.11.2026')).toBeInTheDocument()
  expect(screen.getByLabelText('Тип дня 2026-11-02')).toHaveValue('off')
})
it('prevents duplicate dates and preserves edits on a save conflict', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => ({ok: init.method !== 'PUT',json:async()=>init.method==='PUT'?{detail:'Настройки изменены в другой вкладке'}:initial})))
  render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить филиал Тестовый склад'}))
  fireEvent.change(screen.getByLabelText('Дата'), {target:{value:'2026-11-02'}})
  fireEvent.click(screen.getByText('Добавить дату'))
  fireEvent.change(screen.getByLabelText('Дата'), {target:{value:'2026-11-02'}})
  fireEvent.click(screen.getByText('Добавить дату'))
  expect(screen.getByRole('alert')).toHaveTextContent('Эта дата уже добавлена')
  fireEvent.click(screen.getByText('Сохранить изменения филиалов и складов'))
  expect(await screen.findByText('Настройки изменены в другой вкладке')).toBeInTheDocument()
  expect(screen.getByText('02.11.2026')).toBeInTheDocument()
})
it('regular admin can read but cannot change calendar', async () => {
  vi.stubGlobal('fetch', vi.fn(async()=>({ok:true,json:async()=>initial})))
  render(<OrganizationOperations editable={false} />)
  expect(await screen.findByLabelText('Дата')).toBeDisabled()
  expect(screen.queryByText('Сохранить изменения филиалов и складов')).not.toBeInTheDocument()
})

const matrixData = { ...initial, branches: [
  { code:'A', name:'A', city:'Алматы', address:'ул. Тестовая, 1', kind:'supplier_warehouse', active:true, weekly_days_off:[5,6], calendar_exceptions:[] },
  { code:'B', name:'B', city:'Астана', address:'', kind:'branch', active:true, weekly_days_off:[5,6], calendar_exceptions:[] },
], routes:[{ from_branch:'A', to_branch:'B', workdays:5 }] }

it('keeps each warehouse calendar independent and has no shared calendar', async () => {
  let stored: any = structuredClone(matrixData)
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init.method === 'PUT') stored = JSON.parse(init.body)
    return {ok:true,json:async()=>stored}
  }))
  const view = render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить склад A'}))
  fireEvent.click(screen.getByRole('button',{name:'Изменить филиал B'}))
  expect(screen.queryByText('Календарь организации')).not.toBeInTheDocument()
  const a = within(screen.getByRole('group',{name:'Календарь A'}))
  const b = within(screen.getByRole('group',{name:'Календарь B'}))
  fireEvent.click(a.getByLabelText('Суббота'))
  expect(b.getByLabelText('Суббота')).toBeChecked()
  for (const group of [a, b]) {
    fireEvent.change(group.getByLabelText('Дата'), {target:{value:'2026-11-02'}})
    fireEvent.click(group.getByRole('button',{name:'Добавить дату'}))
  }
  fireEvent.change(a.getByLabelText('Тип дня 2026-11-02'), {target:{value:'work'}})
  expect(b.getByLabelText('Тип дня 2026-11-02')).toHaveValue('off')
  fireEvent.click(screen.getByRole('button',{name:'Сохранить изменения филиалов и складов'}))
  await screen.findByText('Филиалы, сроки и календари сохранены.')
  expect(stored.weekly_days_off).toBeUndefined()
  expect(stored.branches[0].weekly_days_off).toEqual([6])
  expect(stored.branches[1].weekly_days_off).toEqual([5,6])
  view.unmount(); render(<OrganizationOperations editable={false} />)
  const restored = within(await screen.findByRole('group',{name:'Календарь A'}))
  expect(restored.getByLabelText('Суббота')).not.toBeChecked()
  expect(restored.getByLabelText('Суббота')).toBeDisabled()
})

it('edits directed routes in the matrix, disables removed routes and saves zero days', async () => {
  let stored = matrixData
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'PUT') stored = JSON.parse(String(init.body))
    return {ok:true,json:async()=>stored}
  })
  vi.stubGlobal('fetch', fetcher)
  render(<OrganizationOperations editable />)
  expect(await screen.findByLabelText('Рабочих дней A → B')).toHaveValue(5)
  expect(screen.getByLabelText('Рабочих дней B → A')).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Разрешить A → B'))
  expect(screen.getByLabelText('Рабочих дней A → B')).toBeDisabled()
  expect(fetcher).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button',{name:'Отменить изменения'}))
  expect(screen.getByLabelText('Рабочих дней A → B')).toHaveValue(5)
  fireEvent.click(screen.getByLabelText('Разрешить B → A'))
  fireEvent.change(screen.getByLabelText('Рабочих дней B → A'), {target:{value:'0'}})
  fireEvent.click(screen.getByRole('button',{name:'Сохранить изменения филиалов и складов'}))
  await screen.findByText('Филиалы, сроки и календари сохранены.')
  expect(stored.routes).toEqual(expect.arrayContaining([
    {from_branch:'A',to_branch:'B',workdays:5}, {from_branch:'B',to_branch:'A',workdays:0},
  ]))
})

it('updates the matrix on branch activation, code changes, addition and deletion', async () => {
  vi.stubGlobal('fetch', vi.fn(async()=>({ok:true,json:async()=>matrixData})))
  render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить склад A'}))
  fireEvent.click(screen.getAllByLabelText('Активный филиал / склад')[0])
  expect(screen.getByLabelText('Рабочих дней A → B')).toBeDisabled()
  expect(screen.getByLabelText('Разрешить B → A')).toBeDisabled()
  fireEvent.click(screen.getAllByLabelText('Активный филиал / склад')[0])
  expect(screen.getByLabelText('Рабочих дней A → B')).toHaveValue(5)
  fireEvent.change(screen.getAllByLabelText('Код филиала / склада')[0],{target:{value:'A_NEW'}})
  expect(screen.getByLabelText('Рабочих дней A → B')).toHaveValue(5)
  fireEvent.click(screen.getByRole('button',{name:'Добавить филиал / склад'}))
  expect(screen.getByLabelText('Разрешить A → Новая точка')).toBeDisabled()
  fireEvent.change(screen.getAllByLabelText('Код филиала / склада')[2],{target:{value:'C'}})
  fireEvent.change(screen.getAllByLabelText('Название')[2],{target:{value:'C'}})
  expect(screen.getByLabelText('Разрешить A → C')).toBeEnabled()
  fireEvent.click(screen.getByRole('button',{name:'Удалить склад A'}))
  expect(screen.queryByLabelText('Разрешить A → B')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Разрешить B → C')).toBeEnabled()
  fireEvent.click(screen.getByRole('button',{name:'Отменить изменения'}))
  expect(screen.getByLabelText('Рабочих дней A → B')).toHaveValue(5)
  expect(screen.queryByLabelText('Разрешить B → C')).not.toBeInTheDocument()
})

it('restores unsaved address, calendar and route drafts after reload, then saves and clears them', async () => {
  sessionStorage.setItem('corelab_session', JSON.stringify({organization:{id:1},username:'chief'}))
  let stored: any = structuredClone(matrixData)
  const fetcher = vi.fn(async (_url, init) => {
    if (init.method === 'PUT') stored = {...JSON.parse(init.body),version:1}
    return {ok:true,json:async()=>stored}
  })
  vi.stubGlobal('fetch',fetcher)
  let view = render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить склад A'}))
  fireEvent.change(screen.getAllByLabelText('Адрес')[0],{target:{value:'Новый адрес, 12'}})
  fireEvent.change(screen.getByLabelText('Время на сборку, рабочих дней'),{target:{value:'3'}})
  fireEvent.click(within(screen.getByRole('group',{name:'Календарь A'})).getByLabelText('Суббота'))
  fireEvent.change(screen.getByLabelText('Рабочих дней A → B'),{target:{value:'7'}})
  expect(fetcher.mock.calls.some(([,init])=>init.method==='PUT')).toBe(false)
  view.unmount(); view = render(<OrganizationOperations editable />)
  await screen.findByText('Восстановлен несохранённый черновик. Нажмите «Сохранить изменения филиалов и складов», чтобы применить его.')
  fireEvent.click(screen.getByRole('button',{name:'Изменить склад A'}))
  expect(screen.getAllByLabelText('Адрес')[0]).toHaveValue('Новый адрес, 12')
  expect(screen.getByLabelText('Рабочих дней A → B')).toHaveValue(7)
  expect(screen.getByLabelText('Время на сборку, рабочих дней')).toHaveValue(3)
  expect(within(screen.getByRole('group',{name:'Календарь A'})).getByLabelText('Суббота')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button',{name:'Сохранить изменения: склад A'}))
  await screen.findByText('Филиалы, сроки и календари сохранены.')
  expect(stored.branches[0].address).toBe('Новый адрес, 12')
  expect(stored.routes[0].workdays).toBe(7)
  expect(sessionStorage.getItem('corelab:operations-draft:[1,"chief"]')).toBeNull()
  view.unmount(); render(<OrganizationOperations editable />)
  fireEvent.click(await screen.findByRole('button',{name:'Изменить склад A'}))
  expect(screen.getAllByLabelText('Адрес')[0]).toHaveValue('Новый адрес, 12')
  expect(screen.getByRole('button',{name:'Сохранить изменения: склад A'})).toBeDisabled()
})

it('does not apply a draft to another organization, preserves stale version and clears on cancel', async () => {
  const key = 'corelab:operations-draft:[1,"chief"]'
  const draft = {...structuredClone(matrixData),assembly_workdays:9}
  sessionStorage.setItem(key,JSON.stringify(draft))
  sessionStorage.setItem('corelab_session',JSON.stringify({organization:{id:2},username:'chief'}))
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({...matrixData,version:4})})))
  let view = render(<OrganizationOperations editable />)
  expect(await screen.findByLabelText('Время на сборку, рабочих дней')).toHaveValue(2)
  view.unmount()
  sessionStorage.setItem('corelab_session',JSON.stringify({organization:{id:1},username:'chief'}))
  view = render(<OrganizationOperations editable />)
  expect(await screen.findByLabelText('Время на сборку, рабочих дней')).toHaveValue(9)
  expect(screen.getAllByText(/настройки на сервере уже изменились/).length).toBeGreaterThan(0)
  expect(JSON.parse(sessionStorage.getItem(key)!).version).toBe(0)
  fireEvent.click(screen.getByRole('button',{name:'Отменить изменения'}))
  expect(screen.getByLabelText('Время на сборку, рабочих дней')).toHaveValue(2)
  expect(sessionStorage.getItem(key)).toBeNull()
})
