import { createCatalogClient } from './catalog-client.mjs';

const $ = id => document.getElementById(id);
const telegram = window.Telegram?.WebApp;
const client = createCatalogClient({ storage: window.localStorage });
let page = 1;
let pageCount = 0;
let requestNumber = 0;
let currentShop = null;
let browserPreview = false;

function notice(message) { $('notice').textContent = message; }
function applyShop(shop) {
  const name = shop.short_name || shop.name;
  $('shop-name').textContent = name;
  document.title = `${name} — каталог`;
  const color = /^#[0-9a-fA-F]{6}$/.test(shop.primary_color) ? shop.primary_color : '#ff416c';
  document.documentElement.style.setProperty('--accent', color);
  const rgb = color.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  document.documentElement.style.setProperty('--on-accent', rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? '#171717' : '#ffffff');
  $('logo').hidden = !shop.logo_url;
  if (shop.logo_url) { $('logo').src = shop.logo_url; $('app-icon').href = shop.logo_url; }
  else $('app-icon').href = 'data:,';
}
function showCatalog() { $('shop-picker').hidden = true; $('detail').hidden = true; $('catalog').hidden = false; }
function clearCatalog() {
  requestNumber++;
  page = 1;
  pageCount = 0;
  $('products').replaceChildren();
  $('detail-attributes').replaceChildren();
  $('category').replaceChildren(new Option('Все категории', ''));
  $('query').value = '';
  $('catalog').hidden = true;
  $('detail').hidden = true;
}
function price(product) { return product.price === null ? 'Цена не указана' : `${product.price} ${product.currency}`; }

async function loadShops() {
  clearCatalog();
  currentShop = null;
  $('shop-name').textContent = 'Выберите магазин';
  document.title = 'Каталог';
  document.documentElement.style.removeProperty('--accent');
  $('app-icon').href = 'data:,';
  $('change-shop').hidden = true;
  $('logo').hidden = true;
  $('shop-picker').hidden = false;
  $('shops').replaceChildren();
  try {
    const result = await client.shops({ page_size: 100 });
    for (const shop of result.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = shop.short_name || shop.name;
      button.addEventListener('click', async () => {
        clearCatalog();
        notice('Открываем магазин…');
        try { await client.chooseShop(shop.id); await loadCatalog(); }
        catch { notice('Не удалось открыть магазин. Запустите приложение снова в Telegram.'); }
      });
      $('shops').append(button);
    }
    if (!result.items.length) notice('Доступных магазинов пока нет.');
  } catch { notice('Не удалось получить список магазинов. Запустите приложение снова в Telegram.'); }
}

async function loadCatalog() {
  const number = ++requestNumber;
  try {
    const context = await client.context();
    if (number !== requestNumber) return;
    applyShop(context.organization);
    const categories = await client.categories({ page_size: 100 });
    if (number !== requestNumber) return;
    currentShop = context.organization.id;
    $('change-shop').hidden = browserPreview;
    $('category').replaceChildren(new Option('Все категории', ''));
    for (const category of categories.items) $('category').add(new Option(category.name, String(category.id)));
    showCatalog();
    await loadProducts();
  } catch { if (number === requestNumber) notice('Не удалось загрузить каталог. Попробуйте открыть приложение снова.'); }
}

async function loadProducts() {
  const number = ++requestNumber;
  notice('Загружаем товары…');
  try {
    const result = await client.selectionProducts({ page, page_size: 20, q: $('query').value.trim(),
      category_id: $('category').value || null });
    if (number !== requestNumber) return;
    $('products').replaceChildren();
    $('count').textContent = `Товаров: ${result.total}`;
    pageCount = Math.ceil(result.total / result.page_size);
    $('page-label').textContent = pageCount ? `${page} / ${pageCount}` : '';
    $('previous').disabled = page <= 1;
    $('next').disabled = page >= pageCount;
    for (const product of result.items) {
      const button = document.createElement('button');
      button.className = 'product'; button.type = 'button';
      const name = document.createElement('strong'); name.textContent = product.name;
      const meta = document.createElement('span'); meta.textContent = `${product.category.name} · ${price(product)}`;
      button.append(name, meta);
      button.addEventListener('click', () => void loadProduct(product.id));
      $('products').append(button);
    }
    notice(result.total ? '' : 'По этому запросу доступных товаров нет.');
  } catch { if (number === requestNumber) notice('Не удалось загрузить товары. Повторите запрос.'); }
}

async function loadProduct(id) {
  const number = ++requestNumber;
  notice('Загружаем товар…');
  try {
    const product = await client.product(id);
    if (number !== requestNumber) return;
    $('detail-name').textContent = product.name;
    $('detail-price').textContent = price(product);
    $('detail-attributes').replaceChildren();
    for (const attribute of product.attributes) {
      if (attribute.value_state !== 'known') continue;
      const dt = document.createElement('dt'); dt.textContent = attribute.label;
      const dd = document.createElement('dd');
      dd.textContent = `${typeof attribute.value === 'object' ? JSON.stringify(attribute.value) : String(attribute.value)}${attribute.unit ? ` ${attribute.unit}` : ''}`;
      $('detail-attributes').append(dt, dd);
    }
    $('catalog').hidden = true; $('detail').hidden = false; notice('');
  } catch { if (number === requestNumber) notice('Товар больше не доступен. Обновите каталог.'); }
}

$('search').addEventListener('submit', event => { event.preventDefault(); page = 1; void loadProducts(); });
$('category').addEventListener('change', () => { page = 1; void loadProducts(); });
$('previous').addEventListener('click', () => { if (page > 1) { page--; void loadProducts(); } });
$('next').addEventListener('click', () => { if (page < pageCount) { page++; void loadProducts(); } });
$('back').addEventListener('click', () => { showCatalog(); void loadProducts(); });
$('change-shop').addEventListener('click', () => { if (currentShop !== null) void loadShops(); });

if (!telegram?.initData) {
  browserPreview = true;
  notice('Открываем предпросмотр каталога…');
  const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('corelab_csrf='))?.slice('corelab_csrf='.length) || '');
  if (location.port === '8000') $('browser-login').href = `${location.protocol}//${location.hostname}:5173/admin/login`;
  client.preview({ csrfToken }).then(() => loadCatalog()).catch(() => {
    $('shop-name').textContent = 'Каталог';
    notice('Для просмотра каталога в браузере войдите как администратор.');
    $('browser-login').hidden = false;
  });
} else {
  telegram.ready();
  notice('Проверяем вход…');
  const botAlias = new URLSearchParams(location.search).get('bot') || 'corelab';
  client.launch({ initData: telegram.initData, botAlias }).then(result => {
    if (result.launchError) notice('Ссылка на магазин недействительна или магазин недоступен.');
    return result.organization ? loadCatalog() : loadShops();
  }).catch(() => { $('shop-name').textContent = 'Каталог'; notice('Не удалось подтвердить вход через Telegram. Откройте приложение снова.'); });
}
