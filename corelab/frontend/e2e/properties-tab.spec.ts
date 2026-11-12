import { expect, test } from '@playwright/test'

test('properties tab shows stored values and category structures', async ({ page }) => {
  let merged = false
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  await page.route('**/api/v1/admin/properties/dictionary', route => route.fulfill({ json: { items: [
    { id: 33, code: 'gpu_graphics_processor', label: 'Графический процессор', value_type: 'string', filled_count: 2 },
  ] } }))
  await page.route('**/api/v1/admin/properties/dictionary/33/merge', route => { merged = true; return route.fulfill({ json: { updated_products: 1, target: 'GeForce RTX 5080' } }) })
  await page.route('**/api/v1/admin/properties/dictionary/33/values', route => route.fulfill({ json: {
    attribute: { id: 33, code: 'gpu_graphics_processor', label: 'Графический процессор', value_type: 'string' },
    items: merged ? [{ key: 'GeForce RTX 5080', value: 'GeForce RTX 5080', count: 2 }] : [{ key: 'GeForce RTX 5080', value: 'GeForce RTX 5080', count: 1 }, { key: 'NVIDIA GeForce RTX 5080', value: 'NVIDIA GeForce RTX 5080', count: 1 }],
    total_products: 2, merge_supported: true,
  } }))
  await page.route('**/api/v1/admin/properties/categories', route => route.fulfill({ json: { items: [
    { id: 1, parent_id: null, name: 'Комплектующие', selection_category: false, property_count: 0 },
    { id: 2, parent_id: 1, name: 'Процессоры', selection_category: true, property_count: 10 },
    { id: 3, parent_id: 1, name: 'Видеокарты', selection_category: false, property_count: 0 },
  ] } }))
  await page.goto('/admin/properties')
  await expect(page.getByRole('heading', { name: 'Свойства и значения' })).toBeVisible()
  await expect(page.getByText('NVIDIA GeForce RTX 5080')).toBeVisible()
  await page.getByLabel('Объединить NVIDIA GeForce RTX 5080').check()
  await page.getByLabel('Объединить GeForce RTX 5080').check()
  await page.getByRole('button', { name: 'Объединить значения' }).click()
  await expect(page.getByRole('dialog', { name: 'Объединение значений' })).toBeVisible()
  await page.getByLabel('Оставить значение').selectOption('GeForce RTX 5080')
  await page.getByRole('button', { name: 'Предпросмотр объединения' }).click()
  expect(merged).toBe(false)
  await page.getByRole('button', { name: 'Подтвердить объединение' }).click()
  await expect(page.getByText(/Обновлено товаров: 1/)).toBeVisible()
  expect(merged).toBe(true)
  await page.getByRole('link', { name: 'Структуры категорий →' }).click()
  await expect(page.getByRole('link', { name: 'Процессоры', exact: true })).toHaveAttribute('href', '/admin/categories/2/properties')
  await page.getByLabel('Фильтр свойств').selectOption('empty')
  await expect(page.getByRole('link', { name: 'Процессоры', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Видеокарты', exact: true })).toBeVisible()
})

test('properties tab creates, edits, and deletes a numeric value', async ({ page }) => {
  let item: { key: string; value: string; count: number; registered: boolean } | null = null
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  await page.route('**/api/v1/admin/properties/dictionary', route => route.fulfill({ json: { items: [
    { id: 5, code: 'base_clock_ghz', label: 'Базовая частота', value_type: 'number', filled_count: 0 },
  ] } }))
  await page.route('**/api/v1/admin/properties/dictionary/5/values', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: {
      attribute: { id: 5, code: 'base_clock_ghz', label: 'Базовая частота', value_type: 'number' },
      items: item ? [item] : [], total_products: 0, merge_supported: true,
    } })
    const body = route.request().postDataJSON()
    if (route.request().method() === 'POST') item = { key: '3.500000', value: '3.500000', count: 0, registered: true }
    if (route.request().method() === 'PATCH') item = { key: '3.600000', value: '3.600000', count: 0, registered: true }
    if (route.request().method() === 'DELETE') item = null
    return route.fulfill({ json: route.request().method() === 'POST'
      ? { key: item!.key, value: item!.value, count: 0 }
      : { key: body.key, updated_products: 0 } })
  })
  await page.goto('/admin/properties?attribute=5')
  await page.getByRole('button', { name: 'Добавить значение' }).click()
  await page.getByLabel('Значение свойства').fill('3.5')
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()
  await expect(page.getByRole('cell', { name: '3.500000', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Изменить' }).click()
  await page.getByLabel('Значение свойства').fill('3.6')
  await page.getByRole('button', { name: 'Сохранить изменение' }).click()
  await expect(page.getByRole('cell', { name: '3.600000', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Удалить значение' })).toBeVisible()
  await page.getByRole('button', { name: 'Подтвердить удаление' }).click()
  await expect(page.getByText('Значений нет.')).toBeVisible()
})
