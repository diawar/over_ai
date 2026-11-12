import type { CSSProperties } from 'react'

export const E2E_COLOR = '#ff416c'
// Revalidate the former default with the server before rendering it from old storage.
export function initialColor(id?: number, sessionColor?: string): string | null {
  const color = cachedColor(id) || (validColor(sessionColor) ? sessionColor : null)
  return color?.toLowerCase() === '#5146e5' ? null : color
}

const key = (id: number) => `corelab:brand-color:${id}`
export const validColor = (color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
export function cachedColor(id?: number): string | null {
  if (!id) return null
  try { const color = localStorage.getItem(key(id)); return validColor(color) ? color : null } catch { return null }
}
export function rememberColor(id: number, color: unknown) {
  if (!id || !validColor(color)) return
  try { localStorage.setItem(key(id), color) } catch { /* Theme still works without browser storage. */ }
  window.dispatchEvent(new CustomEvent('corelab:brand-color', { detail: { id, color } }))
}
export function themeStyle(color: string): CSSProperties {
  const rgb = color.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
  const linear = rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722
  return { '--accent': color, '--on-accent': luminance > .179 ? '#171717' : '#ffffff' } as CSSProperties
}
