import { adminFetch as fetch } from './admin-fetch'
export async function platformRequest(path: string, method = 'GET', body?: unknown) {
  const csrf = decodeURIComponent(document.cookie.split('; ').find(v => v.startsWith('corelab_csrf='))?.slice(13) ?? '')
  const response = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/v1/admin/platform${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Проверьте поля формы.')
  return data
}
