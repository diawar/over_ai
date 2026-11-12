import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import './catalog.css'
import { SelectionCheck } from './selection-check'
import { PropertyFileExchange } from './property-file-exchange'
import { ProductPropertyCheck } from './properties'
import { ProductAttributesEditor, type AttributeOption, type AttributeValue } from './product-attributes'
import { catalogViewKey, readCatalogView, saveCatalogView } from './catalog-view-state'

const API = import.meta.env.VITE_API_URL ?? ''
type Attribute = AttributeValue
type Category = { id: number; parent_id: number | null; name: string; valid: number; total: number; selection_category?: boolean }
type Completeness = { filled: number; total: number; percent: number | null }
type Product = { id: number; sku: string; name: string; article: string | null; manufacturer: string | null; categories: { id: number; name: string }[]; status: string; validity_check: boolean | null; selection_enabled: boolean; current_offer_count: number; current_price: string | null; currency: string; attributes: Attribute[]; required_value_completeness?: Completeness; pc_selection_completeness?: Completeness }
type Result = { items: Product[]; total: number; validity_counts?: { all: number; true: number; false: number; null: number } }
type Detail = Pick<Product, 'id' | 'sku' | 'name' | 'article' | 'manufacturer' | 'categories' | 'status' | 'validity_check' | 'selection_enabled' | 'attributes'> & { ai_load_allowed: boolean; available_attributes: AttributeOption[]; validation_reasons: string[]; offers: { source: string; sku: string; price: string | null; currency: string; is_current: boolean }[] }
type BulkDraft = { code: string; value_state: 'known' | 'unknown' | 'not_applicable'; value: unknown; source_kind: string; source_url: string }
type BulkPreview = { attribute: { code: string; label: string; value_type: string; unit: string | null }; value_state: string; value: unknown; selected_count: number; overwrite_count: number; insert_count: number; items: { product_id: number; name: string; sku: string; category: string | null; will_overwrite: boolean; previous: { value_state: string; value: unknown; source_kind: string | null; source_url: string | null } | null }[]; preview_token: string }
const count = (n: number) => n.toLocaleString('ru-RU')
const price = (value: string | null, currency = 'KZT') => value == null || Number(value) === 0 ? 'Не указана' : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${currency === 'KZT' ? '₸' : currency}`
const valueText = (item: Attribute) => item.value_state === 'unknown' ? 'Неизвестно' : item.value_state === 'not_applicable' ? 'Не применимо' : item.value == null ? 'Не указано' : typeof item.value === 'object' ? JSON.stringify(item.value) : typeof item.value === 'boolean' ? item.value ? 'Да' : 'Нет' : String(item.value)
const csrfToken = () => decodeURIComponent(document.cookie.split('; ').find(part => part.startsWith('corelab_csrf='))?.split('=').slice(1).join('=') ?? '')

function Attributes({ items }: { items: Attribute[] }) {
  if (!items.length) return <p className="catalog-muted">Технические характеристики пока не заполнены.</p>
  return <dl className="catalog-attributes">{items.map(item => <div key={item.code}><dt>{item.label}</dt><dd>{valueText(item)}{item.value_state === 'known' && item.value != null && item.unit ? ` ${item.unit}` : ''}</dd></div>)}</dl>
}

function Validity({ value, enabled }: { value: boolean | null; enabled: boolean }) {
  const label = value === true && enabled ? 'Доступен для Конфигуратора' : value === true ? 'Исключён вручную' : value === false ? 'Не доступен для Конфигуратора' : 'Категория не участвует в Конфигураторе'
  return <span className={`catalog-validity ${value === true && enabled ? 'verified' : 'unverified'}`}>{label}</span>
}

function Completeness({ value, title }: { value?: Completeness; title: string }) {
  if (!value || value.percent === null) return <span className="catalog-completeness" title={`${title}: нет активных требований`}>—</span>
  return <span className="catalog-completeness" title={`${title}: заполнено ${value.filled} из ${value.total}`}><strong>{value.percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%</strong><small>{value.filled}/{value.total}</small></span>
}

export function CatalogPage() {
  const [viewKey] = useState(catalogViewKey)
  const [initialView] = useState(() => readCatalogView(viewKey))
  const [query, setQuery] = useState(initialView.query)
  const [search, setSearch] = useState(initialView.query)
  const [categoryId, setCategoryId] = useState<number | null>(initialView.categoryId)
  const [validity, setValidity] = useState(initialView.validity)
  const [sort, setSort] = useState(initialView.sort)
  const [page, setPage] = useState(initialView.page)
  const [pageSize, setPageSize] = useState(initialView.pageSize)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<Result>({ items: [], total: 0 })
  const [categories, setCategories] = useState<Category[]>([])
  const [categoryQuery, setCategoryQuery] = useState(initialView.categoryQuery)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [categoryError, setCategoryError] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkOptions, setBulkOptions] = useState<AttributeOption[]>([])
  const [bulkDraft, setBulkDraft] = useState<BulkDraft>({ code: '', value_state: 'known', value: '', source_kind: 'manual', source_url: '' })
  const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const [bulkMessage, setBulkMessage] = useState('')
  const [openBranches, setOpenBranches] = useState<Set<number>>(() => new Set(initialView.openBranches))
  useEffect(() => {
    saveCatalogView(viewKey, { query, categoryQuery, categoryId, validity, sort, page: query === search ? page : 1, pageSize, openBranches: [...openBranches] })
  }, [viewKey, query, search, categoryQuery, categoryId, validity, sort, page, pageSize, openBranches])
  const paginationScroll = useRef<number | null>(null)
  const visibleCategoryIds = new Set<number>()
  const normalizedCategoryQuery = categoryQuery.trim().toLocaleLowerCase('ru-RU')
  if (!normalizedCategoryQuery) {
    categories.forEach(category => visibleCategoryIds.add(category.id))
  } else {
    const byId = new Map(categories.map(category => [category.id, category]))
    for (const category of categories) {
      if (!category.name.toLocaleLowerCase('ru-RU').includes(normalizedCategoryQuery)) continue
      let current: Category | undefined = category
      while (current && !visibleCategoryIds.has(current.id)) {
        visibleCategoryIds.add(current.id)
        current = current.parent_id === null ? undefined : byId.get(current.parent_id)
      }
    }
  }

  useLayoutEffect(() => {
    if (paginationScroll.current === null) return
    window.scrollTo(0, paginationScroll.current)
    paginationScroll.current = null
  }, [result])

  function changePage(nextPage: number) {
    paginationScroll.current = window.scrollY
    setPage(nextPage)
  }

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/api/v1/admin/catalog/categories`, { credentials: 'include', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Не удалось загрузить категории.'); return response.json() })
      .then(data => { if (!controller.signal.aborted) setCategories(data.items ?? []) })
      .catch(reason => { if (!controller.signal.aborted) setCategoryError(reason.message || 'Категории недоступны.') })
    return () => controller.abort()
  }, [revision])

  useEffect(() => {
    if (query === search) return
    const timer = setTimeout(() => { setSearch(query); setPage(1) }, 300)
    return () => clearTimeout(timer)
  }, [query, search])
  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ q: search, validity, sort, page: String(page), page_size: String(pageSize) })
    if (categoryId != null) params.set('category_id', String(categoryId))
    setBusy(true); setError('')
    fetch(`${API}/api/v1/admin/catalog?${params}`, { credentials: 'include', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Сессия истекла. Войдите снова.' : 'Не удалось загрузить каталог.'); return response.json() })
      .then(data => { if (!controller.signal.aborted) { setResult(data); setExpanded(new Set()); setSelected(new Set()) } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message || 'Сервер недоступен.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [search, categoryId, validity, sort, page, pageSize, revision])

  useEffect(() => {
    if (!bulkOpen || selected.size === 0) return
    const controller = new AbortController()
    const params = new URLSearchParams()
    Array.from(selected).sort((a, b) => a - b).forEach(id => params.append('product_ids', String(id)))
    setBulkOptions([]); setBulkError('')
    fetch(`${API}/api/v1/admin/catalog/bulk-attributes/options?${params}`, { credentials: 'include', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Не удалось получить общие свойства выбранных товаров.'); return response.json() })
      .then(data => { if (!controller.signal.aborted) setBulkOptions(data.items ?? []) })
      .catch(reason => { if (!controller.signal.aborted) setBulkError(reason.message || 'Не удалось загрузить свойства.') })
    return () => controller.abort()
  }, [bulkOpen, selected])

  async function showAllProducts() {
    setCategoryId(null)
    setPage(1)
  }

  function bulkPayload() {
    const option = bulkOptions.find(item => item.code === bulkDraft.code)
    if (!option) throw new Error('Выберите свойство')
    let value: unknown = null
    if (bulkDraft.value_state === 'known') {
      value = bulkDraft.value
      if (option.value_type === 'list') value = typeof value === 'string' ? JSON.parse(value) : value
      else if (option.value_type === 'number' || option.value_type === 'integer') value = String(value)
    }
    return { product_ids: Array.from(selected).sort((a, b) => a - b), code: bulkDraft.code, value_state: bulkDraft.value_state,
      value, source_kind: bulkDraft.source_kind, source_url: bulkDraft.source_url || null }
  }

  async function previewBulk(event: React.FormEvent) {
    event.preventDefault(); setBulkBusy(true); setBulkError('')
    try {
      const response = await fetch(`${API}/api/v1/admin/catalog/bulk-attributes/preview`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify(bulkPayload()),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось подготовить предпросмотр')
      setBulkPreview(result)
    } catch (reason) { setBulkError(reason instanceof Error ? reason.message : 'Проверьте значение свойства') }
    finally { setBulkBusy(false) }
  }

  async function applyBulk() {
    if (!bulkPreview) return
    setBulkBusy(true); setBulkError('')
    try {
      const response = await fetch(`${API}/api/v1/admin/catalog/bulk-attributes/apply`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ ...bulkPayload(), preview_token: bulkPreview.preview_token }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось сохранить свойства')
      setBulkMessage(`Сохранено товаров: ${result.updated_count}. Перезаписано: ${result.overwrite_count}. Добавлено: ${result.insert_count}.`)
      setBulkOpen(false); setBulkPreview(null); setRevision(value => value + 1)
    } catch (reason) { setBulkError(reason instanceof Error ? reason.message : 'Не удалось сохранить свойства'); setBulkPreview(null) }
    finally { setBulkBusy(false) }
  }

  function updateBulkDraft(update: (draft: BulkDraft) => BulkDraft) {
    setBulkDraft(update); setBulkPreview(null); setBulkError('')
  }

  function tree(parentId: number | null, depth = 0): React.ReactNode {
    return categories.filter(item => visibleCategoryIds.has(item.id) && (item.parent_id === parentId || (parentId === null && item.parent_id != null && !categories.some(parent => parent.id === item.parent_id)))).map(item => {
      const hasChildren = categories.some(child => child.parent_id === item.id)
      const branchOpen = openBranches.has(item.id) || Boolean(normalizedCategoryQuery)
      return <div key={item.id} className="catalog-tree-node" style={{ paddingLeft: `${depth * 12}px` }}>
        <div className={`catalog-tree-row ${categoryId === item.id ? 'active' : ''} ${item.selection_category ? 'selection-participant' : ''}`} title={item.selection_category ? 'Категория включена в подбор ПК' : undefined}>
          {hasChildren ? <button aria-label={`Развернуть ${item.name}`} aria-expanded={branchOpen} onClick={() => setOpenBranches(previous => { const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next })}>{branchOpen ? <AppIcon name="chevron-down" /> : <AppIcon name="chevron-right" />}</button> : <span className="catalog-tree-spacer" />}
          <button className="catalog-tree-name" aria-pressed={categoryId === item.id} onClick={() => { setCategoryId(item.id); setPage(1) }}>{item.name}</button>
          <small>{count(item.valid)}/{count(item.total)}</small>
        </div>
        {hasChildren && branchOpen && tree(item.id, depth + 1)}
      </div>
    })
  }

  function reset() { setQuery(''); setSearch(''); setCategoryQuery(''); setCategoryId(null); setValidity('all'); setSort('name'); setPage(1); setOpenBranches(new Set()) }
  const filtered = Boolean(query || categoryQuery || categoryId != null || validity !== 'all' || sort !== 'name')
  const allExpanded = result.items.length > 0 && result.items.every(item => expanded.has(item.id))
  const allSelected = result.items.length > 0 && result.items.every(item => selected.has(item.id))
  return <section className="catalog-page">
    <div className="catalog-heading"><div><p className="catalog-kicker">ТОВАРЫ И ХАРАКТЕРИСТИКИ</p><h1>Каталог</h1><p>Локальные товары и актуальные предложения источников</p></div><button className="catalog-button" disabled={busy} onClick={() => setRevision(value => value + 1)}><AppIcon name="refresh-cw" /> Обновить</button></div>
    <div className="catalog-workspace"><aside className="catalog-sidebar" aria-label="Дерево категорий"><h2>Категории</h2><label className="category-search"><span aria-hidden="true"><AppIcon name="search" /></span><input aria-label="Поиск категории по названию" placeholder="Найти категорию" value={categoryQuery} onChange={event => setCategoryQuery(event.target.value)} />{categoryQuery && <button type="button" aria-label="Очистить поиск категорий" onClick={() => setCategoryQuery('')}><AppIcon name="x" /></button>}</label><button className="catalog-all" aria-pressed={categoryId === null} onClick={() => void showAllProducts()}>Все товары</button><p className="catalog-muted">Проверено / Всего</p>{categoryError && <p role="alert">{categoryError}</p>}<div className="catalog-category-scroll" role="region" aria-label="Список категорий" tabIndex={0}>{tree(null)}{!categories.length && <p className="catalog-muted">Категории пока не загружены.</p>}{categories.length > 0 && normalizedCategoryQuery && visibleCategoryIds.size === 0 && <p className="catalog-muted">Категория не найдена.</p>}</div></aside>
      <div className="catalog-main"><div className="catalog-toolbar"><label className="catalog-search"><span aria-hidden="true"><AppIcon name="search" /></span><input aria-label="Поиск в каталоге" placeholder="Название, артикул, SKU или производитель" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><AppIcon name="x" /></button>}</label><label className="catalog-select-label">Допуск к конфигуратору<select aria-label="Допуск к конфигуратору" value={validity} onChange={event => { setValidity(event.target.value); setPage(1) }}><option value="all">Все ({count(result.validity_counts?.all ?? 0)})</option><option value="true">Доступны для Конфигуратора ({count(result.validity_counts?.true ?? 0)})</option><option value="false">Не доступен для Конфигуратора ({count(result.validity_counts?.false ?? 0)})</option><option value="null">Категория не участвует в Конфигураторе ({count(result.validity_counts?.null ?? 0)})</option></select></label><label className="catalog-select-label">Порядок<select aria-label="Сортировка" value={sort} onChange={event => { setSort(event.target.value); setPage(1) }}><option value="name">По названию</option><option value="price_asc">Сначала дешевле</option><option value="price_desc">Сначала дороже</option><option value="required_desc">Обязательные значения: больше заполнено</option><option value="required_asc">Обязательные значения: меньше заполнено</option><option value="pc_required_desc">Для подбора ПК: больше заполнено</option><option value="pc_required_asc">Для подбора ПК: меньше заполнено</option></select></label>{filtered && <button className="catalog-text-button" onClick={reset}>Сбросить фильтры</button>}<span className="catalog-found" role="status">{busy ? 'Загрузка…' : `Найдено: ${count(result.total)}`}</span></div>
        <div className="catalog-actions"><Link className="catalog-button catalog-properties-link" to="/admin/performance-models"><AppIcon name="activity" /> Оценки CPU и GPU</Link><PropertyFileExchange categoryId={categoryId} query={search} onApplied={() => setRevision(value => value + 1)} />{categoryId != null && <Link className="catalog-button catalog-properties-link" to={`/admin/categories/${categoryId}/properties`}>Структура свойств</Link>}<button className="catalog-button" disabled={!result.items.length} onClick={() => setExpanded(allExpanded ? new Set() : new Set(result.items.map(item => item.id)))}>{allExpanded ? 'Свернуть все' : 'Раскрыть все'}</button>{selected.size > 0 && <><span className="catalog-muted">Выбрано на странице: {selected.size}</span><button className="catalog-button" onClick={() => { setBulkOpen(true); setBulkMessage(''); setBulkDraft({ code: '', value_state: 'known', value: '', source_kind: 'manual', source_url: '' }); setBulkPreview(null); setBulkError('') }}>Изменить свойства</button></>}</div>
        {bulkMessage && <p className="catalog-bulk-message" role="status">{bulkMessage}</p>}
        {bulkOpen && <div className="catalog-bulk-overlay"><section className="catalog-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-edit-title"><div className="catalog-bulk-heading"><div><h2 id="bulk-edit-title">Массовое изменение свойств</h2><p>Выбрано товаров: {selected.size}. Изменения применятся ко всем выбранным товарам одной транзакцией.</p></div><button className="catalog-button" type="button" disabled={bulkBusy} aria-label="Закрыть массовое редактирование" onClick={() => { setBulkOpen(false); setBulkPreview(null) }}><AppIcon name="x" /></button></div>
          {!bulkPreview ? <form className="catalog-bulk-form" onSubmit={previewBulk}>
            <label>Свойство<select aria-label="Свойство для массового изменения" value={bulkDraft.code} onChange={event => { const code = event.target.value; const option = bulkOptions.find(item => item.code === code); updateBulkDraft(draft => ({ ...draft, code, value: option?.value_type === 'boolean' ? false : '' })) }}><option value="">Выберите общее свойство</option>{bulkOptions.map(option => <option key={option.code} value={option.code} disabled={!option.editable}>{option.label}</option>)}</select></label>
            {bulkOptions.length === 0 && !bulkError && <p className="catalog-muted">Загружаем общие свойства выбранных товаров…</p>}
            {bulkOptions.length > 0 && <>
              <label>Состояние<select value={bulkDraft.value_state} onChange={event => updateBulkDraft(draft => ({ ...draft, value_state: event.target.value as BulkDraft['value_state'] }))}><option value="known">Значение известно</option><option value="unknown">Неизвестно</option><option value="not_applicable">Не применимо</option></select></label>
              {bulkDraft.value_state === 'known' && (() => {
                const option = bulkOptions.find(item => item.code === bulkDraft.code)
                if (!option) return null
                if (option.value_type === 'boolean') return <label>Значение<select aria-label="Значение свойства для массового изменения" value={String(bulkDraft.value)} onChange={event => updateBulkDraft(draft => ({ ...draft, value: event.target.value === 'true' }))}><option value="true">Да</option><option value="false">Нет</option></select></label>
                if (option.value_type === 'enum' && option.allowed_values.length) return <label>Значение<select aria-label="Значение свойства для массового изменения" value={JSON.stringify(bulkDraft.value)} onChange={event => updateBulkDraft(draft => ({ ...draft, value: JSON.parse(event.target.value) }))}><option value="">Выберите значение</option>{option.allowed_values.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{String(value)}</option>)}</select></label>
                if (option.value_type === 'list') return <label>Значение (JSON)<textarea aria-label="Значение свойства для массового изменения" value={String(bulkDraft.value)} placeholder='Например: ["AM5", "AM4"]' onChange={event => updateBulkDraft(draft => ({ ...draft, value: event.target.value }))} /></label>
                return <label>Значение{option.unit ? ` (${option.unit})` : ''}<input aria-label="Значение свойства для массового изменения" inputMode={option.value_type === 'number' || option.value_type === 'integer' ? 'decimal' : undefined} value={String(bulkDraft.value)} onChange={event => updateBulkDraft(draft => ({ ...draft, value: event.target.value }))} /></label>
              })()}
              <label>Источник<select value={bulkDraft.source_kind} onChange={event => updateBulkDraft(draft => ({ ...draft, source_kind: event.target.value }))}><option value="manual">Ручной ввод</option><option value="manufacturer_site">Сайт производителя</option><option value="manufacturer_document">Документ производителя</option><option value="ai_official">AI по официальному источнику</option><option value="retailer_site">Белый Ветер, DNS или Технодом</option><option value="ai_retailer">AI по данным магазина</option></select></label>
              {bulkDraft.source_kind !== 'manual' && <label>Ссылка на источник<input type="url" aria-label="Ссылка на источник массового изменения" value={bulkDraft.source_url} onChange={event => updateBulkDraft(draft => ({ ...draft, source_url: event.target.value }))} placeholder="https://" /></label>}
            </>}
            {bulkError && <p role="alert">{bulkError}</p>}
            <div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={bulkBusy} onClick={() => { setBulkOpen(false); setBulkPreview(null) }}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="submit" disabled={bulkBusy || !bulkDraft.code || bulkOptions.length === 0}>{bulkBusy ? 'Проверяем…' : 'Предпросмотр изменений'}</button></div>
          </form> : <div className="catalog-bulk-preview"><p>Свойство: <strong>{bulkPreview.attribute.label}</strong>. Новое значение: <strong>{bulkPreview.value_state === 'known' ? `${typeof bulkPreview.value === 'object' ? JSON.stringify(bulkPreview.value) : String(bulkPreview.value)}${bulkPreview.attribute.unit ? ` ${bulkPreview.attribute.unit}` : ''}` : bulkPreview.value_state === 'unknown' ? 'Неизвестно' : 'Не применимо'}</strong></p><p>Будет перезаписано: <strong>{bulkPreview.overwrite_count}</strong>; добавлено: <strong>{bulkPreview.insert_count}</strong>. Если выбранные товары или правила изменились, сервер отменит сохранение и попросит обновить предпросмотр.</p><ul>{bulkPreview.items.map(item => <li key={item.product_id}><strong>{item.name}</strong> · {item.category ?? 'Без категории'} — {item.will_overwrite ? `сейчас: ${item.previous?.value_state === 'known' ? String(item.previous.value) : item.previous?.value_state === 'unknown' ? 'Неизвестно' : 'Не применимо'}` : 'свойство будет добавлено'}</li>)}</ul>{bulkError && <p role="alert">{bulkError}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" disabled={bulkBusy} onClick={() => { setBulkPreview(null); setBulkError('') }}>Назад</button><button className="catalog-button" disabled={bulkBusy} onClick={() => { setBulkOpen(false); setBulkPreview(null) }}>Отмена</button><button className="catalog-button catalog-bulk-primary" disabled={bulkBusy} onClick={() => void applyBulk()}>{bulkBusy ? 'Сохраняем…' : 'Подтвердить и сохранить'}</button></div></div>}
        </section></div>}
        {error ? <div className="catalog-empty" role="alert"><p>{error}</p><button className="catalog-button" onClick={() => setRevision(value => value + 1)}>Повторить</button></div> : busy ? <div className="catalog-empty" role="status">Загружаем каталог…</div> : !result.items.length ? <div className="catalog-empty"><h2>{filtered ? 'Ничего не найдено' : 'Каталог пока пуст'}</h2><p>{filtered ? 'Измените запрос или сбросьте фильтры.' : 'Импортируйте снимок источника, чтобы добавить товары.'}</p></div> : <div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th><input type="checkbox" aria-label="Выбрать страницу" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(result.items.map(item => item.id)))} /></th><th>Товар</th><th>Категория</th><th>Актуальная цена</th><th className="catalog-completeness-heading" title="Доля заполненных активных обязательных свойств категории и общих правил каталога">% обязательных значений</th><th className="catalog-completeness-heading" title="Доля заполненных свойств, обязательных для подбора ПК">% для подбора ПК</th><th>Допуск</th></tr></thead><tbody>{result.items.map(product => <FragmentRow key={product.id} product={product} selected={selected.has(product.id)} expanded={expanded.has(product.id)} onSelect={() => setSelected(previous => { const next = new Set(previous); if (next.has(product.id)) next.delete(product.id); else next.add(product.id); return next })} onExpand={() => setExpanded(previous => { const next = new Set(previous); if (next.has(product.id)) next.delete(product.id); else next.add(product.id); return next })} />)}</tbody></table></div>}
        <div className="catalog-pagination"><label>На странице<select aria-label="Товаров на странице" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1) }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label><div><button className="catalog-button" disabled={page === 1 || busy} onClick={() => changePage(page - 1)}><AppIcon name="arrow-left" /> Назад</button><span>{page} / {Math.max(1, Math.ceil(result.total / pageSize))}</span><button className="catalog-button" disabled={page * pageSize >= result.total || busy} onClick={() => changePage(page + 1)}>Далее <AppIcon name="arrow-right" /></button></div></div>
      </div></div>
  </section>
}

function FragmentRow({ product, selected, expanded, onSelect, onExpand }: { product: Product; selected: boolean; expanded: boolean; onSelect: () => void; onExpand: () => void }) {
  return <><tr><td><input type="checkbox" aria-label={`Выбрать ${product.name}`} checked={selected} onChange={onSelect} /></td><td><div className="catalog-name"><button aria-label={`Раскрыть ${product.name}`} aria-expanded={expanded} onClick={onExpand}>{expanded ? <AppIcon name="chevron-down" /> : <AppIcon name="chevron-right" />}</button><div><Link to={`/admin/catalog/${product.id}`}>{product.name}</Link><span>{product.manufacturer || 'Производитель не указан'} · {product.article || 'артикул не указан'}</span><small>SKU {product.sku}</small></div></div></td><td>{product.categories.map(cat => cat.name).join(', ') || 'Без категории'}</td><td><strong>{product.current_price == null ? 'Нет актуального предложения' : price(product.current_price, product.currency)}</strong><small>{count(product.current_offer_count)} актуальных предложений</small></td><td><Completeness value={product.required_value_completeness} title="Обязательные значения" /></td><td><Completeness value={product.pc_selection_completeness} title="Обязательные для подбора ПК" /></td><td><Validity value={product.validity_check} enabled={product.selection_enabled} /></td></tr>{expanded && <tr className="catalog-detail-row"><td colSpan={7}><Attributes items={product.attributes} /><Link to={`/admin/catalog/${product.id}`}>Открыть карточку <AppIcon name="arrow-right" /></Link></td></tr>}</>
}

export function CatalogProductPage() {
  const { productId } = useParams()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/api/v1/admin/catalog/${productId}`, { credentials: 'include', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(response.status === 404 ? 'Товар не найден.' : 'Не удалось открыть карточку.'); return response.json() })
      .then(data => { if (!controller.signal.aborted) setDetail(data) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [productId, revision])
  return <section className="catalog-page"><Link to="/admin/catalog"><AppIcon name="arrow-left" /> Вернуться в каталог</Link>{error ? <p role="alert">{error}</p> : !detail ? <p role="status">Загружаем карточку…</p> : <><div className="catalog-heading"><div><p className="catalog-product-id">ID {detail.id}</p><h1>{detail.name}</h1><p className="catalog-product-meta"><span>{detail.manufacturer || 'Производитель не указан'} · {detail.article || 'артикул не указан'} · SKU {detail.sku}</span><Validity value={detail.validity_check} enabled={detail.selection_enabled} /></p></div></div><div className="catalog-card"><h2>Категории</h2><p>{detail.categories.map(cat => cat.name).join(', ') || 'Без категории'}</p>{detail.categories.map(cat => <p key={cat.id}><Link to={`/admin/categories/${cat.id}/properties`}>Свойства категории: {cat.name}</Link></p>)}<SelectionCheck productId={detail.id} enabled={detail.selection_enabled} onSaved={() => setRevision(value => value + 1)} /><ProductPropertyCheck productId={detail.id} canLoad={detail.ai_load_allowed} onLoaded={() => setRevision(value => value + 1)} /><h2>Характеристики</h2><ProductAttributesEditor productId={detail.id} items={detail.attributes} available={detail.available_attributes} onSaved={() => setRevision(value => value + 1)} /><h2>Причины проверки</h2>{detail.validation_reasons.length ? <ul>{detail.validation_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p className="catalog-muted">Причин пока нет.</p>}<h2>Предложения источников</h2>{detail.offers.length ? <ul>{detail.offers.map((offer, index) => <li key={index}>{offer.source} · SKU {offer.sku} · {offer.is_current ? price(offer.price, offer.currency) : 'Нет в последнем снимке'}</li>)}</ul> : <p className="catalog-muted">Предложений источников пока нет.</p>}</div></>}</section>
}
