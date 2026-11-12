import { adminFetch as fetch } from './admin-fetch'
import { useState } from 'react'

const API = import.meta.env.VITE_API_URL ?? ''
export function SelectionCheck({ productId, enabled, onSaved }: { productId: number; enabled: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(toggle: boolean) {
    setBusy(true); setError('')
    try {
      const csrf = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
      const response = await fetch(`${API}/api/v1/admin/catalog/${productId}/${toggle ? 'selection' : 'recheck'}`, {
        method: toggle ? 'PATCH' : 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        ...(toggle ? { body: JSON.stringify({ selection_enabled: !enabled }) } : {}),
      })
      if (!response.ok) throw new Error('Не удалось сохранить проверку. Повторите попытку.')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ошибка проверки') }
    finally { setBusy(false) }
  }
  return <section aria-label="Проверка для подбора"><h2>Участие в подборе</h2>
    <p className="catalog-muted">Проверяются свойства с отметкой «Обязательно для подбора». Проверка выполняется после изменений и каждые 15 минут. Совместимость комплектующих проверяется отдельно.</p>
    <div className="selection-check-controls">
      <label className="selection-check-option"><input type="checkbox" checked={enabled} disabled={busy} onChange={() => void save(true)} /><span>Разрешить участие в подборе при успешной проверке</span></label>
      <button className="catalog-button" type="button" disabled={busy} onClick={() => void save(false)}>{busy ? 'Проверяем…' : 'Проверить для подбора'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>
}
