import { useRef, useState } from 'react'
import { adminFetch } from './admin-fetch'
import { AppIcon } from './icons'
import './property-file-exchange.css'

const API = import.meta.env.VITE_API_URL ?? ''
const progressLabels = {
  download: 'Готовим архив к скачиванию…',
  preview: 'Загружаем файл и проверяем характеристики…',
  apply: 'Сохраняем характеристики и пересчитываем допуск…',
}
type Preview = { applied: number; properties: number; products: number; skipped: number; error_count: number;
  errors: { sheet: string; row: number; message: string }[]; can_apply: boolean; preview_token: string;
  items: { product: string; property: string; value: unknown }[] }
const csrf = () => decodeURIComponent(document.cookie.split('; ').find(x => x.startsWith('corelab_csrf='))?.split('=').slice(1).join('=') ?? '')
async function readResult(response: Response) {
  try { return JSON.parse(await response.text()) }
  catch { throw new Error(response.ok ? 'Сервер вернул некорректный ответ. Повторите загрузку.' :
    `Ошибка сервера при обработке файла (${response.status}). Обновите страницу и повторите загрузку.`) }
}

export function PropertyFileExchange({ categoryId, query, onApplied }: {
  categoryId: number | null; query: string; onApplied: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [scope, setScope] = useState('either')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [operation, setOperation] = useState<keyof typeof progressLabels | null>(null)
  const busy = operation !== null
  const progress = operation && <div className="property-file-progress" role="status">
    <span>{progressLabels[operation]}</span>
    <progress aria-label={progressLabels[operation]} />
  </div>
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function download() {
    setOperation('download'); setError(''); setMessage('')
    try {
      const params = new URLSearchParams({ scope, q: query, archive: 'true' })
      if (categoryId != null) params.set('category_id', String(categoryId))
      const response = await adminFetch(`${API}/api/v1/admin/catalog/property-file/export?${params}`, { credentials: 'include' })
      if (!response.ok) { const body = await readResult(response); throw new Error(body.detail || 'Не удалось скачать XLS') }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = 'corelab-missing-properties.zip'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(`Архив подготовлен: XLS-файлы по 10 товаров, последний может содержать меньше. Строк для заполнения: ${response.headers.get('X-Property-Rows') ?? '—'}. Учитываются категория и поиск, все страницы.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось скачать XLS') }
    finally { setOperation(null) }
  }

  async function upload(selected: File, apply = false) {
    if (!/\.(xls|zip)$/i.test(selected.name)) { setError('Выберите XLS (Excel 97–2003) или ZIP-архив с файлами XLS.'); return }
    if (selected.size > 20 * 1024 * 1024) { setError('Максимальный размер файла — 20 МБ.'); return }
    setOperation(apply ? 'apply' : 'preview'); setError(''); setMessage('')
    try {
      const response = await adminFetch(`${API}/api/v1/admin/catalog/property-file/import?apply=${apply}`, {
        method: 'POST', credentials: 'include', body: selected,
        headers: { 'Content-Type': /\.zip$/i.test(selected.name) ? 'application/zip' : 'application/vnd.ms-excel', 'X-CSRF-Token': csrf(),
          ...(apply && preview ? { 'X-Import-Preview': preview.preview_token } : {}) },
      })
      const result = await readResult(response)
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось обработать файл')
      if (apply && !result.error_count) {
        setMessage(`Сохранено характеристик: ${result.applied}. Товаров: ${result.products}. Значения нормализованы, допуск пересчитан.`)
        setPreview(null); setFile(null); onApplied()
      } else { setPreview(result); setFile(selected) }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось обработать файл')
      if (apply) setPreview(null)
    } finally { setOperation(null) }
  }

  return <>
    <label className="property-file-scope">Выгрузка свойств
      <select aria-label="Какие незаполненные свойства скачать" value={scope} disabled={busy} onChange={e => setScope(e.target.value)}>
        <option value="either">Обязательные и для подбора ПК</option>
        <option value="required">Обязательные значения</option>
        <option value="selection">Обязательные для подбора ПК</option>
      </select>
    </label>
    <button className="catalog-button catalog-properties-link" title="ZIP-архив с XLS-файлами по 10 товаров" disabled={busy} onClick={download}><AppIcon name="file-spreadsheet" /> Скачать XLS по 10 товаров</button>
    <button className="catalog-button catalog-properties-link" disabled={busy} onClick={() => input.current?.click()}><AppIcon name="upload" /> Загрузить и применить</button>
    <input ref={input} type="file" accept=".xls,.zip,application/vnd.ms-excel,application/zip" disabled={busy} hidden aria-label="Загрузить заполненные характеристики XLS" onChange={e => {
      const selected = e.target.files?.[0]; e.target.value = ''; if (selected) { setPreview(null); void upload(selected) }
    }} />
    {!preview && progress}
    {message && <p className="property-file-message" role="status">{message}</p>}
    {error && <p className="property-file-error" role="alert">{error}</p>}
    {preview && <div className="catalog-bulk-overlay"><section className="catalog-bulk-dialog property-file-dialog" role="dialog" aria-modal="true" aria-labelledby="property-file-title">
      <div className="catalog-bulk-heading"><div><h2 id="property-file-title">Характеристики из XLS / ZIP</h2><p>{file?.name}</p></div>
        <button className="catalog-button" disabled={busy} aria-label="Закрыть проверку XLS" onClick={() => { setPreview(null); setFile(null) }}><AppIcon name="x" /></button></div>
      <p>К записи: <strong>{preview.properties}</strong> характеристик у <strong>{preview.products}</strong> товаров. Пустых или уже заполненных строк пропущено: {preview.skipped}.</p>
      <p className="catalog-muted">Показаны нормализованные значения. После записи будет проверен формат сохранённых данных и пересчитан допуск к подбору ПК.</p>
      {preview.error_count > 0 && <div role="alert"><p className="property-file-error">Ошибок: {preview.error_count}. Исправьте файл и загрузите снова. Пока изменения не записаны.</p>
        <ul>{preview.errors.map((item, index) => <li key={index}>{item.sheet}, строка {item.row}: {item.message}</li>)}</ul></div>}
      {preview.items.length > 0 && <div className="property-file-table"><table className="catalog-table property-file-preview">
        <colgroup><col className="property-file-product" /><col className="property-file-property" /><col /></colgroup>
        <thead><tr><th scope="col">Товар</th><th scope="col">Свойство</th><th scope="col">Будет записано</th></tr></thead>
        <tbody>{preview.items.map((item, index) => <tr key={index}><td>{item.product}</td><td>{item.property}</td><td>{typeof item.value === 'object' ? JSON.stringify(item.value) : typeof item.value === 'boolean' ? item.value ? 'Да' : 'Нет' : String(item.value)}</td></tr>)}</tbody></table>
        {preview.properties > preview.items.length && <p>Показаны первые {preview.items.length} изменений.</p>}</div>}
      <div className="property-file-actions">{progress}<button className="catalog-button" disabled={busy} onClick={() => { setPreview(null); setFile(null) }}>Отмена</button>
        <button className="catalog-button catalog-properties-link" disabled={busy || !preview.can_apply || !file} onClick={() => file && upload(file, true)}><AppIcon name="save" /> {busy ? 'Сохранение…' : 'Применить характеристики'}</button></div>
    </section></div>}
  </>
}
