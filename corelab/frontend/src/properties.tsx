import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import './properties.css'

const API = import.meta.env.VITE_API_URL ?? ''
const levels: Record<string, string> = { required: 'Обязательно', conditional: 'Условно обязательно', recommended: 'Рекомендуется', optional: 'Необязательно' }
const statuses: Record<string, string> = { success: 'Успешно', warning: 'Предупреждение', error: 'Ошибка' }
type Rule = { id?: number; attribute_id?: number | null; scope?: string; revision?: number; code: string; label: string; source: string; level: string; value_type: string; unit: string | null; condition: object | null; applies_when: object | null; allowed_values: unknown[]; normalization: object; minimum: number | null; maximum: number | null; max_length: number | null; format: string | null; evidence_url: string | null; checked_on: string | null; note: string; ai_blocked: boolean; required_for_selection: boolean; default_value?: unknown }
type Check = { status: string; structure_status: string; current: boolean; errors: string[]; warnings: string[] }
type RuleResult = { category: { id: number; name: string; selection_category: boolean; required_for_build: boolean; template_code: string | null }; items: Rule[]; check: Check }
type Report = { status: string; groups: Record<string, { status: string; findings: { label: string; message: string; severity: string; evidence_url: string | null }[] }>; scope: string }
type Template = { code: string; label: string; attributes: { code: string; label: string; source: string }[] }
const emptyRule = (): Rule => ({ code: '', label: '', source: 'internal', level: 'recommended', value_type: 'string', unit: null, condition: null, applies_when: null, allowed_values: [], normalization: {}, minimum: null, maximum: null, max_length: null, format: null, evidence_url: null, checked_on: null, note: '', ai_blocked: false, required_for_selection: false })

