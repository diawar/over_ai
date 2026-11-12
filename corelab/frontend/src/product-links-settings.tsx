import { useEffect, useState } from 'react'
import { adminFetch } from './admin-fetch'
import { AppIcon } from './icons'

export function ProductLinksSettings({ editable }: { editable: boolean }) {
  const [url, setUrl] = useState('')
  const [count, setCount] = useState(0)
  const [sku, setSku] = useState('')
  const [link, setLink] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  async function request(method = 'GET', query = '') {
    const csrf = decodeURIComponent(document.cookie.split('; ').find(v => v.startsWith('corelab_csrf='))?.slice(13) ?? '')
    const response = await adminFetch(`${import.meta.env.VITE_API_URL ?? ''}/api/v1/admin/settings/product-links${query}`, {
      method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(method === 'PUT' ? { body: JSON.stringify({ url }) } : {}),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Не удалось загрузить ссылки')
    return data
  }
  useEffect(() => { request().then(data => { setUrl(data.url); setCount(data.count); setLoaded(true) }).catch(e => setError(e.message)) }, [])
  async function save() {
    setBusy(true); setError(''); setMessage('')
    try { const data = await request('PUT'); setUrl(data.url); setCount(data.count); setSearched(false); setMessage(data.url ? `Ссылки обновлены: ${data.count}. Они появятся при новом расчёте ПК.` : 'Ссылки отключены.') }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить') }
    finally { setBusy(false) }
  }
  async function search() {
    setBusy(true); setError(''); setSearched(false)
    try { const data = await request('GET', `?sku=${encodeURIComponent(sku.trim())}`); setLink(data.product_url); setSearched(true) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось найти товар') }
    finally { setBusy(false) }
  }
  return <section className="settings-card" aria-labelledby="product-links-title">
    <h2 id="product-links-title"><AppIcon name="globe" /> Ссылки на товары</h2>
    <p>Названия комплектующих в расчёте ПК ведут на ваш сайт. Сопоставление — по точному SKU.</p>
    <form onSubmit={e => { e.preventDefault(); void save() }}>
      <label>Адрес XML со ссылками<input type="url" placeholder="https://example.kz/sku.xml" value={url} disabled={!loaded || !editable || busy} onChange={e => setUrl(e.target.value)} /></label>
      <p className="settings-help">Формат: products → product → sku и url. Пустой адрес отключает ссылки. При ошибке загрузки ранее сохранённые ссылки остаются.</p>
      {editable && <button className="catalog-button button-cta" disabled={!loaded || busy}><AppIcon name="refresh-cw" />{busy ? 'Подождите…' : 'Сохранить и обновить ссылки'}</button>}
    </form>
    <p className="settings-help">Загружено ссылок: {count}</p>
    <form onSubmit={e => { e.preventDefault(); void search() }}>
      <label>Проверить SKU<input value={sku} onChange={e => { setSku(e.target.value); setSearched(false) }} placeholder="Например, 88959962" /></label>
      <button className="catalog-button" disabled={!loaded || busy || !sku.trim()}><AppIcon name="search" />Найти ссылку</button>
    </form>
    {searched && <p>{link ? <a href={link} target="_blank" rel="noopener noreferrer">Открыть товар на сайте <AppIcon name="arrow-up-right" /></a> : 'Для этого SKU ссылка не найдена.'}</p>}
    {message && <p role="status" className="settings-message">{message}</p>}
    {error && <p role="alert" className="settings-message error">{error}</p>}
  </section>
}
