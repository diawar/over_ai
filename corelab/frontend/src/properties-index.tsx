import { adminFetch as fetch } from './admin-fetch'
import { AppIcon } from './icons'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import './properties-index.css'

const API = import.meta.env.VITE_API_URL ?? ''
type Category = { id: number; parent_id: number | null; name: string; selection_category: boolean; property_count: number }

export function PropertiesIndexPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/api/v1/admin/properties/categories`, { credentials: 'include', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Не удалось загрузить категории свойств.')
        return response.json()
      })
      .then(data => { if (!controller.signal.aborted) setCategories(data.items) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Категории недоступны.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])

  const rows = useMemo(() => {
    const byId = new Map(categories.map(category => [category.id, category]))
    function path(category: Category) {
      const names = [category.name]
      const visited = new Set([category.id])
      let parent = category.parent_id == null ? null : byId.get(category.parent_id)
      while (parent && !visited.has(parent.id)) {
        names.unshift(parent.name)
        visited.add(parent.id)
        parent = parent.parent_id == null ? null : byId.get(parent.parent_id)
      }
      return names.join(' / ')
    }
    const term = search.trim().toLocaleLowerCase('ru')
    return categories.map(category => ({ ...category, path: path(category) }))
      .filter(category => (!term || category.path.toLocaleLowerCase('ru').includes(term)) &&
        (filter === 'all' || (filter === 'configured' ? category.property_count > 0 : category.property_count === 0)))
      .sort((a, b) => a.path.localeCompare(b.path, 'ru'))
  }, [categories, search, filter])

  return <section className="catalog-page properties-index">
    <div className="catalog-heading"><div><p className="catalog-kicker">СТРУКТУРА КАТАЛОГА</p><h1>Свойства</h1><p>Выберите категорию, чтобы настроить её характеристики и правила проверки.</p></div></div>
    <div className="catalog-toolbar"><label className="catalog-search"><span aria-hidden="true"><AppIcon name="search" /></span><input aria-label="Поиск категории" value={search} onChange={event => setSearch(event.target.value)} placeholder="Найти категорию" /></label><label className="catalog-select-label">Показать <select aria-label="Фильтр свойств" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все категории</option><option value="configured">С настроенными свойствами</option><option value="empty">Без свойств</option></select></label><span className="catalog-found">{rows.length} категорий</span></div>
    {error && <p className="properties-index-error" role="alert">{error}</p>}
    <div className="catalog-table-wrap"><table className="catalog-table"><thead><tr><th>Категория</th><th>Свойств</th><th>Участие в подборе</th><th></th></tr></thead><tbody>{rows.map(category => <tr key={category.id} className={category.selection_category ? 'selection-participant' : ''}><td><Link className="properties-index-name" to={`/admin/categories/${category.id}/properties`}>{category.name}</Link><small className="properties-index-path">{category.path}</small></td><td>{category.property_count}</td><td>{category.selection_category ? <span className="selection-badge">Включена в подбор</span> : 'Нет'}</td><td><Link className="properties-index-open" to={`/admin/categories/${category.id}/properties`}>Открыть свойства <AppIcon name="arrow-right" /></Link></td></tr>)}</tbody></table>{!loading && !error && !rows.length && <p className="properties-index-empty">Категории по выбранным условиям не найдены.</p>}{loading && <p className="properties-index-empty">Загружаем категории…</p>}</div>
  </section>
}
