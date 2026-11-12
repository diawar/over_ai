import { expect, test } from '@playwright/test'

test('catalog tree, toggle persistence, row details and product card', async ({ page }) => {
  let parentEnabled = false
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  await page.route('**/api/v1/admin/catalog/categories/**', async route => {
    if (route.request().method() === 'PATCH') {
      parentEnabled = JSON.parse(route.request().postData() || '{}').selection_category
      await route.fulfill({ json: { id: 1, selection_category: parentEnabled } })
    } else await route.continue()
  })
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: { items: [
    { id: 1, parent_id: null, name: 'Комплектующие', selection_category: parentEnabled, valid: 1, total: 1 },
    { id: 2, parent_id: 1, name: 'Процессоры', selection_category: false, valid: 1, total: 1 },
  ] } }))
  const product = { id: 7, sku: 'p1:7', name: 'Ryzen 7', article: 'R7', manufacturer: 'AMD', categories: [{ id: 2, name: 'Процессоры' }], status: 'active', validity_check: true, selection_enabled: true, current_offer_count: 1, current_price: '12000.00', currency: 'KZT', attributes: [{ code: 'socket', label: 'Сокет', value: 'AM5', value_state: 'known', unit: null, source_url: null, source_kind: 'manual' }], available_attributes: [
    { code: 'socket', label: 'Сокет', value_type: 'string', unit: null, allowed_values: [], minimum: null, maximum: null, max_length: null, format: null, editable: true, edit_reason: null },
  ] }
  let validity: boolean | null = true
  let saved = false
  await page.route('**/api/v1/admin/catalog/7/attributes/**', async route => {
    const body = route.request().postDataJSON()
    saved = true; validity = null
    product.attributes = [{ code: 'socket', label: 'Сокет', value: body.value, value_state: body.value_state, unit: null, source_url: body.source_url, source_kind: body.source_kind }]
    await route.fulfill({ json: { product_id: 7, code: 'socket', ...body, validity_check: null } })
  })
  await page.route('**/api/v1/admin/catalog/7', route => route.fulfill({ json: { ...product, validity_check: validity, validation_reasons: [], offers: [{ source: 'p1', sku: '7', price: '12000.00', currency: 'KZT', is_current: true }] } }))
  await page.route('**/api/v1/admin/catalog?*', route => route.fulfill({ json: { items: [product], total: 1 } }))

  await page.goto('/admin/catalog')
  await expect(page.getByRole('heading', { name: 'Каталог' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'CoreLab' }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Развернуть Комплектующие' }).click()
  await expect(page.getByRole('button', { name: 'Процессоры' })).toBeVisible()
  await page.getByRole('button', { name: 'Раскрыть все' }).click()
  await expect(page.getByText('AM5')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Подбор: Комплектующие' }).click()
  await expect(page.getByRole('checkbox', { name: 'Подбор: Комплектующие' })).toBeChecked()
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Подбор: Комплектующие' })).toBeChecked()
  await page.getByRole('button', { name: 'Развернуть Комплектующие' }).click()
  await expect(page.getByRole('checkbox', { name: 'Подбор: Процессоры' })).not.toBeChecked()
  await page.getByRole('link', { name: 'Ryzen 7' }).click()
  await expect(page.getByRole('heading', { name: 'Предложения источников' })).toBeVisible()
  await page.getByRole('button', { name: 'Изменить Сокет' }).click()
  await page.getByLabel('Значение свойства').fill('Не сохранять')
  await page.getByRole('button', { name: 'Отменить Сокет' }).click()
  expect(saved).toBe(false)
  await page.getByRole('button', { name: 'Изменить Сокет' }).click()
  await page.getByLabel('Значение свойства').fill('AM5+')
  await page.getByRole('button', { name: 'Сохранить Сокет' }).click()
  await expect(page.getByText('AM5+')).toBeVisible()
  expect(validity).toBeNull()
  await page.reload()
  await expect(page.getByText('AM5+')).toBeVisible()
})

test('product card deletes a property only after confirmation', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  let attributes = [{ code: 'socket', label: 'Сокет', value: 'AM5', value_state: 'known', unit: null, source_url: null, source_kind: 'manual' }]
  const available = [{ code: 'socket', label: 'Сокет', value_type: 'string', unit: null, allowed_values: [], minimum: null, maximum: null, max_length: null, format: null, editable: true, edit_reason: null }]
  let deleted = false
  await page.route('**/api/v1/admin/catalog/7/attributes/socket', async route => {
    if (route.request().method() === 'DELETE') { deleted = true; attributes = []; await route.fulfill({ json: { product_id: 7, code: 'socket', validity_check: null } }) }
    else await route.continue()
  })
  await page.route('**/api/v1/admin/catalog/7', route => route.fulfill({ json: {
    id: 7, sku: 'p1:7', name: 'Ryzen 7', article: 'R7', manufacturer: 'AMD', categories: [{ id: 2, name: 'Процессоры' }],
    status: 'active', validity_check: true, selection_enabled: true, current_offer_count: 0, current_price: null, currency: 'KZT',
    attributes, available_attributes: available, validation_reasons: [], offers: [],
  } }))
  await page.goto('/admin/catalog/7')
  await expect(page.getByText('AM5')).toBeVisible()
  await page.getByRole('button', { name: 'Удалить Сокет' }).click()
  await expect(page.getByRole('dialog', { name: 'Удалить свойство товара' })).toBeVisible()
  expect(deleted).toBe(false)
  await page.getByRole('button', { name: 'Подтвердить удаление' }).click()
  await expect(page.getByRole('button', { name: 'Удалить Сокет' })).toHaveCount(0)
  expect(deleted).toBe(true)
})

