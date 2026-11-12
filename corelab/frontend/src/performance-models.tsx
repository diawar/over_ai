import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminFetch } from './admin-fetch'
import { AppIcon } from './icons'
import './catalog.css'
import './performance-models.css'

type Model = { type: 'cpu' | 'gpu'; model: string | null; memory_gb: number | null; status: string
  evidence: { scenario: string; url: string; checked_at: string; metric: string }[]
  products: { id: number; name: string; sku: string; selection_enabled: boolean; validity_check: boolean | null }[] }
type Result = { items: Model[]; total: number; summary: { models: number; pending: number; products: number } }
const API = import.meta.env.VITE_API_URL ?? ''

export function PerformanceModelsPage() {
  const [scenario, setScenario] = useState('gaming')
  const [status, setStatus] = useState('pending')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<Result | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true); setError(''); setData(null)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ scenario, status, q: query, page: String(page), page_size: '25' })
        const response = await adminFetch(`${API}/api/v1/admin/performance-models?${params}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Не удалось загрузить оценки моделей')
        const result = await response.json()
        if (!controller.signal.aborted) setData(result)
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Ошибка загрузки')
      } finally { if (!controller.signal.aborted) setBusy(false) }
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [scenario, status, query, page, revision])
  return <section className="catalog-page performance-page">
    <div className="catalog-heading"><div><p className="catalog-kicker">ПОДБОР КОМПЛЕКТУЮЩИХ</p><h1>Оценки CPU и GPU</h1><p>Одна модель чипа — общие тесты для связанных товаров. Совместимость и наличие проверяются отдельно.</p></div>
      <Link className="catalog-button" to="/admin/catalog"><AppIcon name="arrow-left" /> Каталог</Link></div>
    <div className="performance-filters">
      <label>Сценарий<select value={scenario} onChange={e => { setScenario(e.target.value); setPage(1) }}><option value="gaming">Игры</option><option value="photoshop">Photoshop</option><option value="blender_cpu">Blender · CPU-рендеринг</option><option value="blender_gpu">Blender · GPU-рендеринг</option><option value="twinmotion">Twinmotion · GPU-рендеринг</option><option value="creative">Прочие творческие задачи</option></select></label>
      <label>Оценка<select value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}><option value="pending">Без оценки / уточнить модель</option><option value="all">Все модели</option></select></label>
      <label className="performance-search">Поиск модели или товара<input value={query} onChange={e => { setQuery(e.target.value); setPage(1) }} placeholder="Например, R9700 или Ryzen 5 7600" /></label>
      <button className="catalog-button" disabled={busy} onClick={() => setRevision(v => v + 1)}><AppIcon name="refresh-cw" /> Обновить</button>
    </div>
    <p className="catalog-muted">{scenario !== 'gaming' ? 'Учитываются только тесты выбранной программы и типа работы. Если их нет, модель остаётся без оценки. Игровые FPS не подтверждают скорость творческих задач.' : 'Оценка относится к тестам источника, а не к FPS конкретной сборки.'} Новые товары появляются здесь автоматически. Проверенные результаты добавляются в локальный реестр без платного API.</p>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Загрузка моделей…</p>}
    {data && <><p>Моделей: <strong>{data.summary.models}</strong> · Требуют проверки: <strong>{data.summary.pending}</strong> · Товаров: {data.summary.products}</p>
      {!data.items.length && <p>По выбранным условиям моделей нет.</p>}
      <div className="performance-list">{data.items.map((row, index) => <article className="performance-model" key={`${row.type}-${row.model}-${row.memory_gb}-${index}`}>
        <div className="performance-model-heading"><h2>{row.type.toUpperCase()} · {row.model || 'Модель не определена'}{row.type === 'gpu' && row.memory_gb != null ? ` · ${row.memory_gb} ГБ` : ''}</h2>
          <span className={`performance-status ${row.status === 'measured' ? 'is-measured' : ''}`}>{row.status === 'measured' ? 'Есть тесты' : row.status === 'reference_only' ? 'Есть тесты · применимость требует уточнения' : row.status === 'identity_missing' ? 'Уточните модель чипа' : 'Производительность не оценена'}</span></div>
        {row.status === 'reference_only' && <p className="catalog-muted">Измерения сохранены справочно и не участвуют в рейтинге подбора. Для Twinmotion это тяжёлая сцена около 20 ГБ VRAM; нужны сведения о режиме рендера и размере проекта клиента.</p>}
        {row.evidence.map((item, i) => <p className="catalog-muted" key={i}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.scenario} · источник</a> · Проверено: {item.checked_at}<br />{item.metric}</p>)}
        <details><summary>Связанные товары: {row.products.length}</summary><ul>{row.products.map(product => <li key={product.id}><Link to={`/admin/catalog/${product.id}`}>{product.name}</Link><small>SKU: {product.sku} · {product.selection_enabled && product.validity_check ? 'Допущен к подбору' : 'Допуск к подбору не подтверждён'}</small></li>)}</ul></details>
      </article>)}</div>
      <div className="catalog-actions performance-pagination"><button className="catalog-button" disabled={page <= 1 || busy} onClick={() => setPage(p => p - 1)}>Назад</button><span>Страница {page} из {Math.max(1, Math.ceil(data.total / 25))}</span><button className="catalog-button" disabled={page * 25 >= data.total || busy} onClick={() => setPage(p => p + 1)}>Далее</button></div>
    </>}
  </section>
}
