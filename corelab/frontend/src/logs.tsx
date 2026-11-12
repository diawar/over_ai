import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import './logs.css'

const API = import.meta.env.VITE_API_URL ?? ''
type Event = { id: number; action: string; status: string; object_type: string | null; object_id: string | null; author: string; initiated_by: string | null; created_at: string; reason: string | null; property_count: number | null; job_id: number | null; error_count: number | null; warning_count: number | null; sources?: { url: string; label: string }[] }
type JobItem = { product_id: number | null; status: string; reason: string | null; property_count: number | null }
type Job = { id: number; status: string; total: number; completed: number; skipped: number; failed: number; initiated_by: string | null; created_at: string; items: JobItem[] }
type ImportRun = { id: number; source_id: number; status: string; expected: number; imported: number; started_at: string; finished_at: string | null }
type Page<T> = { items: T[]; total: number; page: number; page_size: number }
const actionLabels: Record<string, string> = {
  'properties.ai_load_queued': 'Загрузка поставлена в очередь', 'properties.ai_load_completed': 'Свойства загружены',
  'properties.ai_load_skipped': 'Товар пропущен', 'properties.ai_load_failed': 'Ошибка загрузки',
  'properties.ai_structure_queued': 'Исследование свойств поставлено в очередь',
  'properties.ai_structure_started': 'AI начал исследование структуры',
  'properties.ai_structure_generated': 'Структура создана с AI',
  'properties.ai_structure_failed': 'Ошибка исследования структуры', 'properties.structure_checked': 'Структура проверена',
  'properties.product_checked': 'Свойства товара проверены', 'properties.template_applied': 'Шаблон применён',
  'properties.rule_created': 'Свойство создано', 'properties.rule_updated': 'Свойство изменено',
  'properties.rule_archived': 'Свойство архивировано', 'product.attribute_changed': 'Свойство товара изменено',
  'product.attribute_deleted': 'Свойство товара удалено',
  'properties.values_merged': 'Значения свойства объединены',
  'properties.value_created': 'Значение свойства добавлено', 'properties.value_updated': 'Значение свойства изменено',
  'properties.value_deleted': 'Значение свойства удалено',
  'product.bulk_attribute_changed': 'Массовое изменение свойства', 'product.validity_changed': 'Допуск пересчитан',
  'product.selection_changed': 'Допуск товара изменён', 'category.selection_changed': 'Участие категории изменено',
  'settings.openai_key_saved': 'Ключ AI сохранён', 'settings.openai_connection_tested': 'Подключение AI проверено',
  'settings.openai_key_deleted': 'Ключ AI удалён',
}
const statusLabels: Record<string, string> = { queued: 'В очереди', running: 'В работе', completed: 'Завершено', skipped: 'Пропущено', failed: 'Ошибка', success: 'Успешно', warning: 'Предупреждение', error: 'Ошибка' }
const formatTime = (value: string) => new Date(value).toLocaleString('ru-RU')
function objectLink(item: Event) {
  const id = item.object_id
  if (!id) return <span>{item.object_type ?? '—'}</span>
  if (item.object_type === 'product' && /^\d+$/.test(id)) return <Link to={`/admin/catalog/${id}`}>Товар #{id}</Link>
  if (item.object_type === 'product_attribute' && /^\d+:[\w.-]+$/.test(id)) return <Link to={`/admin/catalog/${id.split(':')[0]}`}>Товар #{id.split(':')[0]} · {id.split(':')[1]}</Link>
  if (item.object_type === 'category' && /^\d+$/.test(id)) return <Link to={`/admin/categories/${id}/properties`}>Категория #{id}</Link>
  return <span>{item.object_type ?? '—'} {id}</span>
}

