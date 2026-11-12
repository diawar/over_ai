export type CatalogViewState = {
  query: string
  categoryQuery: string
  categoryId: number | null
  validity: string
  sort: string
  page: number
  pageSize: number
  openBranches: number[]
}

const defaults: CatalogViewState = { query: '', categoryQuery: '', categoryId: null, validity: 'all', sort: 'name', page: 1, pageSize: 25, openBranches: [] }
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

export function catalogViewKey() {
  try {
    const session = JSON.parse(sessionStorage.getItem('corelab_session') ?? 'null')
    return `corelab:catalog-view:${JSON.stringify([session?.organization?.id ?? null, session?.username ?? null])}`
  } catch { return 'corelab:catalog-view:anonymous' }
}

export function readCatalogView(key: string): CatalogViewState {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object') return { ...defaults }
    return {
      query: typeof value.query === 'string' ? value.query : '',
      categoryQuery: typeof value.categoryQuery === 'string' ? value.categoryQuery : '',
      categoryId: positiveId(value.categoryId) ? value.categoryId : null,
      validity: ['all', 'true', 'false', 'null'].includes(value.validity) ? value.validity : 'all',
      sort: ['name', 'price_asc', 'price_desc', 'required_desc', 'required_asc', 'pc_required_desc', 'pc_required_asc'].includes(value.sort) ? value.sort : 'name',
      page: positiveId(value.page) ? value.page : 1,
      pageSize: [25, 50, 100].includes(value.pageSize) ? value.pageSize : 25,
      openBranches: Array.isArray(value.openBranches) ? value.openBranches.filter(positiveId) : [],
    }
  } catch { return { ...defaults } }
}

export function saveCatalogView(key: string, value: CatalogViewState) {
  try { sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* Search remains usable when browser storage is unavailable. */ }
}
