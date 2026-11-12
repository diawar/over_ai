import { expect, test } from '@playwright/test'

test('category requirements: check, edit, block, reload and cancel', async ({ page }) => {
  let blocked = false
  let current = false
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  const rule = () => ({ id: 1, scope: '2', revision: 1, code: 'socket', label: 'Сокет', source: 'internal', level: 'recommended', value_type: 'string', unit: null, condition: null, applies_when: null, allowed_values: [], normalization: {}, minimum: null, maximum: null, max_length: null, format: null, evidence_url: null, checked_on: null, note: '', ai_blocked: blocked, required_for_selection: false })
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  await page.route('**/api/v1/admin/properties/**', async route => {
    const url = route.request().url()
    if (url.endsWith('/templates')) return route.fulfill({ json: { items: [] } })
    if (url.endsWith('/check')) current = true
    if (route.request().method() === 'PATCH') { blocked = route.request().postDataJSON().ai_blocked; current = false }
    return route.fulfill({ json: { category: { id: 2, name: 'Процессоры' }, items: [rule()], check: { status: 'warning', structure_status: 'success', current, errors: [], warnings: ['Не проверены официальные модели'], ai_load_allowed: false, load_reason: 'Загрузчик ещё не подключён' } } })
  })
  await page.goto('/admin/categories/2/properties')
  await expect(page.getByRole('heading', { name: 'Свойства: Процессоры' })).toBeVisible()
  await page.getByRole('button', { name: 'Проверить структуру свойств' }).click()
  await expect(page.getByText('Проверка актуальна')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Загрузить свойства' })).toBeDisabled()
  await page.getByRole('button', { name: 'Блокировать для ИИ' }).click()
  await expect(page.getByText('Структуру необходимо проверить')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Разблокировать для ИИ' })).toBeVisible()
  await page.getByRole('button', { name: 'Изменить' }).click()
  await page.getByRole('combobox', { name: /^Обязательность заполнения свойства/ }).selectOption('conditional')
  await expect(page.getByLabel('Условие обязательности', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(page.getByText('Рекомендуется', { exact: true })).toBeVisible()
})

test('empty category can generate a structure from mocked manufacturer research', async ({ page }) => {
  let generated = false
  await page.addInitScript(() => sessionStorage.setItem('corelab_session', JSON.stringify({ username: 'e2e', role: 'admin' })))
  await page.route('**/api/v1/admin/auth/me', route => route.fulfill({ json: { username: 'e2e', role: 'admin' } }))
  await page.route('**/api/v1/admin/properties/**', async route => {
    const url = route.request().url()
    if (url.endsWith('/templates')) return route.fulfill({ json: { items: [] } })
    if (url.endsWith('/generate')) {
      generated = true
      return route.fulfill({ json: { created: 1, models: [
        { manufacturer: 'ASUS', model: 'Model A', url: 'https://www.asus.com/model-a' },
        { manufacturer: 'ASUS', model: 'Model B', url: 'https://www.asus.com/model-b' },
      ], research: { citations: ['https://www.asus.com/model-a', 'https://www.asus.com/model-b'], model_id: 'gpt-5.5', checked_at: '2026-10-17' } } })
    }
    return route.fulfill({ json: { category: { id: 2, name: 'Материнские платы', can_generate_structure: !generated }, items: generated ? [
      { id: 8, scope: '2', revision: 1, code: 'memory_type', label: 'Тип памяти', source: 'internal', level: 'recommended', value_type: 'string', unit: null, condition: null, applies_when: null, allowed_values: [], normalization: {}, minimum: null, maximum: null, max_length: null, format: null, evidence_url: 'https://www.asus.com/model-a', checked_on: '2026-10-17', note: 'Тип памяти', ai_blocked: false, required_for_selection: false },
    ] : [], check: { status: 'success', structure_status: 'success', current: generated, errors: [], warnings: [], ai_load_allowed: false, load_reason: 'Карточки товаров не загружаются этим действием' } } })
  })
  await page.goto('/admin/categories/2/properties')
  await page.getByRole('button', { name: 'Сформировать свойства с ИИ' }).click()
  await expect(page.getByText('Добавлено свойств: 1')).toBeVisible()
  await expect(page.getByText('ASUS Model A')).toBeVisible()
  await expect(page.getByRole('cell', { name: /Тип памяти/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Сформировать свойства с ИИ' })).toBeDisabled()
})
