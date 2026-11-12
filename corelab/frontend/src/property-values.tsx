import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import './catalog.css'
import './property-values.css'

const API = import.meta.env.VITE_API_URL ?? ''
type Attribute = { id: number; code: string; label: string; value_type: string; filled_count: number; used_for_selection?: boolean }
type Value = { key: string; value: unknown; count: number; registered?: boolean }
type ValuesResult = { attribute: Attribute; items: Value[]; total_products: number; linked_products: number; merge_supported: boolean }
const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)
type SortKey = 'value' | 'count'
type SortDirection = 'asc' | 'desc'
const valueCollator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

export function PropertyValuesPage() {
  const [params, setParams] = useSearchParams()
  const selectedId = Number(params.get('attribute')) || null
  const [attributes, setAttributes] = useState<Attribute[]>([])
  const [data, setData] = useState<ValuesResult | null>(null)
  const [search, setSearch] = useState('')
  const [valueSearch, setValueSearch] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [target, setTarget] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [deleteAttributeOpen, setDeleteAttributeOpen] = useState(false)
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | 'delete' | null>(null)
  const [editorItem, setEditorItem] = useState<Value | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [revision, setRevision] = useState(0)
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/api/v1/admin/properties/dictionary`, { credentials: 'include', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Не удалось загрузить свойства'); return response.json() })
      .then(result => {
        if (controller.signal.aborted) return
        setAttributes(result.items)
        if (!selectedId && result.items.length) {
          const initial = result.items.find((item: Attribute) => item.code === 'gpu_graphics_processor') ?? result.items[0]
          setParams({ attribute: String(initial.id) }, { replace: true })
        }
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [revision])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    setData(null); setSources([]); setTarget(''); setMergeOpen(false); setDeleteAttributeOpen(false); setEditorMode(null); setConfirming(false); setError('')
    fetch(`${API}/api/v1/admin/properties/dictionary/${selectedId}/values`, { credentials: 'include', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Не удалось загрузить значения'); return response.json() })
      .then(result => { if (!controller.signal.aborted) setData(result) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [selectedId, revision])

  const visibleAttributes = useMemo(() => attributes.filter(item =>
    `${item.label} ${item.code}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))), [attributes, search])
  const visibleValues = useMemo(() => (data?.items ?? []).filter(item =>
    display(item.value).toLocaleLowerCase('ru').includes(valueSearch.trim().toLocaleLowerCase('ru')))
    .sort((a, b) => {
      const byValue = valueCollator.compare(display(a.value), display(b.value))
      const result = sortKey === 'value' ? byValue : a.count - b.count || byValue
      return sortDirection === 'asc' ? result : -result
    }), [data, valueSearch, sortKey, sortDirection])
  const targetChoices = data?.items.filter(item => sources.includes(item.key)) ?? []
  const counts = new Map(data?.items.map(item => [item.key, item.count]) ?? [])
  const labels = new Map(data?.items.map(item => [item.key, display(item.value)]) ?? [])
  const affected = sources.filter(value => value !== target).reduce((sum, value) => sum + (counts.get(value) ?? 0), 0)

  function sortBy(key: SortKey) {
    if (sortKey === key) setSortDirection(current => current === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDirection(key === 'value' ? 'asc' : 'desc') }
  }

  function toggleSource(value: string) {
    setConfirming(false); setMessage('')
    setSources(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])
    if (target === value) setTarget('')
  }
  function closeMerge() {
    setMergeOpen(false); setConfirming(false); setTarget(''); setError('')
  }
  function openEditor(mode: 'create' | 'edit' | 'delete', item: Value | null = null) {
    setEditorMode(mode); setEditorItem(item); setDraft(item ? display(item.value) : data?.attribute.value_type === 'boolean' ? 'true' : '')
    setError(''); setMessage('')
  }
  function closeEditor() { setEditorMode(null); setEditorItem(null); setError('') }
  async function saveValue() {
    if (!data || !editorMode || busy) return
    setBusy(true); setError('')
    try {
      let value: unknown = draft
      if (data.attribute.value_type === 'boolean') value = draft === 'true'
      if (data.attribute.value_type === 'list') value = JSON.parse(draft)
      const token = decodeURIComponent(document.cookie.split('; ').find(part => part.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
      const path = `${API}/api/v1/admin/properties/dictionary/${data.attribute.id}/values`
      const method = editorMode === 'create' ? 'POST' : editorMode === 'edit' ? 'PATCH' : 'DELETE'
      const body = editorMode === 'create' ? { value } : editorMode === 'edit'
        ? { key: editorItem?.key, value, expected_count: editorItem?.count }
        : { key: editorItem?.key, expected_count: editorItem?.count }
      const response = await fetch(path, { method, credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) })
      if (!response.ok) {
        const result = await response.json()
        throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось сохранить значение')
      }
      const result = await response.json()
      setMessage(editorMode === 'create' ? `Значение добавлено: ${display(result.value)}` :
        editorMode === 'edit' ? `Значение изменено. Обновлено товаров: ${result.updated_products}` :
          `Значение удалено. Затронуто товаров: ${result.updated_products}`)
      setEditorMode(null); setEditorItem(null); setRevision(current => current + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить значение') }
    finally { setBusy(false) }
  }
  async function merge() {
    if (!data || !target || sources.length < 2 || !sources.includes(target)) return
    setBusy(true); setError(''); setMessage('')
    try {
      const expected_counts = Object.fromEntries(sources.map(value => [value, counts.get(value)]))
      const token = decodeURIComponent(document.cookie.split('; ').find(part => part.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
      const response = await fetch(`${API}/api/v1/admin/properties/dictionary/${data.attribute.id}/merge`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ sources: sources.filter(value => value !== target), target, expected_counts }),
      })
      if (!response.ok) {
        const result = await response.json()
        throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось объединить значения')
      }
      const result = await response.json()
      setMessage(`Обновлено товаров: ${result.updated_products}. Значение: ${labels.get(result.target) ?? result.target}`)
      setMergeOpen(false)
      setRevision(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось объединить значения') }
    finally { setBusy(false) }
  }

  async function deleteAttribute() {
    if (!data || busy) return
    setBusy(true); setError('')
    try {
      const token = decodeURIComponent(document.cookie.split('; ').find(part => part.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
      const response = await fetch(`${API}/api/v1/admin/properties/dictionary/${data.attribute.id}`, {
        method: 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ code: data.attribute.code, expected_product_count: data.linked_products ?? data.total_products }),
      })
      if (!response.ok) {
        const result = await response.json()
        throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось удалить свойство')
      }
      const deleted = data.attribute.label
      const next = attributes.find(item => item.id !== data.attribute.id)
      setDeleteAttributeOpen(false)
      setMessage(`Свойство «${deleted}» удалено из всех связанных товаров.`)
      setParams(next ? { attribute: String(next.id) } : {})
      setRevision(current => current + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось удалить свойство') }
    finally { setBusy(false) }
  }

  return <section className="catalog-page property-values-page">
    <div className="catalog-heading"><div><p className="catalog-kicker">НОРМАЛИЗАЦИЯ КАТАЛОГА</p><h1>Свойства и значения</h1><p>Просматривайте записанные значения и объединяйте разные названия одного значения.</p></div><Link className="catalog-button" to="/admin/properties/categories">Структуры категорий <AppIcon name="arrow-right" /></Link></div>
    <div className="property-values-layout"><aside className="property-values-list"><label className="catalog-search"><span aria-hidden="true"><AppIcon name="search" /></span><input aria-label="Найти свойство" value={search} onChange={event => setSearch(event.target.value)} placeholder="Название или код" />{search && <button type="button" aria-label="Очистить поиск свойств" onClick={() => setSearch('')}><AppIcon name="x" /></button>}</label><div>{visibleAttributes.map(item => <button key={item.id} className={[selectedId === item.id ? 'selected' : '', item.used_for_selection ? 'selection-participant' : ''].filter(Boolean).join(' ')} onClick={() => { setMessage(''); setParams({ attribute: String(item.id) }) }}><span>{item.label}<small>{item.code}</small>{item.used_for_selection && <small className="selection-badge">Для подбора ПК</small>}</span><strong>{item.filled_count}</strong></button>)}</div></aside>
      <section className="property-values-main">{message && <p className="property-values-success" role="status">{message}</p>}{data ? <><header><div><div className="property-values-title"><h2>{data.attribute.label}</h2><button className="catalog-text-button property-delete-attribute" type="button" disabled={busy} onClick={() => { setDeleteAttributeOpen(true); setError('') }}>Удалить свойство</button></div><p>{data.items.length} значений · {data.total_products} товаров</p></div><label className="catalog-search"><span aria-hidden="true"><AppIcon name="search" /></span><input aria-label="Найти значение" value={valueSearch} onChange={event => setValueSearch(event.target.value)} placeholder="Поиск по значениям" />{valueSearch && <button type="button" aria-label="Очистить поиск значений" onClick={() => setValueSearch('')}><AppIcon name="x" /></button>}</label></header>
        <div className="catalog-actions property-values-actions"><button className="catalog-button" type="button" disabled={busy} onClick={() => openEditor('create')}>Добавить значение</button><span className="catalog-muted">Выбрано значений: {sources.length}</span><button className="catalog-button" type="button" disabled={sources.length < 2 || busy} onClick={() => { setMergeOpen(true); setTarget(''); setConfirming(false); setError('') }}>Объединить значения</button></div>
        <div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th>Выбрать</th><th aria-sort={sortKey === 'value' ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="property-values-sort" type="button" onClick={() => sortBy('value')}>Значение {sortKey === 'value' ? sortDirection === 'asc' ? <AppIcon name="arrow-up" /> : <AppIcon name="arrow-down" /> : <AppIcon name="arrow-up-down" />}</button></th><th aria-sort={sortKey === 'count' ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="property-values-sort" type="button" onClick={() => sortBy('count')}>Товаров {sortKey === 'count' ? sortDirection === 'asc' ? <AppIcon name="arrow-up" /> : <AppIcon name="arrow-down" /> : <AppIcon name="arrow-up-down" />}</button></th><th>Действия</th></tr></thead><tbody>{visibleValues.map(item => <tr key={item.key}><td><input type="checkbox" aria-label={`Объединить ${display(item.value)}`} checked={sources.includes(item.key)} disabled={busy} onChange={() => toggleSource(item.key)} /></td><td>{display(item.value)}</td><td>{item.count}</td><td><div className="property-values-row-actions"><button className="catalog-text-button" type="button" onClick={() => openEditor('edit', item)}>Изменить</button><button className="catalog-text-button" type="button" onClick={() => openEditor('delete', item)}>Удалить</button></div></td></tr>)}</tbody></table>{!visibleValues.length && <p className="properties-index-empty">Значений нет.</p>}</div>
        {deleteAttributeOpen && <div className="catalog-bulk-overlay"><section className="catalog-bulk-dialog" role="alertdialog" aria-modal="true" aria-labelledby="property-delete-attribute-title"><div className="catalog-bulk-heading"><h2 id="property-delete-attribute-title">Удалить свойство «{data.attribute.label}»?</h2></div><div className="catalog-bulk-preview"><p>Свойство и его значения будут удалены из {data.linked_products ?? data.total_products} карточек товаров. Связанные правила категорий тоже будут удалены; допуск товаров будет пересчитан.</p>{error && <p role="alert">{error}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={busy} onClick={() => { setDeleteAttributeOpen(false); setError('') }}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="button" disabled={busy} onClick={deleteAttribute}>{busy ? 'Удаляем…' : 'Подтвердить удаление свойства'}</button></div></div></section></div>}
        {mergeOpen && <div className="catalog-bulk-overlay"><section className="catalog-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="property-merge-title"><div className="catalog-bulk-heading"><div><h2 id="property-merge-title">Объединение значений</h2><p>Свойство: {data.attribute.label}. Выбрано значений: {sources.length}.</p></div><button className="catalog-button" type="button" disabled={busy} aria-label="Закрыть объединение" onClick={closeMerge}><AppIcon name="x" /></button></div>
          {!confirming ? <div className="catalog-bulk-form"><label>Оставить значение<select aria-label="Оставить значение" value={target} onChange={event => setTarget(event.target.value)}><option value="">Выберите значение</option>{targetChoices.map(item => <option key={item.key} value={item.key}>{display(item.value)} · {item.count}</option>)}</select></label><p className="catalog-muted">Остальные выбранные значения будут заменены у товаров.</p>{error && <p role="alert">{error}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={busy} onClick={closeMerge}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="button" disabled={!target || busy} onClick={() => { setConfirming(true); setError('') }}>Предпросмотр объединения</button></div></div>
            : <div className="catalog-bulk-preview"><p>Итоговое значение: <strong>{labels.get(target)}</strong>. Будет обновлено товаров: <strong>{affected}</strong>.</p><ul>{sources.filter(value => value !== target).map(value => <li key={value}><strong>{labels.get(value)}</strong> · {counts.get(value)} товаров <AppIcon name="arrow-right" /> {labels.get(target)}</li>)}</ul><p>Источники характеристик сохранятся, изменение попадёт в журнал.</p>{error && <p role="alert">{error}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={busy} onClick={() => { setConfirming(false); setError('') }}>Назад</button><button className="catalog-button" type="button" disabled={busy} onClick={closeMerge}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="button" disabled={busy} onClick={merge}>{busy ? 'Объединяем…' : 'Подтвердить объединение'}</button></div></div>}
        </section></div>}
        {editorMode && <div className="catalog-bulk-overlay"><section className="catalog-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="property-value-title"><div className="catalog-bulk-heading"><div><h2 id="property-value-title">{editorMode === 'create' ? 'Добавить значение' : editorMode === 'edit' ? 'Изменить значение' : 'Удалить значение'}</h2><p>Свойство: {data.attribute.label}</p></div><button className="catalog-button" type="button" disabled={busy} aria-label="Закрыть окно значения" onClick={closeEditor}><AppIcon name="x" /></button></div>
          {editorMode === 'delete' ? <div className="catalog-bulk-preview"><p>Удалить значение <strong>{editorItem && display(editorItem.value)}</strong>?</p><p>Значение исчезнет из списка и будет удалено из {editorItem?.count} карточек товаров. Допуск товаров будет пересчитан.</p>{error && <p role="alert">{error}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={busy} onClick={closeEditor}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="button" disabled={busy} onClick={saveValue}>{busy ? 'Удаляем…' : 'Подтвердить удаление'}</button></div></div>
            : <form className="catalog-bulk-form" onSubmit={event => { event.preventDefault(); void saveValue() }}><label>Значение{data.attribute.value_type === 'boolean'
              ? <select aria-label="Значение свойства" value={draft} onChange={event => setDraft(event.target.value)}><option value="true">Да</option><option value="false">Нет</option></select>
              : data.attribute.value_type === 'list'
                ? <textarea aria-label="Значение свойства" value={draft} onChange={event => setDraft(event.target.value)} placeholder='["A", "B"]' />
                : <input aria-label="Значение свойства" value={draft} onChange={event => setDraft(event.target.value)} inputMode={data.attribute.value_type === 'number' || data.attribute.value_type === 'integer' ? 'decimal' : undefined} />}</label>
              {editorMode === 'edit' && <p className="catalog-muted">Будет обновлено товаров: {editorItem?.count}. Источники характеристик сохранятся.</p>}{editorMode === 'create' && <p className="catalog-muted">Новое значение появится в списке с нулём товаров.</p>}{error && <p role="alert">{error}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={busy} onClick={closeEditor}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="submit" disabled={busy || (!draft.trim() && data.attribute.value_type !== 'boolean')}>{busy ? 'Сохраняем…' : editorMode === 'create' ? 'Добавить' : 'Сохранить изменение'}</button></div></form>}
        </section></div>}
      </> : <p className="properties-index-empty">{selectedId ? 'Загружаем значения…' : 'Выберите свойство.'}</p>}{error && !mergeOpen && !deleteAttributeOpen && <p className="properties-index-error" role="alert">{error}</p>}</section></div>
  </section>
}
