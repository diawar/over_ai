/** Organization context belongs to this tab, never to a shared cookie. */
export function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const base = new URL(import.meta.env.VITE_API_URL || window.location.origin)
  const url = new URL(raw, window.location.origin)
  if (url.origin === base.origin && url.pathname.startsWith('/api/v1/admin/') && !/\/auth\/(login|logout|register)$/.test(url.pathname)) {
    let context: string | undefined
    try { context = JSON.parse(sessionStorage.getItem('corelab_session') ?? 'null')?.organization_context } catch { /* No session. */ }
    if (context) {
      const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
      headers.set('X-CoreLab-Organization-Context', context)
      return globalThis.fetch(input, { ...init, headers })
    }
  }
  return globalThis.fetch(input, init)
}
