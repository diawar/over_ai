import { AppIcon } from './icons'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import './promo.css'

const workflow = [
  { number: '01', icon: <AppIcon name="file-spreadsheet" />, title: 'Ваш прайс-лист', detail: 'CSV / XLS / JSON', text: 'Компания предоставляет существующий каталог товаров.' },
  { number: '02', icon: <AppIcon name="sparkles" />, title: 'AI-конфигуратор', detail: 'АНАЛИЗ ДАННЫХ', text: 'Система анализирует и структурирует товарные данные.' },
  { number: '03', icon: <AppIcon name="sliders-horizontal" />, title: 'Характеристики товаров', detail: 'СТРУКТУРА И ЗНАЧЕНИЯ', text: 'AI создает структуру характеристик и заполняет значения для подбора.' },
  { number: '04', icon: <AppIcon name="smartphone" />, title: 'Telegram Mini App', detail: 'ВЫБОР ПОКУПАТЕЛЯ', text: 'Покупатель выбирает товары и решения в удобном интерфейсе Telegram.' },
  { number: '05', icon: <AppIcon name="arrow-up-right" />, title: 'AI-менеджер', detail: 'ПУТЬ К СДЕЛКЕ', text: 'Помогает определить потребности и сопровождает покупателя к сделке.' },
]

const benefits = [
  { icon: <AppIcon name="file-spreadsheet" />, title: 'Умный каталог', text: 'Товарные данные, подготовленные для AI-подбора.', tone: 'orange' },
  { icon: <AppIcon name="sparkles" />, title: 'AI-характеристики', text: 'Структурированные свойства товаров для точного поиска.', tone: 'pink' },
  { icon: <AppIcon name="search" />, title: 'Интеллектуальный подбор', text: 'Подходящие товары и совместимые решения.', tone: 'violet' },
  { icon: <AppIcon name="arrow-up-right" />, title: 'Telegram-продажи', text: 'Mini App и AI-менеджер для общения с покупателями.', tone: 'green' },
]

const solutions = [
  { icon: <AppIcon name="monitor" />, title: 'Сборка ПК', status: 'Доступно', ready: true, text: 'Подбор совместимых комплектующих и создание конфигураций ПК с помощью AI.' },
  { icon: <AppIcon name="search" />, title: 'Подбор товаров по характеристикам', status: 'Скоро', ready: false, text: 'AI-подбор товаров из каталога по требованиям покупателя.' },
  { icon: <AppIcon name="zap" />, title: 'Подбор электрики', status: 'Скоро', ready: false, text: 'Интеллектуальный подбор электротехнического оборудования.' },
  { icon: <AppIcon name="house" />, title: 'Подбор умного дома', status: 'Скоро', ready: false, text: 'Подбор совместимых устройств и решений для умного дома.' },
]

function Brand() {
  return <a className="e2e-brand" href="#top" aria-label="e2e — на главную"><span className="e2e-wordmark">e2e</span><span className="e2e-tagline">end-to-end</span></a>
}