async function request(path: string, method = 'GET', body?: unknown) {
  const token = decodeURIComponent(document.cookie.split('; ').find(p => p.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
  const response = await fetch(`${API}/api/v1/admin/properties${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : Array.isArray(data.detail) ? data.detail.map((e: { msg: string }) => e.msg).join('; ') : 'Не удалось выполнить операцию')
  return data
}

function RuleEditor({ rule, onSave, onCancel, busy }: { rule: Rule; onSave: (r: Rule) => void; onCancel: () => void; busy: boolean }) {
  const [form, setForm] = useState(rule)
  const [condition, setCondition] = useState(rule.condition ? JSON.stringify(rule.condition, null, 2) : '')
  const [applies, setApplies] = useState(rule.applies_when ? JSON.stringify(rule.applies_when, null, 2) : '')
  const [allowed, setAllowed] = useState(JSON.stringify(rule.allowed_values))
  const [normalization, setNormalization] = useState(JSON.stringify(rule.normalization))
  const [error, setError] = useState('')
  const field = (key: keyof Rule, value: unknown) => setForm(previous => ({ ...previous, [key]: value }))
  function save(event: React.FormEvent) {
    event.preventDefault(); setError('')
    try { onSave({ ...form, condition: condition.trim() ? JSON.parse(condition) : null, applies_when: applies.trim() ? JSON.parse(applies) : null, allowed_values: JSON.parse(allowed), normalization: JSON.parse(normalization) }) }
    catch { setError('Проверьте JSON условий, допустимых значений и нормализации.') }
  }
  return <form className="property-editor" onSubmit={save}>
    <header className="property-editor-header"><div><span className="property-editor-kicker">НАСТРОЙКА КАТАЛОГА</span><h2>{rule.id ? 'Изменить свойство' : 'Добавить свойство'}</h2><p>Задайте название и формат данных, затем настройте проверки и правила применения.</p></div></header>
    <section className="property-editor-section"><div className="property-editor-section-heading"><h3>Основное</h3><p>Название и тип значения, которые увидит редактор товара.</p></div><div className="property-fields property-fields-primary">
      <label>Название свойства<input required value={form.label} onChange={e => field('label', e.target.value)} /></label>
      <label>Код свойства<input required pattern="[a-z][a-z0-9_]{0,159}" maxLength={160} autoComplete="off" title="Латинские строчные буквы, цифры и _. Начните с буквы. Пример: memory_type" value={form.code} disabled={!!rule.id} onChange={e => field('code', e.target.value)} /><small>Латинские строчные буквы, цифры и _. Например, <code>memory_type</code>.</small></label>
      <label>Тип данных<select value={form.value_type} onChange={e => field('value_type', e.target.value)}>{Object.entries({ string: 'Текст', number: 'Число', integer: 'Целое число', boolean: 'Да / Нет', url: 'Ссылка', enum: 'Перечисление', list: 'Список' }).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Единица измерения<input placeholder="Например, МГц" value={form.unit ?? ''} onChange={e => field('unit', e.target.value || null)} /></label>
    </div></section>
    <section className="property-editor-section"><div className="property-editor-section-heading"><h3>Обязательность и проверки</h3><p>Определяет, как заполненность и формат свойства влияют на проверку товара.</p></div><div className="property-fields">
      <label>Обязательность заполнения<select value={form.level} onChange={e => field('level', e.target.value)}>{Object.entries(levels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><small>Отсутствие обязательного значения — ошибка; рекомендуемого — предупреждение.</small></label>
      <label>Проверка формата<select value={form.format ?? ''} onChange={e => field('format', e.target.value || null)}><option value="">По типу данных</option><option value="gtin">GTIN</option><option value="currency">Код валюты</option><option value="date_time">Дата ISO 8601</option></select></label>
      <label>Минимум<input type="number" step="any" value={form.minimum ?? ''} onChange={e => field('minimum', e.target.value === '' ? null : Number(e.target.value))} /></label>
      <label>Максимум<input type="number" step="any" value={form.maximum ?? ''} onChange={e => field('maximum', e.target.value === '' ? null : Number(e.target.value))} /></label>
      <label>Максимальная длина<input type="number" min="1" value={form.max_length ?? ''} onChange={e => field('max_length', e.target.value === '' ? null : Number(e.target.value))} /></label>
    </div></section>
    <section className="property-editor-section"><div className="property-editor-section-heading"><h3>Использование свойства</h3><p>Управляет проверкой характеристик карточек.</p></div><div className="property-editor-options">
      <label><input type="checkbox" checked={form.required_for_selection} onChange={e => { field('required_for_selection', e.target.checked); if (e.target.checked) field('level', 'required') }} /><span><strong>Обязательно для конфигуратора</strong><small>Значение участвует в проверке допуска товара к конфигуратору.</small></span></label>
    </div></section>
    <section className="property-editor-section"><div className="property-editor-section-heading"><h3>Источник и примечание</h3><p>Зафиксируйте основание характеристики и дополнительный контекст.</p></div><div className="property-fields">
      <label>Ссылка на источник или основание<input type="url" placeholder="https://" value={form.evidence_url ?? ''} onChange={e => field('evidence_url', e.target.value || null)} /></label>
      <label>Дата проверки источника<input type="date" value={form.checked_on ?? ''} onChange={e => field('checked_on', e.target.value || null)} /></label>
    </div><label className="property-editor-note">Примечание<textarea rows={3} value={form.note} onChange={e => field('note', e.target.value)} /></label></section>
    <details className="property-editor-advanced" open={form.level === 'conditional'}><summary>Условия и допустимые значения</summary><p>Используйте JSON для условных требований, ограничений выбора и нормализации значений. Неизвестное условие требует проверки.</p><div className="property-fields">
      <label>Условие обязательности<textarea aria-label="Условие обязательности" value={condition} onChange={e => setCondition(e.target.value)} placeholder={'{"op":"eq","field":"context.country","value":"KZ"}'} /></label>
      <label>Применимость правила<textarea value={applies} onChange={e => setApplies(e.target.value)} placeholder="Необязательно" /></label>
      <label>Допустимые значения<textarea value={allowed} onChange={e => setAllowed(e.target.value)} /></label>
      <label>Нормализация<textarea value={normalization} onChange={e => setNormalization(e.target.value)} /></label>
    </div></details>
    {error && <p className="property-editor-error" role="alert">{error}</p>}
    <footer className="property-editor-footer"><button className="catalog-button property-save" disabled={busy} type="submit">{busy ? 'Сохраняем…' : 'Сохранить свойство'}</button><button className="catalog-button" disabled={busy} type="button" onClick={onCancel}>Отмена</button></footer>
  </form>
}

function ValidationReport({ report }: { report: Report }) {
  return <div className="property-report" role="status"><h3>Результат: {statuses[report.status]}</h3>{Object.entries(report.groups).map(([source, group]) => <section key={source}><h4>{source === 'gmc' ? 'Выбранные поля GMC' : 'Внутренние требования'} — {statuses[group.status]}</h4>{group.findings.length ? <ul>{group.findings.map((finding, i) => <li key={i}><strong>{statuses[finding.severity]} · {finding.label}:</strong> {finding.message} {finding.evidence_url && <a href={finding.evidence_url} target="_blank" rel="noreferrer">Источник</a>}</li>)}</ul> : <p>Нарушений сохранённых правил не обнаружено.</p>}</section>)}<p className="catalog-muted">{report.scope}</p></div>
}

export function PropertyRulesPage() {
  const { categoryId } = useParams()
  // A new category owns a fresh set of forms and async state setters.
  // Responses for an unmounted category cannot update the next category.
  return categoryId ? <CategoryPropertyRules key={categoryId} categoryId={categoryId} /> : null
}

function CategoryPropertyRules({ categoryId }: { categoryId: string }) {
  const [data, setData] = useState<RuleResult | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [template, setTemplate] = useState('empty')
  const [pendingTemplate, setPendingTemplate] = useState<{ code: string; label: string; missing: Template['attributes'] } | null>(null)
  const [edit, setEdit] = useState<Rule | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Rule | null>(null)
  const [previewValues, setPreviewValues] = useState('{}')
  const [previewContext, setPreviewContext] = useState('{}')
  const [report, setReport] = useState<Report | null>(null)
  const interactionRef = useRef<HTMLDivElement>(null)
  const templateConfirmRef = useRef<HTMLElement>(null)
  const path = `/categories/${categoryId}`
  const selectedTemplate = templates.find(item => item.code === template)
  useEffect(() => { let active = true; Promise.all([request(path), request('/templates')]).then(([d, t]) => { if (active) { setData(d); setTemplate(d.category.template_code ?? 'empty'); setTemplates(t.items) } }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [path])
  useEffect(() => {
    if (!edit && !pendingDelete) return
    const frame = window.requestAnimationFrame(() => interactionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [edit, pendingDelete])
  useEffect(() => {
    if (!pendingTemplate) return
    const frame = window.requestAnimationFrame(() => templateConfirmRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [pendingTemplate])
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await work(); setData(await request(path)) } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка операции') } finally { setBusy(false) }
  }
  async function toggleCategorySelection() {
    if (!data) return
    await action(async () => {
      const token = decodeURIComponent(document.cookie.split('; ').find(part => part.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
      const response = await fetch(`${API}/api/v1/admin/catalog/categories/${categoryId}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ selection_category: !data.category.selection_category }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось изменить участие категории в подборе.')
      setData(await request(path))
    })
  }
  async function toggleCategoryBuildRequirement() {
    if (!data) return
    await action(async () => {
      const token = decodeURIComponent(document.cookie.split('; ').find(part => part.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
      const response = await fetch(`${API}/api/v1/admin/catalog/categories/${categoryId}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify({ required_for_build: !data.category.required_for_build }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось изменить обязательность категории.')
    })
  }
  const payload = (rule: Rule) => { const { id: _id, attribute_id: _attributeId, scope: _scope, revision: _revision, ...body } = rule; return body }
  async function previewTemplate() {
    if (!data || !selectedTemplate) return
    const missing = selectedTemplate.attributes.filter(attribute => !data.items.some(rule => rule.code === attribute.code && rule.source === attribute.source))
    const nameMatches = data.category.name.trim().toLocaleLowerCase('ru') === selectedTemplate.label.trim().toLocaleLowerCase('ru')
    if (data.category.template_code === selectedTemplate.code || (!data.category.template_code && nameMatches)) {
      await action(() => request(`${path}/defaults`, 'POST', { template: selectedTemplate.code }))
      return
    }
    setPendingTemplate({ code: selectedTemplate.code, label: selectedTemplate.label, missing })
  }
  async function applyTemplate() {
    if (!pendingTemplate) return
    const code = pendingTemplate.code
    setPendingTemplate(null)
    await action(() => request(`${path}/defaults`, 'POST', { template: code }))
  }
  return <section className="catalog-page properties-page"><Link to="/admin/catalog"><AppIcon name="arrow-left" /> Каталог</Link><h1>Категория: {data?.category.name ?? 'загрузка…'}</h1><p>Настройки категории и структура её свойств.</p>
    {data && <section className="category-selection-setting"><h2>Участие в конфигураторе</h2><label><input type="checkbox" checked={data.category.selection_category} disabled={busy} onChange={toggleCategorySelection} /><span><strong>{data.category.selection_category ? 'Категория участвует в конфигураторе' : 'Категория исключена из конфигуратора'}</strong><small>Когда настройка включена, товары этой категории проверяются по обязательным для конфигуратора свойствам. Если других включённых категорий у товара нет, допуск к конфигуратору не рассчитывается.</small></span></label><label><input type="checkbox" checked={data.category.required_for_build} disabled={busy || !data.category.selection_category} onChange={toggleCategoryBuildRequirement} /><span><strong>Обязательно включать категорию в сборку</strong><small>Новая сборка должна содержать комплектующее этой категории. Настройка независима от обязательных свойств.</small></span></label></section>}
    {error && <p role="alert">{error}</p>}
    <div className="property-actions"><button className="catalog-button" disabled={busy || !data} onClick={() => action(() => request(`${path}/check`, 'POST'))}>Проверить структуру свойств</button><button className="catalog-button" disabled={busy || !data} onClick={() => setEdit(emptyRule())}>Добавить свойство</button></div>
    <div className="property-template-controls"><label>Шаблон категории<select aria-label="Шаблон категории" value={template} onChange={e => setTemplate(e.target.value)}><option value="empty">Без шаблона</option>{templates.map(t => <option key={t.code} value={t.code}>{t.label}</option>)}</select></label><button className="catalog-button" disabled={busy || !data || !selectedTemplate || (!!selectedTemplate && data?.category.template_code === selectedTemplate.code && selectedTemplate.attributes.every(attribute => data.items.some(rule => rule.code === attribute.code && rule.source === attribute.source)))} onClick={previewTemplate}>{data?.category.template_code === selectedTemplate?.code ? 'Добавить отсутствующие свойства' : 'Назначить шаблон и добавить свойства'}</button></div>
    <p className="catalog-muted">Закреплённый шаблон: {templates.find(item => item.code === data?.category.template_code)?.label ?? 'не назначен'}.</p>
    {pendingTemplate && <section ref={templateConfirmRef} className="property-template-confirm" role="alertdialog" aria-labelledby="property-template-confirm-title"><h2 id="property-template-confirm-title">Проверьте шаблон категории</h2><p>Категория: <strong>{data?.category.name}</strong></p><p>Будет закреплён шаблон: <strong>{pendingTemplate.label}</strong></p>{pendingTemplate.missing.length ? <><p>Будут добавлены или восстановлены свойства:</p><ul>{pendingTemplate.missing.map(attribute => <li key={`${attribute.source}:${attribute.code}`}>{attribute.label}</li>)}</ul></> : <p>Все свойства шаблона уже есть в категории.</p>}<p>Другие свойства категории сохранятся.</p><div className="property-actions"><button className="catalog-button" disabled={busy || (pendingTemplate.missing.length === 0 && data?.category.template_code === pendingTemplate.code)} onClick={applyTemplate}>{data?.category.template_code === pendingTemplate.code ? 'Подтвердить добавление' : 'Закрепить шаблон и добавить свойства'}</button><button className="catalog-button" disabled={busy} onClick={() => setPendingTemplate(null)}>Отмена</button></div></section>}
    {data && <div className="property-check">
      <p><strong>{data.check.current ? 'Проверка актуальна' : 'Структуру необходимо проверить'}</strong></p>
      {data.check.structure_status === 'error'
        ? <div className="property-structure-error" role="alert"><strong>Статус структуры: Ошибка</strong>{[...data.check.errors, ...data.check.warnings].map((message, i) => <p key={i}>{message}</p>)}</div>
        : <><div className={data.check.current ? 'property-structure-success' : undefined} role={data.check.current ? 'status' : undefined}><strong>Статус структуры: {statuses[data.check.structure_status]}</strong></div>{data.check.warnings.map((message, i) => <p key={i}>{message}</p>)}</>}
    </div>}
    {(edit || pendingDelete) && <div ref={interactionRef} className="property-interaction" tabIndex={-1}>
      {edit && <RuleEditor key={edit.id ?? 'new'} rule={edit} busy={busy} onCancel={() => setEdit(null)} onSave={rule => action(async () => { await request(rule.id ? `/rules/${rule.id}` : `${path}/rules`, rule.id ? 'PATCH' : 'POST', payload(rule)); setEdit(null) })} />}
      {pendingDelete && <div className="property-delete-confirmation" role="alertdialog" aria-labelledby="property-delete-confirmation-title"><strong id="property-delete-confirmation-title">Подтвердите удаление</strong><p>Удалить правило «{pendingDelete.label}» из структуры? Существующие значения и история сохранятся.</p><div className="property-delete-confirmation-actions"><button className="catalog-button" disabled={busy} onClick={() => action(async () => { await request(`/rules/${pendingDelete.id}`, 'DELETE'); setPendingDelete(null) })}>Подтвердить удаление</button><button className="catalog-button" disabled={busy} onClick={() => setPendingDelete(null)}>Отмена удаления</button></div></div>}
    </div>}
    <div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th>Свойство</th><th>Обязательность для карточки товара</th><th>Основание</th><th>Действия</th></tr></thead><tbody>{data?.items.map(rule => <tr className={rule.required_for_selection ? 'selection-participant' : ''} key={rule.id}><td><strong>{rule.attribute_id != null ? <Link className="property-name-link" to={`/admin/properties?attribute=${rule.attribute_id}`}>{rule.label}</Link> : rule.label}</strong><small>{rule.code} · {rule.value_type}{rule.unit ? ` · ${rule.unit}` : ''}</small>{rule.default_value !== undefined && rule.default_value !== null && <small>По умолчанию: {String(rule.default_value)}</small>}{rule.note && <small>{rule.note}</small>}{rule.condition && <details><summary>Условие обязательности</summary><pre>{JSON.stringify(rule.condition, null, 2)}</pre></details>}{rule.applies_when && <details><summary>Применимость</summary><pre>{JSON.stringify(rule.applies_when, null, 2)}</pre></details>}</td><td>{levels[rule.level]}{rule.required_for_selection && <small>Для подбора ПК</small>}</td><td>{rule.source === 'gmc' ? 'Выбранные поля GMC' : 'Каталог'}<small>{rule.scope === 'global' ? 'Все категории' : 'Эта категория'}</small>{rule.evidence_url && <a href={rule.evidence_url} target="_blank" rel="noreferrer">Источник · {rule.checked_on}</a>}</td><td><button className="catalog-text-button" disabled={busy} onClick={() => setEdit(rule)}>Изменить</button>{rule.scope !== 'global' && <button className="catalog-text-button" disabled={busy} onClick={() => setPendingDelete(rule)}>Удалить</button>}</td></tr>)}</tbody></table></div>
    <details className="property-preview"><summary>Проверить пример данных без записи в карточки</summary><p>Проверь, как правила категории оценят тестовые свойства: введи их коды и значения в формате JSON, при необходимости добавь контекст условий и нажми «Проверить пример». Данные товаров не изменяются.</p><label>Значения свойств (JSON)<textarea value={previewValues} onChange={e => setPreviewValues(e.target.value)} /></label><label>Контекст условий (JSON)<textarea value={previewContext} onChange={e => setPreviewContext(e.target.value)} /></label><p>Страна задаётся в контексте, например country: KZ. Состояния значений: known, unknown, not_applicable. Логическое false означает «Нет».</p><button className="catalog-button" disabled={busy} onClick={() => action(async () => setReport(await request(`${path}/preview`, 'POST', { values: JSON.parse(previewValues), context: JSON.parse(previewContext) })))}>Проверить пример</button>{report && <ValidationReport report={report} />}</details>
  </section>
}

export function ProductPropertyCheck({ productId }: { productId: number }) {
  const [report, setReport] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function validate() {
    setBusy(true); setError('')
    try { setReport(await request(`/products/${productId}/validate`, 'POST', {})) }
    catch (e) { setError(e instanceof Error ? e.message : 'Ошибка проверки') } finally { setBusy(false) }
  }
  return <section className="property-product-check"><h2>Проверка характеристик товара</h2><div className="property-actions"><button className="catalog-button" disabled={busy} onClick={validate}>{busy ? 'Проверяем…' : 'Проверить данные товара'}</button></div>{error && <p role="alert">{error}</p>}{report && <ValidationReport report={report} />}</section>
}
