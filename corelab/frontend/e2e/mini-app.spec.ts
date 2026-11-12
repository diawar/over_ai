import { expect, test } from '@playwright/test'

test('existing PC builder remains available at the mini app address', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/mini-app/')
  await expect(page.locator('#conversation')).toBeVisible()
  await page.getByRole('button', { name: 'Старт', exact: true }).click()
  await expect(page.getByPlaceholder('Ваше имя')).toBeVisible()
  await expect(page.locator('#restart')).toBeVisible()
  const status = await page.request.get('http://127.0.0.1:5173/mini-app/api/status')
  expect(status.ok()).toBeTruthy()
  expect(typeof (await status.json()).builderAvailable).toBe('boolean')
})

test('mini app catalog reads only eligible products through the API', async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'window.Telegram={WebApp:{initData:"signed",ready(){}}}',
  }))
  await page.route('**/api/v1/mini-app/session', route => route.fulfill({ json: {
    access_token: 'consumer-token', organization: { id: 1 }, campaign: null, launch_error: null,
  } }))
  await page.route('**/api/v1/mini-app/context', route => route.fulfill({ json: {
    organization: { id: 1, name: 'Магазин', short_name: 'Магазин', primary_color: '#5146e5', logo_url: null },
    campaign: null, preview: false,
  } }))
  await page.route('**/api/v1/categories?*', route => route.fulfill({ json: {
    items: [{ id: 3, name: 'Процессоры', parent_id: null }], total: 1, page: 1, page_size: 100,
  } }))
  const product = { id: 7, name: 'Ryzen 7', category: { id: 3, name: 'Процессоры', parent_id: null },
    price: '120000.00', currency: 'KZT', attributes: [{ code: 'cores', label: 'Ядра', value: 8, unit: null, value_state: 'known' }] }
  await page.route('**/api/v1/selection/products?*', route => route.fulfill({ json: {
    items: [product], total: 1, page: 1, page_size: 20, schema_version: '1',
  } }))
  await page.route('**/api/v1/products/7', route => route.fulfill({ json: product }))

  await page.goto('http://127.0.0.1:8000/catalog-preview/')
  await expect(page.getByRole('heading', { name: 'Магазин' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Ryzen 7/ })).toBeVisible()
  await page.getByRole('button', { name: /Ryzen 7/ }).click()
  await expect(page.getByRole('heading', { name: 'Ryzen 7' })).toBeVisible()
  await expect(page.locator('#detail-price')).toHaveText('120000.00 KZT')
  await expect(page.getByText('Ядра')).toBeVisible()
  await expect(page.getByText('8', { exact: true })).toBeVisible()
  await expect(page.locator('#notice')).toBeEmpty()
})

test('browser preview opens catalog through the admin session without Telegram', async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'window.Telegram={WebApp:{initData:""}}',
  }))
  await page.context().addCookies([{ name: 'corelab_csrf', value: 'csrf', url: 'http://127.0.0.1:5173' }])
  await page.route('**/api/v1/admin/mini-app/preview', route => {
    expect(route.request().headers()['x-csrf-token']).toBe('csrf')
    return route.fulfill({ json: { access_token: 'preview', organization: { id: 1 } } })
  })
  await page.route('**/api/v1/mini-app/context', route => route.fulfill({ json: {
    organization: { id: 1, name: 'Магазин', short_name: 'Магазин', primary_color: '#5146e5', logo_url: null },
    campaign: null, preview: true,
  } }))
  await page.route('**/api/v1/categories?*', route => route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 100 } }))
  await page.route('**/api/v1/selection/products?*', route => route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 20, schema_version: '1' } }))
  await page.goto('http://127.0.0.1:5173/catalog-preview/')
  await expect(page.getByRole('heading', { name: 'Магазин' })).toBeVisible()
  await expect(page.getByText('Товаров: 0')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Сменить' })).toBeHidden()
})

test('browser without an admin session gets a login path', async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'window.Telegram={WebApp:{initData:""}}',
  }))
  await page.route('**/api/v1/admin/mini-app/preview', route => route.fulfill({ status: 403, json: { detail: 'CSRF token invalid' } }))
  await page.goto('http://127.0.0.1:8000/catalog-preview/')
  await expect(page.getByText('Для просмотра каталога в браузере войдите в CoreLab как администратор.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Войти как администратор для предпросмотра' })).toBeVisible()
})
