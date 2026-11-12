import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useRef, useState } from 'react'
import './sources.css'

const API = import.meta.env.VITE_API_URL ?? ''
type Source = { id: number; name: string; code: string; total: number; is_active: boolean; downloaded_at: string | null }
type Product = { id: number; sku: string; name: string; article: string | null; manufacturer: string | null; category: string | null; price: number | string | null; price_bonus: number | string | null; price_special: number | string | null; archived: boolean | null; is_current: boolean; warehouses: string[]; link_status: string; core_product_id: number | null; core_product_name: string | null }
type Result = { items: Product[]; total: number; categories: string[] }
const count = (n: number) => n.toLocaleString('ru-RU')
const price = (n: Product['price']) => n == null || Number(n) === 0 ? 'Не указана' : `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₸`
const date = (value: string | null) => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : 'Нет завершённых загрузок'

export function SourcesPage() {
  const [sources, setSources] = useState<Source[]>([])
  const [sourceId, setSourceId] = useState<number | null>(null)
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourceError, setSourceError] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [archived, setArchived] = useState('all')
  const [presence, setPresence] = useState('current')
  const [sort, setSort] = useState('name')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [result, setResult] = useState<Result>({ items: [], total: 0, categories: [] })
  const [selected, setSelected] = useState<Product | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const source = sources.find(s => s.id === sourceId)
  async function downloadTemplate() {
    try {
      const response = await fetch(`${API}/api/v1/admin/sources/price-list-template.xls`, { credentials: 'include' })
      if (!response.ok) throw new Error('Не удалось скачать шаблон организации.')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a'); link.href = url; link.download = 'price-list-template.xls'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setSourceError((e as Error).message) }
  }

  useEffect(() => {
    const controller = new AbortController()
    setSourcesLoading(true); setSourceError('')
    fetch(`${API}/api/v1/admin/sources`, { credentials: 'include', signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Войдите в систему для просмотра источников.' : 'Не удалось получить источники.')
      return r.json()
    }).then(data => { setSources(data.items); setSourceId(current => data.items.some((s: Source) => s.id === current) ? current : data.items[0]?.id ?? null) })
      .catch(e => { if (!controller.signal.aborted) setSourceError(e.message || 'Сервер недоступен.') })
      .finally(() => { if (!controller.signal.aborted) setSourcesLoading(false) })
    return () => controller.abort()
  }, [revision])

  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1) }, 300); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    if (sourceId == null) return
    const controller = new AbortController()
    setBusy(true); setError('')
    const params = new URLSearchParams({ q: search, category, archived, presence, sort, page: String(page), page_size: String(size) })
    fetch(`${API}/api/v1/admin/sources/${sourceId}/products?${params}`, { credentials: 'include', signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Сессия истекла. Войдите в систему снова.' : 'Не удалось загрузить товары.')
      return r.json()
    }).then(data => { if (!controller.signal.aborted) setResult(data) })
      .catch(e => { if (!controller.signal.aborted) setError(e.message || 'Сервер недоступен.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [sourceId, search, category, archived, presence, sort, page, size, revision])

  useEffect(() => { if (selected) dialog.current?.showModal(); else dialog.current?.close() }, [selected])
  function reset() { setQuery(''); setSearch(''); setCategory(''); setArchived('all'); setPresence('current'); setSort('name'); setPage(1) }
  const filtered = Boolean(query || category || archived !== 'all' || presence !== 'current')
  return <section className="sources-page">
    <div className="catalog-heading sources-heading"><div><p className="catalog-kicker">ПРАЙС-ЛИСТЫ КЛИЕНТА</p><h1>Источники</h1><p>Прайс-листы клиента для каталога CoreLab</p></div><button className="catalog-button" onClick={() => void downloadTemplate()}><AppIcon name="file-spreadsheet" /> Скачать шаблон XLS</button></div>
    <p className="settings-help">В шаблоне — товары, цены и остатки по филиалам. Коды филиалов задаются в настройках организации.</p>
    {sourceError ? <div className="source-state" role="alert"><h2>Не удалось открыть источники</h2><p>{sourceError}</p><button className="soft-button" onClick={() => setRevision(v => v + 1)}>Повторить</button></div> : sourcesLoading && !sources.length ? <div className="source-state" role="status">Загружаем источники…</div> : <div className="sources-workspace">
      <aside className="source-list" aria-label="Список источников"><div className="source-list-title">ИСТОЧНИКИ <span>{sources.length}</span></div>
        {sources.map(s => <button key={s.id} className={`source-choice ${s.id === sourceId ? 'chosen' : ''}`} aria-pressed={s.id === sourceId} onClick={() => { if (s.id === sourceId) return; setSourceId(s.id); reset(); setResult({ items: [], total: 0, categories: [] }) }}><span className="source-monogram">{s.code.toUpperCase()}</span><span><strong>{s.name}</strong><small>{s.is_active === false && <>Сохранённый снимок · </>}{count(s.total)} товаров</small></span><span className="source-arrow"><AppIcon name="chevron-right" /></span></button>)}
        {!sources.length && <div className="source-pending"><strong>Нет подключённых источников</strong></div>}
        <div className="source-list-note">Каждый источник хранит собственные цены, остатки и артикулы.</div>
      </aside>
      <div className="source-main">{!source ? <div className="source-state"><span className="empty-symbol"><AppIcon name="arrow-left-right" /></span><h2>Здесь появится прайс-лист</h2><p>После первого импорта выберите источник, чтобы просмотреть его товары, цены и складские остатки.</p></div> : <>
        <div className="source-overview"><div className="source-title"><span className="source-monogram large">{source.code.toUpperCase()}</span><div><h2>{source.name}</h2><span className="neutral-badge">{source.is_active === false ? 'Сохранённый снимок' : 'Данные прайс-листа'}</span></div></div><div className="source-metrics"><div><span>Товаров в источнике</span><strong>{count(source.total)}</strong></div><div><span>Снимок источника</span><strong className="source-date">{date(source.downloaded_at)}</strong></div></div></div>
        <div className="source-help">{source.is_active === false ? 'Сохранённые товары, цены и остатки прайс-листа. Связи с товарами CoreLab сохранены. Подключение к источнику отключено; данные не обновляются.' : 'Свойства и характеристики редактируются в каталоге CoreLab. Здесь — исходные данные прайс-листа клиента.'}</div>
        <div className="products-toolbar"><label className="search-box"><span aria-hidden="true"><AppIcon name="search" /></span><input aria-label="Поиск товаров" placeholder="Название, артикул, SKU или производитель" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><AppIcon name="x" /></button>}</label><label className="sort-box">Порядок<select aria-label="Сортировка" value={sort} onChange={e => { setSort(e.target.value); setPage(1) }}><option value="name">По названию</option><option value="price_asc">Сначала дешевле</option><option value="price_desc">Сначала дороже</option></select></label></div>
        <div className="products-filters"><select aria-label="Категория" value={category} onChange={e => { setCategory(e.target.value); setPage(1) }}><option value="">Все категории</option>{result.categories.map(c => <option key={c}>{c}</option>)}</select><select aria-label="Наличие в последнем снимке" value={presence} onChange={e => { setPresence(e.target.value); setPage(1) }}><option value="current">В последнем снимке</option><option value="missing">Не найдено в последнем снимке</option><option value="all">Все снимки</option></select><select aria-label="Статус товара" value={archived} onChange={e => { setArchived(e.target.value); setPage(1) }}><option value="all">Все статусы</option><option value="active">Не в архиве</option><option value="archived">В архиве прайс-листа</option></select>{filtered && <button className="text-button" onClick={reset}>Сбросить фильтры</button>}<span className="found-count" role="status">{busy ? 'Загрузка…' : `Найдено: ${count(result.total)}`}</span></div>
        {error ? <div className="source-state" role="alert"><p>{error}</p><button className="soft-button" onClick={() => setRevision(v => v + 1)}>Повторить</button></div> : busy ? <div className="source-state" role="status">Загружаем товары…</div> : result.items.length === 0 ? <div className="source-state"><span className="empty-symbol"><AppIcon name="search" /></span><h2>{filtered ? 'Ничего не найдено' : 'Товаров пока нет'}</h2><p>{filtered ? 'Попробуйте другой запрос или снимите фильтры.' : 'Товары появятся после загрузки прайс-листа.'}</p>{filtered && <button className="soft-button" onClick={reset}>Сбросить фильтры</button>}</div> : <div className="products-table-scroll"><table className="products-table"><thead><tr><th>Товар / артикул</th><th>Категория</th><th>Цена продажи</th><th>Статус</th><th><span className="sr-only">Просмотр</span></th></tr></thead><tbody>{result.items.map(item => <tr key={item.id}><td><button className="product-name" onClick={() => setSelected(item)}>{item.name}</button><div className="product-meta">{item.manufacturer || 'Без производителя'} <span>·</span> {item.article || 'Без артикула'}</div><small className="sku-label">SKU {item.sku}</small></td><td>{item.category || 'Без категории'}</td><td className="price-cell">{price(item.price)}</td><td><span className={`status-badge ${!item.is_current ? 'missing' : item.archived ? 'archived' : 'current'}`}>{!item.is_current ? 'Не найдено в последнем снимке' : item.archived ? 'В архиве прайс-листа' : 'В последнем снимке'}</span></td><td><button className="row-open" aria-label={`Просмотреть ${item.name}`} onClick={() => setSelected(item)}><AppIcon name="arrow-up-right" /></button></td></tr>)}</tbody></table></div>}
        <div className="products-pagination"><label>На странице<select aria-label="Товаров на странице" value={size} onChange={e => { setSize(Number(e.target.value)); setPage(1) }}><option>25</option><option>50</option><option>100</option></select></label><div><button className="soft-button" disabled={page === 1 || busy} onClick={() => setPage(p => p - 1)}><AppIcon name="arrow-left" /> Назад</button><span>{page} / {Math.max(1, Math.ceil(result.total / size))}</span><button className="soft-button" disabled={page * size >= result.total || busy} onClick={() => setPage(p => p + 1)}>Далее <AppIcon name="arrow-right" /></button></div></div>
      </>}</div>
    </div>}
    <dialog ref={dialog} className="product-dialog" aria-labelledby="product-title" onCancel={() => setSelected(null)} onClick={e => { if (e.target === e.currentTarget) setSelected(null) }}>{selected && <><div className="dialog-top"><span className="section-kicker">ТОВАР ИСТОЧНИКА</span><button className="soft-button" autoFocus aria-label="Закрыть карточку" onClick={() => setSelected(null)}><AppIcon name="x" /></button></div><h2 id="product-title">{selected.name}</h2><p className="product-meta">{source?.name} · SKU {selected.sku}</p><dl className="product-details"><dt>Производитель</dt><dd>{selected.manufacturer || 'Не указан'}</dd><dt>Артикул</dt><dd>{selected.article || 'Не указан'}</dd><dt>Категория</dt><dd>{selected.category || 'Без категории'}</dd><dt>Цена продажи</dt><dd>{price(selected.price)}</dd><dt>Бонусная цена</dt><dd>{price(selected.price_bonus)}</dd><dt>Специальная цена</dt><dd>{price(selected.price_special)}</dd></dl><div className={`link-notice ${selected.is_current ? '' : 'stale-notice'}`}><strong>Связь с каталогом CoreLab</strong><p>{selected.core_product_id ? `Связано: ${selected.core_product_name} · ID ${selected.core_product_id}` : 'Связь ещё не создана.'}</p>{!selected.is_current && <p>Предложение отсутствует в последнем полном снимке источника.</p>}</div><h3>Остатки по складам</h3><p className="warehouse-note">Строки прайс-листа в исходном виде. Количество — первое число в скобках.</p>{selected.warehouses.length ? <ul className="warehouse-list">{selected.warehouses.map((w, i) => <li key={i}>{w}</li>)}</ul> : <p>Источник не передал складские остатки.</p>}</>}</dialog>
  </section>
}
