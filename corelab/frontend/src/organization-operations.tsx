import { adminFetch as fetch } from './admin-fetch'
import { useEffect, useState, useId, type FormEvent, type ReactNode } from 'react'
import { AppIcon } from './icons'
import { operationsDraftKey, readOperationsDraft, writeOperationsDraft } from './operations-draft'

const API = import.meta.env.VITE_API_URL ?? ''
type Calendar = { weekly_days_off: number[]; calendar_exceptions: Exception[] }
type Branch = Calendar & { code: string; name: string; city: string; address: string; active: boolean; kind?: 'branch' | 'warehouse' | 'supplier_warehouse'; source_label?: string }
type Route = { from_branch: string; to_branch: string; workdays: number }
type Exception = { date: string; working: boolean; note: string }
export type Operations = { version: number; assembly_workdays: number; branches: Branch[]; routes: Route[] }
const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']

function BranchCalendar({ value, change, name, kind }: { value: Calendar; change: (patch: Partial<Calendar>) => void; name: string; kind: Branch['kind'] }) {
  const [exception, setException] = useState<Exception>({ date: '', working: false, note: '' })
  const [error, setError] = useState('')
  function addException() {
    if (!value || !exception.date) return
    if (value.calendar_exceptions.some(row => row.date === exception.date)) { setError('Эта дата уже добавлена. Измените существующую запись.'); return }
    change({ calendar_exceptions: [...value.calendar_exceptions, exception].sort((a, b) => a.date.localeCompare(b.date)) }); setException({ date: '', working: false, note: '' }); setError('')
  }
  return <section className="branch-calendar" role="group" aria-label={`Календарь ${name}`}>{error && <p role="alert" className="settings-message error">{error}</p>}
          <h4>Календарь {kind === 'branch' ? 'филиала' : 'склада'}</h4>
          <p>Регулярные выходные</p>
          <div className="operations-weekdays">{weekdays.map((name, day) => <label key={day}><input type="checkbox" checked={value.weekly_days_off.includes(day)} disabled={!value.weekly_days_off.includes(day) && value.weekly_days_off.length === 6} onChange={e => change({ weekly_days_off: e.target.checked ? [...value.weekly_days_off, day] : value.weekly_days_off.filter(v => v !== day) })} />{name}</label>)}</div>
          <h4>Нерабочие даты и исключения</h4>
          <p className="settings-help">Добавьте праздники или дни закрытия. При необходимости выходной можно назначить рабочим. Исключение действует только на указанную дату.</p>
          {value.calendar_exceptions.map((row, index) => <div className="operations-row" key={row.date}>
            <strong>{row.date.split('-').reverse().join('.')}</strong>
            <label>Тип дня<select aria-label={`Тип дня ${row.date}`} value={row.working ? 'work' : 'off'} onChange={e => change({ calendar_exceptions: value.calendar_exceptions.map((r, i) => i === index ? { ...r, working: e.target.value === 'work' } : r) })}><option value="off">Нерабочий день</option><option value="work">Рабочий день</option></select></label>
            <label>Причина<input aria-label={`Причина ${row.date}`} maxLength={160} value={row.note} onChange={e => change({ calendar_exceptions: value.calendar_exceptions.map((r, i) => i === index ? { ...r, note: e.target.value } : r) })} /></label>
            <button type="button" className="catalog-button settings-danger" aria-label={`Удалить дату ${row.date}`} onClick={() => change({ calendar_exceptions: value.calendar_exceptions.filter((_, i) => i !== index) })}><AppIcon name="trash" />Удалить</button>
          </div>)}
          {!value.calendar_exceptions.length && <p className="settings-help">Отдельные нерабочие даты пока не добавлены.</p>}
          <div className="operations-grid">
            <label>Дата<input type="date" value={exception.date} onChange={e => setException({ ...exception, date: e.target.value })} /></label>
            <label>Тип дня<select value={exception.working ? 'work' : 'off'} onChange={e => setException({ ...exception, working: e.target.value === 'work' })}><option value="off">Нерабочий день</option><option value="work">Рабочий день</option></select></label>
            <label>Причина (необязательно)<input value={exception.note} maxLength={160} placeholder="Например, праздник" onChange={e => setException({ ...exception, note: e.target.value })} /></label>
          </div>
          <button type="button" className="catalog-button button-cta" disabled={!exception.date} onClick={addException}><AppIcon name="plus" />Добавить дату</button>
  </section>
}