export function PromoPage() {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const oldTitle = document.title
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    const oldDescription = description?.content
    document.title = 'e2e — от прайс-листа до продажи'
    if (description) description.content = 'e2e превращает товарный каталог компании в систему интеллектуальных продаж через Telegram.'
    return () => {
      document.title = oldTitle
      if (description && oldDescription !== undefined) description.content = oldDescription
    }
  }, [])


  function followSection() { setMenuOpen(false) }

  useEffect(() => {
    if (!menuOpen) return
    function closeMenu(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        document.querySelector<HTMLButtonElement>('.e2e-menu-toggle')?.focus()
      }
    }
    document.addEventListener('keydown', closeMenu)
    return () => document.removeEventListener('keydown', closeMenu)
  }, [menuOpen])

  return <main className="e2e-page" id="top">
    <header className="e2e-header">
      <div className="e2e-header-inner">
        <Brand />
        <button className="e2e-menu-toggle" type="button" aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={menuOpen} aria-controls="e2e-nav" onClick={() => setMenuOpen(open => !open)}>
          <AppIcon name={menuOpen ? "x" : "menu"} />
        </button>
        <nav className={`e2e-nav${menuOpen ? ' is-open' : ''}`} id="e2e-nav" aria-label="Основная навигация">
          <a href="#brand-app" onClick={followSection}>Возможности</a>
          <a href="#workflow" onClick={followSection}>Как это работает</a>
          <a href="#solutions" onClick={followSection}>Направления</a>
          <a href="#features" onClick={followSection}>Преимущества</a>
          <Link className="e2e-mobile-cta" to="/register" onClick={followSection}>Создать компанию <span aria-hidden="true"><AppIcon name="arrow-up-right" /></span></Link>
          <Link className="e2e-login-mobile" to="/admin/login" onClick={followSection}>Войти</Link>
        </nav>
        <div className="e2e-header-actions"><Link className="e2e-login" to="/admin/login">Войти</Link><Link className="e2e-header-cta" to="/register" onClick={followSection}>Создать компанию <span aria-hidden="true"><AppIcon name="arrow-up-right" /></span></Link></div>
      </div>
    </header>

    <section className="e2e-hero" aria-labelledby="hero-title">
      <div className="e2e-hero-copy">
        <div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> ПЛАТФОРМА ДЛЯ ТОВАРНОГО БИЗНЕСА</div>
        <h1 id="hero-title">От прайс-листа<br />до продажи — <span>с AI</span></h1>
        <p>Превратите каталог в удобный сервис подбора. Подготовьте характеристики товаров и помогайте покупателям выбирать с AI-помощником в Telegram.</p>
        <div className="e2e-hero-tags" aria-label="Возможности платформы"><span>Единый каталог</span><span>AI-подбор</span><span>Ваш бренд</span></div>
        <div className="e2e-hero-actions">
          <Link className="e2e-button e2e-button-primary" to="/register" onClick={followSection}>Создать компанию <span aria-hidden="true"><AppIcon name="arrow-up-right" /></span></Link>
          <a className="e2e-button e2e-button-quiet" href="#workflow">Как это работает <span aria-hidden="true"><AppIcon name="arrow-down" /></span></a>
        </div>
        <div className="e2e-hero-proof"><span className="e2e-proof-icon"><AppIcon name="check" /></span><span><strong>Начните со своего каталога</strong><small>Настройте компанию, затем подключите товары</small></span></div>
      </div>

      <div className="e2e-hero-art" role="img" aria-label="Демонстрационная схема: каталог компании, Telegram Mini App, AI-конфигуратор и AI-менеджер">
        <div className="e2e-art-glow" /><div className="e2e-art-grid" />
        <div className="e2e-device-laptop"><div className="e2e-laptop-screen"><div className="e2e-demo-top"><span className="e2e-demo-brand">Магазин</span><span>Демонстрация</span></div><div className="e2e-demo-title">Каталог товаров</div><div className="e2e-demo-search"><AppIcon name="search" /> Поиск в каталоге</div><div className="e2e-demo-product"><span className="e2e-demo-product-art"><AppIcon name="package" /></span><span><b>Товар из каталога</b><small>Характеристики заполнены</small></span><i><AppIcon name="check" /></i></div><div className="e2e-demo-product"><span className="e2e-demo-product-art peach"><AppIcon name="sliders-horizontal" /></span><span><b>Совместимое решение</b><small>Доступно для подбора</small></span><i><AppIcon name="check" /></i></div></div><div className="e2e-laptop-base" /></div>
        <div className="e2e-device-phone"><div className="e2e-phone-speaker" /><div className="e2e-phone-screen"><div className="e2e-phone-head"><span className="e2e-phone-logo">М</span><span><b>Магазин</b><small>Mini App</small></span><span className="e2e-phone-menu"><AppIcon name="ellipsis" /></span></div><div className="e2e-phone-banner"><small>ПОДБОР ДЛЯ ВАС</small><b>Найдём подходящее</b></div><div className="e2e-phone-product"><span className="e2e-phone-product-art"><AppIcon name="package" /></span><b>Каталог товаров</b><small>Подбор с AI-помощником</small></div><div className="e2e-phone-chat"><span><AppIcon name="sparkles" /></span><span><b>AI-менеджер</b><small>Чем могу помочь?</small></span></div><div className="e2e-phone-button">Открыть каталог</div></div></div>
        <div className="e2e-art-float e2e-float-config"><span><AppIcon name="sparkles" /></span><b>AI-конфигуратор</b><small>Анализирует товары</small></div><div className="e2e-art-float e2e-float-manager"><span><AppIcon name="arrow-up-right" /></span><b>AI-менеджер</b><small>Помогает выбрать</small></div>
        <div className="e2e-art-line line-source" /><div className="e2e-art-line line-output" /><div className="e2e-art-pill pill-csv">CSV · XLS · JSON</div><div className="e2e-art-spark spark-one"><AppIcon name="sparkles" /></div><div className="e2e-art-spark spark-two"><AppIcon name="sparkles" /></div>
      </div>
    </section>

    <section className="e2e-workflow e2e-section" id="workflow" aria-labelledby="workflow-title">
      <div className="e2e-section-heading">
        <div><div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> КАК РАБОТАЕТ ПЛАТФОРМА</div><h2 id="workflow-title">От вашего каталога<br />до готовой сделки</h2></div>
        <p>Каждый этап опирается на один товарный каталог — данные проходят путь от прайс-листа до покупателя.</p>
      </div>
      <div className="e2e-workflow-grid">{workflow.map((item, index) => <article className="e2e-workflow-step" key={item.number}>
        <div className={`e2e-step-icon step-${index + 1}`} aria-hidden="true">{item.icon}</div><span className="e2e-step-number">{item.number}</span>
        <small className="e2e-step-detail">{item.detail}</small><h3>{item.title}</h3><p>{item.text}</p>
        {index < workflow.length - 1 && <span className="e2e-step-arrow" aria-hidden="true"><AppIcon name="arrow-right" /></span>}
      </article>)}</div>
    </section>

    <section className="e2e-features e2e-section" id="features" aria-labelledby="features-title">
      <div className="e2e-section-heading e2e-section-heading-center"><div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> ИНСТРУМЕНТЫ ДЛЯ РОСТА</div><h2 id="features-title">Одна платформа для<br />автоматизации продаж</h2><p>Товарные данные становятся основой для точного подбора и диалога с покупателем.</p></div>
      <div className="e2e-benefit-grid">{benefits.map(item => <article className="e2e-benefit-card" key={item.title}><span className={`e2e-benefit-icon tone-${item.tone}`} aria-hidden="true">{item.icon}</span><h3>{item.title}</h3><p>{item.text}</p><span className="e2e-card-arrow" aria-hidden="true"><AppIcon name="arrow-up-right" /></span></article>)}</div>
    </section>

    <section className="e2e-solutions e2e-section" id="solutions" aria-labelledby="solutions-title">
      <div className="e2e-section-heading"><div><div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> TELEGRAM MINI APP</div><h2 id="solutions-title">Выберите направление<br />для вашего бизнеса</h2></div><p>Подключайте готовые сценарии по мере развития платформы.</p></div>
      <div className="e2e-solution-grid">{solutions.map(item => <article className={`e2e-solution-card${item.ready ? ' is-ready' : ''}`} key={item.title}>
        <div className="e2e-solution-top"><span className="e2e-solution-icon" aria-hidden="true">{item.icon}</span><span className={`e2e-status${item.ready ? ' status-ready' : ''}`}><i />{item.status}</span></div>
        <h3>{item.title}</h3><p>{item.text}</p>
        {item.ready && <a className="e2e-solution-link" href="/mini-app/">Попробовать подбор ПК <span aria-hidden="true"><AppIcon name="arrow-up-right" /></span></a>}
      </article>)}</div>
    </section>

    <section className="e2e-brand-app" id="brand-app" aria-labelledby="brand-app-title">
      <div className="e2e-brand-app-inner">
        <div className="e2e-brand-app-copy"><div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> TELEGRAM MINI APP ПОД ВАШИМ БРЕНДОМ</div><h2 id="brand-app-title">Ваш Telegram Mini App.<br /><span>Ваш бренд. Ваши клиенты.</span></h2><p>e2e позволяет создать Telegram Mini App под брендом вашей компании. Покупатели взаимодействуют с вашим каталогом, получают рекомендации AI-менеджера и выбирают товары в интерфейсе с фирменным оформлением вашего бизнеса.</p><div className="e2e-brand-app-points"><article><i><AppIcon name="sparkles" /></i><span><b>Ваш фирменный стиль</b><small>Название, логотип и цвета компании</small></span></article><article><i><AppIcon name="file-spreadsheet" /></i><span><b>Ваш каталог товаров</b><small>Ассортимент вашей организации</small></span></article><article><i><AppIcon name="arrow-up-right" /></i><span><b>Ваш AI-менеджер</b><small>Помогает выбрать и купить</small></span></article><article><i><AppIcon name="activity" /></i><span><b>Прямая ссылка на приложение</b><small>Делитесь Mini App с покупателями</small></span></article></div></div>
        <div className="e2e-brand-demo" aria-label="Демонстрационный пример фирменного Mini App"><div className="e2e-brand-swatch"><span className="e2e-demo-storemark">М</span><span><b>Пример оформления</b><small>Демонстрационный магазин</small></span><div><i /><i /><i /></div></div><div className="e2e-brand-phone"><div className="e2e-brand-phone-screen"><div className="e2e-brand-store-head"><span className="e2e-demo-storemark">М</span><span><b>Магазин</b><small>Каталог и помощь</small></span><span><AppIcon name="ellipsis" /></span></div><div className="e2e-brand-phone-banner"><small>ПОДБОР ТОВАРОВ</small><b>Что вы ищете?</b></div><div className="e2e-brand-product-card"><span className="e2e-brand-product-image"><AppIcon name="shield-check" /></span><span><b>Товар из каталога</b><small>Демонстрационный пример</small><strong>Посмотреть <AppIcon name="arrow-right" /></strong></span></div><div className="e2e-brand-ai-chat"><span><AppIcon name="sparkles" /></span><span><b>AI-менеджер</b><small>Подскажу с выбором товара</small></span></div></div></div><div className="e2e-brand-demo-caption">Иллюстрация интерфейса · без данных клиентов</div></div>
      </div>
    </section>

    <section className="e2e-distribution e2e-section" id="distribution" aria-labelledby="distribution-title">
      <div className="e2e-section-heading e2e-section-heading-center"><div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> ССЫЛКА НА ВАШЕ ПРИЛОЖЕНИЕ</div><h2 id="distribution-title">Одна ссылка — множество каналов продаж</h2><p>Разместите ссылку на ваш Telegram Mini App там, где находятся покупатели. Клиент откроет приложение и сразу получит доступ к каталогу и AI-помощнику.</p></div>
      <div className="e2e-channel-grid"><article><i className="channel-social"><AppIcon name="circle-dot" /></i><b>Instagram и соцсети</b><p>Ссылка в профиле, публикациях и рекламе.</p></article><article><i className="channel-site"><AppIcon name="globe" /></i><b>Ваш сайт</b><p>Кнопка перехода в Mini App на сайте компании.</p></article><article><i className="channel-qr"><AppIcon name="qr-code" /></i><b>QR-код</b><p>Для офиса, магазина и печатных материалов.</p></article><article><i className="channel-chat"><AppIcon name="message-circle" /></i><b>Мессенджеры</b><p>Ссылка в сообщениях и коммерческих предложениях.</p></article></div>
      <div className="e2e-sales-flow"><div className="e2e-flow-sources"><span><AppIcon name="circle-dot" /> <b>Соцсети</b></span><span><AppIcon name="globe" /> <b>Сайт</b></span><span><AppIcon name="qr-code" /> <b>QR-код</b></span><span><AppIcon name="message-circle" /> <b>Мессенджеры</b></span></div><div className="e2e-flow-down"><AppIcon name="arrow-down" /></div><div className="e2e-flow-app"><span>e2e</span><b>Telegram Mini App вашей компании</b></div><div className="e2e-flow-down"><AppIcon name="arrow-down" /></div><div className="e2e-flow-outcomes"><span><AppIcon name="sparkles" /> AI-менеджер</span><i><AppIcon name="arrow-right" /></i><span><AppIcon name="search" /> Подбор товаров</span><i><AppIcon name="arrow-right" /></i><span><AppIcon name="check" /> Сделка</span></div><p>Информационная схема. Адрес приложения появится после подключения организации.</p></div>
    </section>

    <section className="e2e-final-cta" aria-labelledby="final-title">
      <div className="e2e-final-orb" aria-hidden="true" /><div className="e2e-final-copy"><div className="e2e-eyebrow"><span className="e2e-eyebrow-dot" /> ПЛАТФОРМА E2E</div><h2 id="final-title">Ваш каталог может<br />продавать умнее</h2><p>Создайте интеллектуальный каталог, запустите Telegram Mini App под своим брендом и привлекайте покупателей из любых каналов.</p></div>
      <Link className="e2e-button e2e-button-light" to="/register" onClick={followSection}>Создать компанию <span aria-hidden="true"><AppIcon name="arrow-up-right" /></span></Link>
    </section>

    <footer className="e2e-footer">
      <div className="e2e-footer-main"><div className="e2e-footer-brand"><Brand /><p>Платформа для подготовки товарного каталога, интеллектуального подбора и продаж через Telegram.</p></div>
        <div className="e2e-footer-links"><strong>Навигация</strong><a href="#brand-app">Возможности</a><a href="#workflow">Как это работает</a><a href="#solutions">Направления</a><a href="#features">Преимущества</a><Link to="/admin/login">Вход для администратора</Link></div></div>
      <div className="e2e-footer-bottom"><span>© {new Date().getFullYear()} e2e</span><span>end-to-end</span></div>
    </footer>


  </main>
}
