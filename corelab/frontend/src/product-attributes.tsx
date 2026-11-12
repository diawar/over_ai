import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useState } from 'react'

export type AttributeValue = {
  code: string
  label: string
  value: string | number | boolean | unknown[] | Record<string, unknown> | null
  unit: string | null
  value_state: 'known' | 'unknown' | 'not_applicable'
  source_url: string | null
  source_kind: string | null
}

export type AttributeOption = {
  code: string
  label: string
  value_type: 'string' | 'number' | 'integer' | 'boolean' | 'url' | 'enum' | 'list'
  unit: string | null
  allowed_values: (string | number | boolean)[]
  minimum: number | null
  maximum: number | null
  max_length: number | null
  format: string | null
  editable: boolean
  edit_reason: string | null
}

type Draft = { value_state: AttributeValue['value_state']; value: unknown }
type ExistingValue = { key: string; value: unknown; count: number }
const sourceNames: Record<string, string> = {
  manual: 'Ручной ввод', manufacturer_site: 'Сайт производителя',
  manufacturer_document: 'Документ производителя', ai_official: 'AI по официальному источнику',
  retailer_site: 'Магазин: Белый Ветер, DNS или Технодом', ai_retailer: 'AI по данным магазина',
}
const csrf = () => decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
const initialDraft = (item?: AttributeValue): Draft => ({
  value_state: item?.value_state ?? 'unknown', value: item?.value ?? '',
})