test('mass property edit previews changes and saves only after confirmation', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  const product = { id: 7, sku: 'p1:7', name: 'Ryzen 7', article: 'R7', manufacturer: 'AMD', categories: [{ id: 2, name: 'Процессоры' }], status: 'active', validity_check: true, selection_enabled: true, current_offer_count: 0, current_price: null, currency: 'KZT', attributes: [] }
  let applied = false
  await page.route('**/api/v1/admin/catalog/categories', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/api/v1/admin/catalog/bulk-attributes/options**', route => route.fulfill({ json: { items: [
    { code: 'socket', label: 'Сокет', value_type: 'string', unit: null, allowed_values: [], editable: true },
  ] } }))
  await page.route('**/api/v1/admin/catalog/bulk-attributes/preview', async route => {
    expect(applied).toBe(false)
    await route.fulfill({ json: { attribute: { code: 'socket', label: 'Сокет', value_type: 'string', unit: null }, value_state: 'known', value: 'AM4', selected_count: 1, overwrite_count: 0, insert_count: 1, preview_token: '1234567890.signature', items: [{ product_id: 7, name: 'Ryzen 7', sku: 'p1:7', category: 'Процессоры', will_overwrite: false, previous: null }] } })
  })
  await page.route('**/api/v1/admin/catalog/bulk-attributes/apply', async route => {
    applied = true
    await route.fulfill({ json: { batch_id: 'batch', updated_count: 1, overwrite_count: 0, insert_count: 1, items: [{ product_id: 7, validity_check: null }] } })
  })
  await page.route('**/api/v1/admin/catalog?*', route => route.fulfill({ json: { items: [product], total: 1 } }))
  await page.goto('/admin/catalog')
  await page.getByRole('checkbox', { name: 'Выбрать Ryzen 7' }).check()
  await page.getByRole('button', { name: 'Изменить свойства' }).click()
  await page.getByLabel('Свойство для массового изменения').selectOption('socket')
  await page.getByLabel('Значение свойства для массового изменения').fill('AM4')
  await page.getByRole('button', { name: 'Предпросмотр изменений' }).click()
  await expect(page.getByText(/свойство будет добавлено/)).toBeVisible()
  expect(applied).toBe(false)
  await page.getByRole('button', { name: 'Подтвердить и сохранить' }).click()
  await expect(page.getByText(/Сохранено товаров: 1/)).toBeVisible()
  expect(applied).toBe(true)
})
