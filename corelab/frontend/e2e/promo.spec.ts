import { expect, test } from '@playwright/test'

test('public e2e landing presents the platform and working scenarios', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/e2e/)
  await expect(page.getByRole('link', { name: 'e2e — на главную' }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'От прайс-листа до продажи — с AI' })).toBeVisible()
  await expect(page.locator('.e2e-page')).not.toContainText('CoreLab')

  for (const heading of ['Ваш прайс-лист', 'AI-конфигуратор', 'Характеристики товаров', 'Telegram Mini App', 'AI-менеджер']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  for (const heading of ['Сборка ПК', 'Подбор товаров по характеристикам', 'Подбор электрики', 'Подбор умного дома']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
  await expect(page.getByRole('heading', { name: 'Ваш Telegram Mini App. Ваш бренд. Ваши клиенты.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Одна ссылка — множество каналов продаж' })).toBeVisible()
  for (const channel of ['Instagram и соцсети', 'Ваш сайт', 'QR-код', 'Мессенджеры']) {
    await expect(page.locator('.e2e-channel-grid article').filter({ hasText: channel })).toHaveCount(1)
  }
  await expect(page.locator('.e2e-sales-flow')).toContainText('Telegram Mini App вашей компании')
  await expect(page.locator('.e2e-sales-flow')).toContainText('Адрес приложения появится после подключения организации')
  await expect(page.locator('.e2e-status').filter({ hasText: 'Доступно' })).toHaveCount(1)
  await expect(page.locator('.e2e-status').filter({ hasText: 'Скоро' })).toHaveCount(3)

  await expect(page.locator('.e2e-header').getByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/admin/login')
  await expect(page.locator('.e2e-header').getByRole('link', { name: 'Возможности' })).toHaveAttribute('href', '#brand-app')
  await expect(page.locator('.e2e-header').getByRole('link', { name: 'Преимущества' })).toHaveAttribute('href', '#features')
  await expect(page.locator('.e2e-wordmark').first()).toHaveCSS('background-image', /linear-gradient/)
  await page.locator('.e2e-header').getByRole('link', { name: 'Как это работает' }).click()
  await expect(page).toHaveURL(/#workflow$/)
  await expect(page.getByRole('heading', { name: 'От вашего каталога до готовой сделки' })).toBeVisible()

  await page.getByRole('button', { name: 'Подключить компанию' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Самостоятельная регистрация компаний скоро появится')
  await dialog.getByRole('button', { name: 'Закрыть окно' }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: 'Подключить компанию' }).last().click()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
})

for (const width of [375, 768, 1280, 1920]) {
  test(`landing has no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport)
    await expect(page.getByRole('heading', { name: 'От прайс-листа до продажи — с AI' })).toBeVisible()
    if (width === 375) {
      const menu = page.getByRole('button', { name: 'Открыть меню' })
      await expect(menu).toBeVisible()
      await menu.click()
      const nav = page.getByRole('navigation', { name: 'Основная навигация' })
      await expect(nav.getByRole('link', { name: 'Направления' })).toBeVisible()
      const mobileCta = nav.getByRole('button', { name: 'Подключить компанию' })
      await expect(mobileCta).toBeVisible()
      await mobileCta.click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: 'Закрыть окно' }).click()
    }
  })
}

test('existing admin login route remains available', async ({ page }) => {
  await page.goto('/admin/login')
  await expect(page.getByRole('heading', { name: 'Войти в систему' })).toBeVisible()
  await expect(page.getByLabel('Логин')).toBeVisible()
  await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible()
})

test('login supports password visibility, help and server errors', async ({ page }) => {
  await page.route('**/api/v1/admin/auth/login', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"Invalid credentials"}' }))
  await page.goto('/admin/login')
  await page.getByLabel('Логин', { exact: true }).fill('demo')
  const password = page.getByLabel('Пароль', { exact: true })
  await password.fill('example-password')
  await page.getByRole('button', { name: 'Показать пароль', exact: true }).click()
  await expect(password).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Скрыть пароль', exact: true }).click()
  await expect(password).toHaveAttribute('type', 'password')
  await page.getByRole('button', { name: 'Войти в систему' }).click()
  await expect(page.getByRole('alert')).toHaveText('Неверный логин или пароль')
  await expect(page.getByRole('button', { name: 'Войти в систему' })).toBeEnabled()
  await page.getByText('Не получается войти?').click()
  await expect(page.getByText(/Проверьте раскладку клавиатуры/)).toBeVisible()
})

for (const width of [375, 1440]) {
  test(`public pages visual verification at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    for (const [route, name] of [['/', 'home'], ['/admin/login', 'login']]) {
      await page.goto(route)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      if (name === 'login' && width === 375) {
        const submit = await page.getByRole('button', { name: 'Войти в систему' }).boundingBox()
        expect(submit!.y + submit!.height).toBeLessThan(900)
      }
      await page.screenshot({ path: `../../.handoff-runtime/${name}-${width}.png`, fullPage: true })
    }
  })
}