export function ProductAttributesEditor({ productId, items, available, onSaved }: {
  productId: number; items: AttributeValue[]; available: AttributeOption[]; onSaved: () => void
}) {
  const [selectedCode, setSelectedCode] = useState('')
  const [editing, setEditing] = useState<{ option: AttributeOption; existing?: AttributeValue } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AttributeValue | null>(null)
  const [draft, setDraft] = useState<Draft>(initialDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [existingValues, setExistingValues] = useState<ExistingValue[]>([])
  const [valuesLoading, setValuesLoading] = useState(false)
  const [valuesError, setValuesError] = useState('')
  const [selectedExisting, setSelectedExisting] = useState('')

  useEffect(() => {
    if (!editing) return
    const controller = new AbortController()
    setExistingValues([]); setSelectedExisting(''); setValuesError(''); setValuesLoading(true)
    const options = { credentials: 'include' as const, signal: controller.signal }
    async function loadValues() {
      const dictionary = await fetch('/api/v1/admin/properties/dictionary', options)
      if (!dictionary.ok) throw new Error('Не удалось загрузить справочник свойств')
      const attributes = await dictionary.json() as { items: { id: number; code: string }[] }
      const attribute = attributes.items.find(item => item.code === editing?.option.code)
      if (!attribute) throw new Error('Свойство не найдено в справочнике')
      const response = await fetch(`/api/v1/admin/properties/dictionary/${attribute.id}/values`, options)
      if (!response.ok) throw new Error('Не удалось загрузить существующие значения')
      const result = await response.json() as { items: ExistingValue[] }
      if (!controller.signal.aborted) setExistingValues(result.items)
    }
    void loadValues().catch(reason => { if (!controller.signal.aborted) setValuesError(reason instanceof Error ? reason.message : 'Не удалось загрузить значения') })
      .finally(() => { if (!controller.signal.aborted) setValuesLoading(false) })
    return () => controller.abort()
  }, [editing?.option.code])

  function begin(option: AttributeOption, existing?: AttributeValue) {
    if (!option.editable) return
    setEditing({ option, existing }); setDraft(initialDraft(existing)); setError('')
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!editing) return
    setBusy(true); setError('')
    try {
      let value = draft.value
      if (draft.value_state === 'known') {
        if (editing.option.value_type === 'list') value = typeof value === 'string' ? JSON.parse(value) : value
        else if (editing.option.value_type === 'number' || editing.option.value_type === 'integer') value = String(value)
      } else value = null
      const response = await fetch(`/api/v1/admin/catalog/${productId}/attributes/${encodeURIComponent(editing.option.code)}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ value_state: draft.value_state, value, source_kind: 'manual', source_url: null }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось сохранить характеристику')
      setEditing(null); onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Проверьте значение характеристики') }
    finally { setBusy(false) }
  }

  async function deleteAttribute() {
    if (!pendingDelete) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/v1/admin/catalog/${productId}/attributes/${encodeURIComponent(pendingDelete.code)}`, {
        method: 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify({ expected_value_state: pendingDelete.value_state, expected_value: pendingDelete.value,
          expected_source_kind: pendingDelete.source_kind, expected_source_url: pendingDelete.source_url }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось удалить характеристику')
      setPendingDelete(null); onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось удалить характеристику') }
    finally { setBusy(false) }
  }

  function display(item: AttributeValue) {
    if (item.value_state === 'unknown') return 'Неизвестно'
    if (item.value_state === 'not_applicable') return 'Не применимо'
    if (item.value == null) return 'Не указано'
    return typeof item.value === 'object' ? JSON.stringify(item.value) : typeof item.value === 'boolean' ? item.value ? 'Да' : 'Нет' : String(item.value)
  }

  function valueInput() {
    if (!editing || draft.value_state !== 'known') return null
    const type = editing.option.value_type
    const updateValue = (value: unknown) => { setSelectedExisting(''); setDraft(current => ({ ...current, value })) }
    if (type === 'boolean') return <select aria-label="Значение свойства" value={String(draft.value)} onChange={event => updateValue(event.target.value === 'true')}><option value="true">Да</option><option value="false">Нет</option></select>
    if (type === 'enum' && editing.option.allowed_values.length) return <select aria-label="Значение свойства" value={JSON.stringify(draft.value)} onChange={event => updateValue(JSON.parse(event.target.value))}><option value="">Выберите значение</option>{editing.option.allowed_values.map(value => <option key={JSON.stringify(value)} value={JSON.stringify(value)}>{String(value)}</option>)}</select>
    if (type === 'list') return <textarea aria-label="Значение свойства" value={typeof draft.value === 'string' ? draft.value : JSON.stringify(draft.value)} placeholder='Введите список в формате JSON, например ["PCIe 4.0", "SATA"]' onChange={event => updateValue(event.target.value)} />
    return <input aria-label="Значение свойства" type="text" inputMode={type === 'number' || type === 'integer' ? 'decimal' : undefined} value={String(draft.value ?? '')} onChange={event => updateValue(event.target.value)} />
  }

  function editor(option: AttributeOption, existing?: AttributeValue) {
    return <form className="product-attribute-editor" onSubmit={save}>
      <label>Состояние<select value={draft.value_state} onChange={event => setDraft(current => ({ ...current, value_state: event.target.value as Draft['value_state'] }))}><option value="known">Значение известно</option><option value="unknown">Неизвестно</option><option value="not_applicable">Не применимо</option></select></label>
      {draft.value_state === 'known' && <label>Существующие значения<select aria-label="Выбрать существующее значение" value={selectedExisting} disabled={valuesLoading || !existingValues.length} onChange={event => { const index = event.target.value; setSelectedExisting(index); if (index !== '') setDraft(current => ({ ...current, value: existingValues[Number(index)].value })) }}><option value="">{valuesLoading ? 'Загружаем значения…' : existingValues.length ? 'Выберите значение или введите своё' : 'Значений пока нет'}</option>{existingValues.map((item, index) => <option key={item.key} value={index}>{typeof item.value === 'boolean' ? item.value ? 'Да' : 'Нет' : typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value)} ({item.count})</option>)}</select></label>}
      {valuesError && <p role="alert">{valuesError}</p>}
      {valueInput()}
      {error && <p role="alert">{error}</p>}
      <button className="catalog-button" type="submit" disabled={busy} aria-label={`Сохранить ${option.label}`}>{busy ? 'Сохраняем…' : <AppIcon name="check" />}</button>
      <button className="catalog-button" type="button" disabled={busy} aria-label={`Отменить ${option.label}`} onClick={() => { setEditing(null); setError('') }}><AppIcon name="x" /></button>
    </form>
  }

  const remaining = available.filter(option => !items.some(item => item.code === option.code))
  return <section className="product-attributes-editor" aria-label="Редактирование характеристик">
    <div className="product-attribute-list">
      {items.map(item => {
        const option = available.find(candidate => candidate.code === item.code)
        return <div className="product-attribute-row" key={item.code}><div><strong>{item.label}</strong><small>{display(item)}{item.value_state === 'known' && item.value != null && item.unit ? ` ${item.unit}` : ''}</small>
          {item.source_kind && <small>Источник: {sourceNames[item.source_kind] ?? item.source_kind}{item.source_url && <> · <a href={item.source_url} target="_blank" rel="noreferrer">Открыть</a></>}</small>}
          {editing?.option.code === item.code ? editor(editing.option, item) : null}
        </div><div className="product-attribute-actions"><button className="catalog-text-button" type="button" disabled={!option?.editable || Boolean(editing) || busy} aria-label={`Изменить ${item.label}`} title={option?.edit_reason ?? undefined} onClick={() => option && begin(option, item)}>Изменить</button><button className="catalog-text-button" type="button" disabled={Boolean(editing) || busy} aria-label={`Удалить ${item.label}`} onClick={() => { setPendingDelete(item); setError('') }}>Удалить</button></div></div>
      })}
    </div>
    {remaining.length > 0 && <div className="product-attribute-add"><label>Добавить свойство<select aria-label="Добавить свойство" value={selectedCode} onChange={event => setSelectedCode(event.target.value)}><option value="">Выберите свойство</option>{remaining.map(option => <option key={option.code} value={option.code} disabled={!option.editable}>{option.label}</option>)}</select></label><button className="catalog-button" type="button" disabled={!selectedCode || Boolean(editing)} onClick={() => { const option = remaining.find(item => item.code === selectedCode); if (option) { begin(option); setSelectedCode('') } }}>Добавить</button></div>}
    {editing && !editing.existing && <div className="product-attribute-row new-attribute"><strong>{editing.option.label}</strong>{editor(editing.option)}</div>}
    {pendingDelete && <div className="catalog-bulk-overlay"><section className="catalog-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="product-attribute-delete-title"><div className="catalog-bulk-heading"><div><h2 id="product-attribute-delete-title">Удалить свойство товара</h2><p>{pendingDelete.label} · {display(pendingDelete)}</p></div><button className="catalog-button" type="button" disabled={busy} aria-label="Закрыть удаление свойства" onClick={() => { setPendingDelete(null); setError('') }}><AppIcon name="x" /></button></div><div className="catalog-bulk-preview"><p>Свойство исчезнет из карточки этого товара. Допуск к подбору будет пересчитан.</p>{error && <p role="alert">{error}</p>}<div className="catalog-bulk-actions"><button className="catalog-button" type="button" disabled={busy} onClick={() => { setPendingDelete(null); setError('') }}>Отмена</button><button className="catalog-button catalog-bulk-primary" type="button" disabled={busy} onClick={() => void deleteAttribute()}>{busy ? 'Удаляем…' : 'Подтвердить удаление'}</button></div></div></section></div>}
  </section>
}
