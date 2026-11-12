/** Read-only transport for the existing Mini App. No catalog persistence or write methods. */
export function createCatalogClient({ baseUrl = '', fetcher = fetch, storage = null } = {}) {
  let accessToken = null;
  let bot = 'corelab';
  let generation = 0;
  const prefix = baseUrl.replace(/\/$/, '') + '/api/v1';

  async function request(path, options = {}, authenticated = true) {
    const current = generation;
    const response = await fetcher(prefix + path, {
      ...options, credentials: 'omit', cache: 'no-store',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(authenticated && accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
    });
    if (current !== generation) throw new Error('shop_changed');
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 401) accessToken = null;
      const error = new Error(typeof body.detail === 'string' ? body.detail : 'catalog_request_failed');
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function acceptSession(result, remember = true) {
    accessToken = result.access_token;
    try {
      if (remember && result.organization) storage?.setItem('corelab:last-shop:' + bot, String(result.organization.id));
      else if (remember) storage?.removeItem('corelab:last-shop:' + bot);
    } catch { /* Storage is optional; the server owns the session. */ }
    return { organization: result.organization, campaign: result.campaign, launchError: result.launch_error ?? null };
  }

  function query(values = {}) {
    const params = new URLSearchParams();
    for (const key of ['page', 'page_size', 'q', 'category_id']) {
      if (values[key] !== undefined && values[key] !== null) params.set(key, String(values[key]));
    }
    return params.size ? '?' + params.toString() : '';
  }

  return {
    async preview({ csrfToken }) {
      generation++; accessToken = null;
      const current = generation;
      const response = await fetcher(prefix + '/admin/mini-app/preview', {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      if (current !== generation) throw new Error('shop_changed');
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(typeof body.detail === 'string' ? body.detail : 'preview_unavailable');
        error.status = response.status;
        throw error;
      }
      return acceptSession(body, false);
    },
    async launch({ initData, botAlias = 'corelab' }) {
      generation++; accessToken = null; bot = botAlias;
      let remembered = null;
      try { remembered = Number(storage?.getItem('corelab:last-shop:' + bot)); } catch { /* optional */ }
      return acceptSession(await request('/mini-app/session', { method: 'POST', body: JSON.stringify({
        bot, init_data: initData,
        remembered_organization_id: Number.isSafeInteger(remembered) && remembered > 0 ? remembered : null,
      }) }, false));
    },
    async chooseShop(organizationId) {
      generation++;
      try {
        return acceptSession(await request('/mini-app/organization', {
          method: 'POST', body: JSON.stringify({ organization_id: organizationId }),
        }));
      } catch (error) {
        // A failed switch must not leave the previous shop available to callers.
        accessToken = null;
        throw error;
      }
    },
    shops: params => request('/mini-app/organizations' + query(params)),
    context: () => request('/mini-app/context'),
    categories: params => request('/categories' + query(params)),
    products: params => request('/products' + query(params)),
    selectionProducts: params => request('/selection/products' + query(params)),
    product: id => request('/products/' + encodeURIComponent(id)),
    reset() { generation++; accessToken = null; },
  };
}