function RouteMatrix({ branches, routes, onChange }: { branches: Branch[]; routes: Route[]; onChange: (routes: Route[]) => void }) {
  function setRoute(from: string, to: string, days?: number) {
    const remaining = routes.filter(r => r.from_branch !== from || r.to_branch !== to)
    onChange(days === undefined ? remaining : [...remaining, { from_branch: from, to_branch: to, workdays: days }])
  }
  return <div className="route-matrix-scroll" role="region" aria-label="Таблица перемещений" tabIndex={0}>
    <table className="route-matrix">
      <caption>Сроки перемещений, рабочие дни</caption>
      <thead><tr><th scope="col">Откуда ↓ / Куда →</th>{branches.map((branch, i) => <th scope="col" key={i} className={!branch.active ? 'route-point-inactive' : ''}>{branch.name || 'Новая точка'}<small>{branch.city || 'Город не указан'}{!branch.active && ' · Неактивен'}</small></th>)}</tr></thead>
      <tbody>{branches.map((source, row) => <tr key={row}>
        <th scope="row" className={!source.active ? 'route-point-inactive' : ''}>{source.name || 'Новая точка'}<small>{source.city || 'Город не указан'}{!source.active && ' · Неактивен'}</small></th>
        {branches.map((target, column) => {
          if (row === column) return <td key={column} className="route-self" aria-label={`${source.name}: та же точка`}>—</td>
          const route = routes.find(r => r.from_branch === source.code && r.to_branch === target.code)
          const unavailable = !source.active || !target.active || !source.code || !target.code || branches.filter(b => b.code === source.code).length !== 1 || branches.filter(b => b.code === target.code).length !== 1
          const enabled = !unavailable && !!route
          const name = `${source.name || 'Новая точка'} → ${target.name || 'Новая точка'}`
          return <td key={column} className={enabled ? 'route-enabled' : 'route-unavailable'}>
            <label className="route-toggle"><input type="checkbox" aria-label={`Разрешить ${name}`} checked={enabled} disabled={unavailable} onChange={e => setRoute(source.code, target.code, e.target.checked ? 1 : undefined)} />{enabled ? 'Доступно' : 'Недоступно'}</label>
            <input type="number" aria-label={`Рабочих дней ${name}`} min={0} max={365} step={1} required={enabled} disabled={!enabled} value={enabled ? route.workdays : ''} placeholder="—" onChange={e => setRoute(source.code, target.code, Number(e.target.value))} />
          </td>
        })}
      </tr>)}</tbody>
    </table>
  </div>
}

