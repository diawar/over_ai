import { expect, test } from '@playwright/test'

test('journal shows persisted imports and filters events by status and product', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  await page.route('**/api/v1/admin/logs/jobs?*', route => route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 5 } }))
  await page.route('**/api/v1/admin/logs/imports?*', route => route.fulfill({ json: { items: [{ id: 4, source_id: 2, status: 'completed', expected: 30, imported: 30, started_at: '2026-10-18T10:00:00Z', finished_at: '2026-10-18T10:01:00Z' }], total: 1, page: 1, page_size: 5 } }))
  const eventRequests: string[] = []
  await page.route('**/api/v1/admin/logs?*', route => {
    eventRequests.push(route.request().url())
    return route.fulfill({ json: { items: [{ id: 7, action: 'properties.ai_load_skipped', status: 'skipped', author: 'Система', initiated_by: 'admin-two', object_type: 'product', object_id: '12', created_at: '2026-10-18T10:00:00Z', reason: 'Товар больше не относится к выбранной категории', property_count: 0, job_id: null, error_count: null, warning_count: null }], total: 1, page: 1, page_size: 25 } })
  })
  await page.goto('/admin/logs')
  await expect(page.getByRole('heading', { name: 'Журнал' })).toBeVisible()
  await expect(page.getByText(/Импорт #4/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Товар #12' })).toHaveAttribute('href', '/admin/catalog/12')
  await expect(page.getByRole('columnheader', { name: 'Автор' })).toBeVisible()
  await expect(page.getByText('Запустил: admin-two')).toBeVisible()
  await page.getByLabel('Статус события').selectOption('skipped')
  await page.getByLabel('ID товара').fill('12')
  await expect.poll(() => eventRequests.some(url => url.includes('status=skipped') && url.includes('product_id=12'))).toBe(true)
})
