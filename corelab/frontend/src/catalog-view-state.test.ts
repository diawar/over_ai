import { afterEach, expect, it, vi } from 'vitest'
import { catalogViewKey, readCatalogView, saveCatalogView } from './catalog-view-state'

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear() })

it('isolates saved filters by organization and user', () => {
  sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'admin', organization: { id: 1 } }))
  const key = catalogViewKey()
  saveCatalogView(key, { ...readCatalogView(key), query: 'MSI' })
  sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'admin', organization: { id: 2 } }))
  expect(readCatalogView(catalogViewKey()).query).toBe('')
  sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'other', organization: { id: 1 } }))
  expect(readCatalogView(catalogViewKey()).query).toBe('')
  expect(readCatalogView(key).query).toBe('MSI')
})

it('rejects corrupt filters and tolerates unavailable browser storage', () => {
  sessionStorage.setItem('view', '{invalid')
  expect(readCatalogView('view').page).toBe(1)
  sessionStorage.setItem('view', JSON.stringify({ categoryId: -1, page: 0, pageSize: 999, sort: 'invalid', validity: 'invalid', openBranches: [1, null, '2', -3] }))
  expect(readCatalogView('view')).toMatchObject({ categoryId: null, page: 1, pageSize: 25, sort: 'name', validity: 'all', openBranches: [1] })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  expect(() => saveCatalogView(catalogViewKey(), readCatalogView('view'))).not.toThrow()
})