function OperationsItem({ title, label, removeLabel, editable, initiallyOpen, onRemove, children, dirty }: {
  title: ReactNode; label: string; removeLabel: string; editable: boolean; initiallyOpen: boolean; onRemove: () => void; children: ReactNode; dirty: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const panelId = useId()
  return <div className={`operations-item${open ? ' operations-item-open' : ''}`}>
    <div className="operations-item-heading"><div className="operations-item-title">{title}</div>
      {editable && <div className="settings-inline-actions">
        {open && <button type="submit" className="catalog-button button-cta" disabled={!dirty} aria-label={`Сохранить изменения: ${label}`} title="Сохранить все изменения филиалов, складов, маршрутов и календарей"><AppIcon name="save" />Сохранить</button>}
        <button type="button" className="catalog-button" aria-label={`${open ? 'Свернуть' : 'Изменить'} ${label}`} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}><AppIcon name={open ? 'chevron-down' : 'pencil'} />{open ? 'Свернуть' : 'Изменить'}</button>
        <button type="button" className="catalog-button settings-danger" aria-label={`Удалить ${label}`} onClick={onRemove}><AppIcon name="trash" />{removeLabel}</button>
      </div>}
    </div>
    <div id={panelId} className="operations-item-body" hidden={editable && !open}>{children}</div>
  </div>
}
async function request(path = '', body?: unknown, method = 'PUT') {
  const csrf = decodeURIComponent(document.cookie.split('; ').find(v => v.startsWith('corelab_csrf='))?.slice(13) ?? '')
  const response = await fetch(`${API}/api/v1/admin/settings/organization/operations${path}`, {
    credentials: 'include', method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Проверьте поля: коды филиалов и даты должны быть уникальными, сроки — целыми числами от 0 до 365.')
  return data
}

export function OrganizationOperations({ editable, requiredFields = false, onSaved }: { editable: boolean; requiredFields?: boolean; onSaved?: () => void }) {
  const [value, setValue] = useState<Operations | null>(null)
  const [dirty, setDirty] = useState(false)
  const [savedValue, setSavedValue] = useState<Operations | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [draftKey] = useState(operationsDraftKey)
  const [draftStored, setDraftStored] = useState(false)

  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [start, setStart] = useState('')
  const [estimate, setEstimate] = useState<{ arrival_date: string; ready_date: string; total_workdays: number } | null>(null)
  useEffect(() => {
    let active = true
    request().then(data => {
      if (!active || !Array.isArray(data.branches)) return
      const draft = editable ? readOperationsDraft(draftKey) : null
      setSavedValue(data); setValue(draft ?? data); setDirty(!!draft); setDraftStored(!!draft)
      if (draft) setMessage(draft.version === data.version
        ? 'Восстановлен несохранённый черновик. Нажмите «Сохранить изменения филиалов и складов», чтобы применить его.'
        : 'Восстановлен черновик, но настройки на сервере уже изменились. Скопируйте нужные правки и нажмите «Отменить изменения», чтобы загрузить сохранённые настройки.')
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [editable, draftKey])
  useEffect(() => {
    if (!dirty || draftStored) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, draftStored])
  function change(patch: Partial<Operations>) {
    if (!value) return
    const next = { ...value, ...patch }
    setValue(next); setDraftStored(writeOperationsDraft(draftKey, next)); setDirty(true); setMessage(''); setEstimate(null)
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try { const saved = await request('', value); setValue(saved); setSavedValue(saved); setDirty(false); writeOperationsDraft(draftKey, null); setDraftStored(false); setMessage('Филиалы, сроки и календари сохранены.'); onSaved?.() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function calculate(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setEstimate(null)
    try { setEstimate(await request('/estimate', { from_branch: from, to_branch: to, start_date: start }, 'POST')) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <><section className="settings-card operations-card" aria-labelledby="operations-title">
    <h2 id="operations-title">Филиалы, сроки и календари</h2>
    <p className="settings-help">У каждого филиала и склада свой календарь: выходные и отдельные нерабочие даты.</p>
    {error && <p role="alert" className="settings-message error">{error}</p>}
    {message && <p role="status" className="settings-message">{message}</p>}
    {!value ? <p>Загрузка настроек…</p> : <>
      {!editable && <p className="settings-help">Изменять настройки может главный администратор.</p>}
      <form onSubmit={save}>
        <fieldset disabled={!editable || busy}>
          <section className="operations-section"><h3><AppIcon name="monitor" />Сборка</h3>
          <label>Время на сборку, рабочих дней{requiredFields && ' *'}<input type="number" min={0} max={365} step={1} required value={value.assembly_workdays} onChange={e => change({ assembly_workdays: Number(e.target.value) })} onBlur={e => {
            if (e.currentTarget.validity.valid) e.currentTarget.value = String(e.currentTarget.valueAsNumber)
          }} /></label>
          </section><section className="operations-section"><h3><AppIcon name="house" />Филиалы и склады</h3>
          <p className="settings-help">Код филиала используется в прайс-листе для остатков. Сохраняйте его при последующих загрузках.</p>
          {value.branches.map((branch, index) => <OperationsItem key={index} editable={editable} dirty={dirty} initiallyOpen={!branch.name} removeLabel={branch.kind && branch.kind !== 'branch' ? 'Удалить склад' : 'Удалить филиал'} label={`${branch.kind && branch.kind !== 'branch' ? 'склад' : 'филиал'} ${branch.name || 'без названия'}`} onRemove={() => change({ branches: value.branches.filter((_, i) => i !== index), routes: value.routes.filter(r => r.from_branch !== branch.code && r.to_branch !== branch.code) })}
            title={<>{branch.name || 'Новый филиал / склад'} · {branch.city || 'Город не указан'}{!branch.active && ' · Не используется'}<small>{branch.kind === 'warehouse' || branch.kind === 'supplier_warehouse' ? 'Склад' : 'Филиал'} · {branch.address.trim() || 'Адрес не указан'}</small></>}>
            <h4 className="operations-subtitle">Основные данные и адрес</h4>
            <label>Тип точки<select value={branch.kind === 'supplier_warehouse' ? 'warehouse' : branch.kind ?? 'branch'} onChange={e => change({ branches: value.branches.map((b, i) => i === index ? { ...b, kind: e.target.value as Branch['kind'] } : b) })}><option value="branch">Филиал</option><option value="warehouse">Склад</option></select></label>
            <label>Обозначение склада в прайс-листе<input maxLength={160} value={branch.source_label ?? ''} placeholder={branch.code || 'Точное обозначение из прайс-листа'} onChange={e => change({ branches: value.branches.map((b, i) => i === index ? { ...b, source_label: e.target.value } : b) })} /></label>
            <div className="operations-grid">{(['code', 'name', 'city', 'address'] as const).map((key, n) => <label key={key}>{['Код филиала / склада', 'Название', 'Город', 'Адрес'][n]}{requiredFields && branch.active && ' *'}<input required={key === 'code' || key === 'name'} placeholder={key === 'city' || key === 'address' ? 'Не указан' : undefined} maxLength={key === 'code' ? 40 : key === 'address' ? 500 : key === 'city' ? 120 : 160} pattern={key === 'code' ? '[A-Za-z0-9_-]+' : undefined} value={branch[key]} onChange={e => change({ branches: value.branches.map((b, i) => i === index ? { ...b, [key]: e.target.value } : b), ...(key === 'code' ? { routes: value.routes.map(r => ({ ...r, from_branch: r.from_branch === branch.code ? e.target.value : r.from_branch, to_branch: r.to_branch === branch.code ? e.target.value : r.to_branch })) } : {}) })} /></label>)}</div>
            <label className="operations-checkbox"><input type="checkbox" checked={branch.active} onChange={e => change({ branches: value.branches.map((b, i) => i === index ? { ...b, active: e.target.checked } : b) })} />Активный филиал / склад</label>
            <p className="settings-help">При выключении остатки и перемещения этой точки не участвуют в расчёте.</p>
            <BranchCalendar value={branch} name={branch.name || 'Новая точка'} kind={branch.kind ?? 'branch'} change={patch => change({ branches: value.branches.map((b, i) => i === index ? { ...b, ...patch } : b) })} />
          </OperationsItem>)}
          <button type="button" className="catalog-button button-cta" onClick={() => change({ branches: [...value.branches, { code: '', name: '', city: '', address: '', active: true, weekly_days_off: [5, 6], calendar_exceptions: [] }] })}><AppIcon name="plus" />Добавить филиал / склад</button>
          </section>
        </fieldset>
        {editable && <div className="operations-save"><div className="settings-inline-actions"><button className="catalog-button button-cta" disabled={busy || !dirty}><AppIcon name="save" />{busy ? 'Сохраняем…' : 'Сохранить изменения филиалов и складов'}</button><button type="button" className="catalog-button" disabled={busy || !dirty} onClick={() => { setValue(savedValue); setDirty(false); writeOperationsDraft(draftKey, null); setDraftStored(false); setError(''); setMessage(''); setEstimate(null) }}><AppIcon name="undo" />Отменить изменения</button></div><p className="settings-help" role="status">{dirty ? (draftStored ? 'Черновик сохранён в этой вкладке и восстановится после обновления страницы. Для применения нажмите «Сохранить изменения филиалов и складов».' : 'Есть несохранённые изменения. Сохраните их перед обновлением страницы.') : 'Филиалы, склады, маршруты и их календари'}</p></div>}
      </form>
    </>}
  </section>
  {value && <section className="settings-card operations-card operations-routes" aria-labelledby="routes-title">
      <h2 id="routes-title"><AppIcon name="arrow-left-right" />Перемещения между филиалами и складами</h2>
      <p className="settings-help">Слева — откуда, сверху — куда. Срок считается по календарю отправителя; приём — в ближайший рабочий день получателя. Сборка — по календарю филиала сборки. Обратное направление настраивается отдельно.</p>
      <p className="settings-help">Для неактивных точек перемещения недоступны. Их сохранённые сроки восстановятся при включении. Таблицу можно прокручивать вправо и вниз.</p>
      <form onSubmit={save}><fieldset disabled={!editable || busy}>
        {value.branches.length ? <RouteMatrix branches={value.branches} routes={value.routes} onChange={routes => change({ routes })} /> : <p className="settings-help">Добавьте филиалы и склады — они появятся в таблице автоматически.</p>}
      </fieldset>{editable && <div className="operations-save"><button className="catalog-button button-cta" disabled={busy || !dirty}><AppIcon name="save" />{busy ? 'Сохраняем…' : 'Сохранить сроки перемещений'}</button><p className="settings-help">Сохраняются маршруты и изменения в карточках филиалов и складов.</p>{error && <p role="alert" className="settings-message error">Ошибка сохранения: {error}</p>}{message && <p role="status" className="settings-message">Результат: {message}</p>}</div>}</form>
      <details className="operations-estimate"><summary>Проверить срок доставки и сборки</summary><p className="settings-help">Считаются полные рабочие дни после даты начала. Нерабочее начало переносится на ближайший рабочий день.</p><form onSubmit={calculate}><div className="operations-grid">
        <label>Филиал отправления<select required value={from} onChange={e => setFrom(e.target.value)}><option value="">Выберите филиал</option>{value.branches.filter(b => b.active).map(b => <option key={b.code} value={b.code}>{b.city} · {b.name}</option>)}</select></label>
        <label>Филиал сборки<select required value={to} onChange={e => setTo(e.target.value)}><option value="">Выберите филиал</option>{value.branches.filter(b => b.active).map(b => <option key={b.code} value={b.code}>{b.city} · {b.name}</option>)}</select></label>
        <label>Дата начала<input type="date" required value={start} onChange={e => setStart(e.target.value)} /></label>
      </div><button className="catalog-button button-cta" disabled={busy || dirty}><AppIcon name="calculator" />Рассчитать срок</button>{dirty && <p>Сначала сохраните изменения.</p>}</form>
        {estimate && <p role="status">Прибытие: {estimate.arrival_date.split('-').reverse().join('.')}. Готовность: {estimate.ready_date.split('-').reverse().join('.')}. Всего: {estimate.total_workdays} рабочих дней.</p>}
      </details>
  </section>}</>
}
