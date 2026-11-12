import { canManageOrganization } from './roles'
import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useRef, useState } from 'react'

const API = import.meta.env.VITE_API_URL ?? ''
type Shop = { id: number; name: string; short_name: string | null; logo_url: string | null; primary_color: string }
type Product = { id: number; name: string; price: string | null; currency: string; attributes: { code: string; label: string; value: unknown; unit: string | null }[] }
type Page = { items: Product[]; total: number; page: number; page_size: number }

export function MiniAppSettings() {
  const [enabled, setEnabled] = useState(false)
  const [chief, setChief] = useState(false)
  const [organizationId, setOrganizationId] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<{ token: string; shop: Shop } | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  async function adminRequest(path: string, method = 'GET', body?: unknown) {
    const csrf = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) ?? '')
    const response = await fetch(`${API}/api/v1/admin/${path}`, { method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Не удалось выполнить запрос')
    return result
  }

  useEffect(() => {
    let active = true
    Promise.all([adminRequest('mini-app/settings'), adminRequest('settings/organization')]).then(([settings, org]) => {
      if (active) { setEnabled(settings.enabled); setChief(canManageOrganization(org.role)); setOrganizationId(org.id); setLoaded(true) }
    }).catch(reason => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [])
  useEffect(() => { if (preview && !dialog.current?.open) dialog.current?.showModal() }, [preview])

  async function toggle() {
    setBusy(true); setError('')
    try { const result = await adminRequest('mini-app/settings', 'PUT', { enabled: !enabled }); setEnabled(result.enabled) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось изменить доступность') }
    finally { setBusy(false) }
  }

  async function loadPage(token: string, number: number) {
    const response = await fetch(`${API}/api/v1/products?page=${number}&page_size=10`, {
      credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error('Не удалось получить товары приложения. Откройте предпросмотр заново.')
    setPage(await response.json() as Page)
  }

  async function openPreview() {
    setBusy(true); setError('')
    try {
      const result = await adminRequest('mini-app/preview', 'POST')
      await loadPage(result.access_token, 1)
      setPreview({ token: result.access_token, shop: result.organization })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось открыть предпросмотр') }
    finally { setBusy(false) }
  }

  async function changePage(number: number) {
    if (!preview) return
    setBusy(true); setError('')
    try { await loadPage(preview.token, number) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось загрузить страницу') }
    finally { setBusy(false) }
  }

  function close() { dialog.current?.close(); setPreview(null); setPage(null) }

  return <section className="settings-card" aria-labelledby="mini-app-title">
    <h2 id="mini-app-title">Mini App</h2>
    <p>В приложение передаются товары с характеристиками и статусом «Доступен для Конфигуратора».</p>
    {chief && <label className="mini-app-availability"><input type="checkbox" checked={enabled} disabled={!loaded || busy} onChange={() => void toggle()} />Магазин доступен в Mini App</label>}
    <p className="settings-help">Предпросмотр доступен до подключения Telegram-бота. Он показывает товары вашей организации через API приложения.</p>
    <p><a href={organizationId ? `/mini-app/?organization_id=${organizationId}` : '/mini-app/'} target="_blank" rel="noreferrer">Открыть приложение <AppIcon name="arrow-up-right" /></a> · <a href="/catalog-preview/" target="_blank" rel="noreferrer">Просмотреть каталог приложения <AppIcon name="arrow-up-right" /></a></p>
    <button className="catalog-button button-cta" type="button" disabled={!loaded || busy} onClick={() => void openPreview()}><AppIcon name="package" />Товары для Mini App</button>
    {error && !preview && <p className="settings-message error" role="alert">{error}</p>}
    <dialog ref={dialog} className="mini-app-preview" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close() }}>
      {preview && <><div className="mini-app-preview-heading"><div>{preview.shop.logo_url && <img src={`${API}${preview.shop.logo_url}`} alt="" />}<h2>{preview.shop.short_name || preview.shop.name}</h2></div><button className="catalog-button" type="button" onClick={close}><AppIcon name="x" />Закрыть</button></div>
        <p>Товаров для приложения: {page?.total ?? 0}</p>
        {page?.items.map(product => <details className="mini-app-preview-product" key={product.id}><summary>{product.name}<span>{product.price ? `${product.price} ${product.currency}` : 'Цена не указана'}</span></summary><dl>{product.attributes.map(attribute => <div key={attribute.code}><dt>{attribute.label}</dt><dd>{attribute.value === null ? 'Не указано' : typeof attribute.value === 'object' ? JSON.stringify(attribute.value) : String(attribute.value)} {attribute.unit}</dd></div>)}</dl></details>)}
        {page?.total === 0 && <p>Подходящих товаров пока нет. Проверьте характеристики и допуск товаров в каталоге.</p>}
        {page && page.total > page.page_size && <div className="mini-app-preview-pagination"><button className="catalog-button" disabled={busy || page.page === 1} onClick={() => void changePage(page.page - 1)}><AppIcon name="arrow-left" />Назад</button><span>{page.page} / {Math.ceil(page.total / page.page_size)}</span><button className="catalog-button" disabled={busy || page.page * page.page_size >= page.total} onClick={() => void changePage(page.page + 1)}><AppIcon name="arrow-right" />Далее</button></div>}
        {error && <p className="settings-message error" role="alert">{error}</p>}</>}
    </dialog>
  </section>
}