function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (value: number) => void }) {
  const last = Math.max(1, Math.ceil(total / pageSize))
  return <div className="logs-pagination"><span>{total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} из ${total}` : '0 записей'}</span><div><button className="catalog-button" disabled={page <= 1} onClick={() => onPage(page - 1)}><AppIcon name="arrow-left" /> Назад</button><span>{page} / {last}</span><button className="catalog-button" disabled={page >= last} onClick={() => onPage(page + 1)}>Далее <AppIcon name="arrow-right" /></button></div></div>
}

export function LogsPage() {
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [productId, setProductId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [jobPage, setJobPage] = useState(1)
  const [importPage, setImportPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [events, setEvents] = useState<Page<Event>>({ items: [], total: 0, page: 1, page_size: 25 })
  const [jobs, setJobs] = useState<Page<Job>>({ items: [], total: 0, page: 1, page_size: 5 })
  const [imports, setImports] = useState<Page<ImportRun>>({ items: [], total: 0, page: 1, page_size: 5 })
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { const timer = setTimeout(() => { setSearch(query.trim()); setPage(1) }, 300); return () => clearTimeout(timer) }, [query])
  useEffect(() => {
    const controller = new AbortController()
    const eventParams = new URLSearchParams({ kind, status, q: search, page: String(page), page_size: '25' })
    if (dateFrom) eventParams.set('date_from', dateFrom)
    if (dateTo) eventParams.set('date_to', dateTo)
    if (productId) eventParams.set('product_id', productId)
    const jobParams = new URLSearchParams({ page: String(jobPage), page_size: '5' })
    const importParams = new URLSearchParams({ page: String(importPage), page_size: '5' })
    setBusy(true); setError('')
    Promise.all([
      fetch(`${API}/api/v1/admin/logs?${eventParams}`, { credentials: 'include', signal: controller.signal }),
      fetch(`${API}/api/v1/admin/logs/jobs?${jobParams}`, { credentials: 'include', signal: controller.signal }),
      fetch(`${API}/api/v1/admin/logs/imports?${importParams}`, { credentials: 'include', signal: controller.signal }),
    ]).then(async ([eventResponse, jobResponse, importResponse]) => {
      if (!eventResponse.ok || !jobResponse.ok || !importResponse.ok) throw new Error('Не удалось загрузить журнал.')
      return Promise.all([eventResponse.json(), jobResponse.json(), importResponse.json()])
    }).then(([eventPage, jobList, importList]) => { if (!controller.signal.aborted) { setEvents(eventPage); setJobs(jobList); setImports(importList) } })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Журнал недоступен.') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [kind, status, dateFrom, dateTo, productId, search, page, jobPage, importPage, revision])
  useEffect(() => {
    if (!jobs.items.some(job => job.status === 'queued' || job.status === 'running')) return
    const timer = setInterval(() => setRevision(value => value + 1), 5000)
    return () => clearInterval(timer)
  }, [jobs.items])

  return <section className="catalog-page logs-page">
    <div className="catalog-heading"><div><p className="catalog-kicker">СОБЫТИЯ И ЗАДАНИЯ CORELAB</p><h1>Журнал</h1><p>Проверки, изменения свойств и ход загрузки.</p></div><button className="catalog-button" disabled={busy} onClick={() => setRevision(value => value + 1)}><AppIcon name="refresh-cw" /> Обновить</button></div>
    {error && <p role="alert" className="logs-error">{error}</p>}
    <section className="logs-panel" aria-labelledby="logs-jobs-title"><div className="logs-section-heading"><h2 id="logs-jobs-title">Задания по загрузке свойств</h2><p>Прогресс сохраняется после перезапуска сервера.</p></div>
      {jobs.items.length ? <div className="logs-jobs">{jobs.items.map(job => {
        const finished = job.completed + job.skipped + job.failed
        return <details className="logs-job" key={job.id}><summary><span><strong>Задание #{job.id}</strong><small>{formatTime(job.created_at)} · Запустил: {job.initiated_by ?? 'Не указан'}</small></span><span className={`logs-status logs-status-${job.status}`}>{statusLabels[job.status] ?? job.status}</span><span className="logs-job-count">{finished} / {job.total}</span></summary><progress value={finished} max={Math.max(job.total, 1)} aria-label={`Прогресс задания ${job.id}`} /><p>Загружено: {job.completed} · Пропущено: {job.skipped} · Ошибок: {job.failed}</p><ul>{job.items.map((item, index) => <li key={`${item.product_id ?? 'removed'}-${index}`}><span>{item.product_id ? <Link to={`/admin/catalog/${item.product_id}`}>Товар #{item.product_id}</Link> : 'Товар удалён'}</span><span>{statusLabels[item.status] ?? item.status}{item.property_count ? ` · ${item.property_count} свойств` : ''}{item.reason ? ` · ${item.reason}` : ''}</span></li>)}</ul></details>
      })}</div> : !busy && <p className="catalog-muted">Заданий пока нет.</p>}
      <Pagination page={jobPage} total={jobs.total} pageSize={jobs.page_size} onPage={setJobPage} />
    </section>
    <section className="logs-panel" aria-labelledby="logs-imports-title"><div className="logs-section-heading"><h2 id="logs-imports-title">Импорт каталога</h2><p>Сохранённые результаты загрузки снимков.</p></div>
      {imports.items.length ? <div className="logs-jobs">{imports.items.map(run => <div className="logs-job" key={run.id}><strong>Импорт #{run.id} · источник #{run.source_id}</strong><p>{formatTime(run.started_at)} · Автор: Система · {statusLabels[run.status] ?? run.status} · {run.imported} / {run.expected} записей</p></div>)}</div> : !busy && <p className="catalog-muted">Импортов пока нет.</p>}
      <Pagination page={importPage} total={imports.total} pageSize={imports.page_size} onPage={setImportPage} />
    </section>
    <section className="logs-panel" aria-labelledby="logs-events-title"><div className="logs-section-heading"><h2 id="logs-events-title">События</h2><p>Последние события показаны первыми.</p></div>
      <div className="logs-filters"><label>Тип события<select aria-label="Тип события" value={kind} onChange={event => { setKind(event.target.value); setPage(1) }}><option value="all">Все</option><option value="structure">Проверки структуры</option><option value="property">Изменения свойств</option><option value="load">Загрузка свойств</option><option value="validation">Проверки товаров</option><option value="selection">Допуск к конфигуратору</option><option value="settings">Настройки</option></select></label><label>Статус<select aria-label="Статус события" value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}><option value="all">Все</option><option value="completed">Завершено</option><option value="queued">В очереди</option><option value="running">В работе</option><option value="skipped">Пропущено</option><option value="failed">Ошибка</option><option value="success">Проверка успешна</option><option value="warning">Предупреждение</option><option value="error">Ошибка проверки</option></select></label><label>С даты<input aria-label="С даты" type="date" value={dateFrom} onChange={event => { setDateFrom(event.target.value); setPage(1) }} /></label><label>По дату<input aria-label="По дату" type="date" value={dateTo} onChange={event => { setDateTo(event.target.value); setPage(1) }} /></label><label>ID товара<input aria-label="ID товара" type="number" min="1" value={productId} onChange={event => { setProductId(event.target.value); setPage(1) }} /></label><label>Поиск по действию, ID или ошибке<input aria-label="Поиск в журнале" value={query} onChange={event => setQuery(event.target.value)} placeholder="Например, модель или причина отказа" /></label></div>
      <div className="catalog-table-wrap"><table className="catalog-table logs-table"><thead><tr><th>Время</th><th>Автор</th><th>Событие</th><th>Объект</th><th>Результат</th></tr></thead><tbody>{events.items.map(item => <tr key={item.id}><td>{formatTime(item.created_at)}</td><td>{item.author}{item.initiated_by && item.author === 'Система' && <small>Запустил: {item.initiated_by}</small>}</td><td>{actionLabels[item.action] ?? item.action}</td><td>{objectLink(item)}</td><td><span className={`logs-status logs-status-${item.status}`}>{statusLabels[item.status] ?? item.status}</span>{item.reason && <small>{item.reason}</small>}{item.sources?.length ? <small>Сайты источников: {item.sources.map((source, index) => <span key={source.url}>{index > 0 && ', '}<a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></span>)}</small> : null}{item.property_count != null && <small>{item.property_count} свойств</small>}{item.error_count != null && <small>Ошибок: {item.error_count} · предупреждений: {item.warning_count ?? 0}</small>}{item.job_id && <small>Задание #{item.job_id}</small>}</td></tr>)}</tbody></table>{!busy && !events.items.length && <p className="logs-empty">Событий по выбранным условиям нет.</p>}</div>
      <Pagination page={page} total={events.total} pageSize={events.page_size} onPage={setPage} />
    </section>
  </section>
}
