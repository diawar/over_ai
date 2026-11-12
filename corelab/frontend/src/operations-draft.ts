import type { Operations } from './organization-operations'

export function operationsDraftKey(): string | null {
  try {
    const session = JSON.parse(sessionStorage.getItem('corelab_session') ?? 'null')
    if (!Number.isSafeInteger(session?.organization?.id) || typeof session?.username !== 'string') return null
    return `corelab:operations-draft:${JSON.stringify([session.organization.id, session.username])}`
  } catch { return null }
}

export function readOperationsDraft(key: string | null): Operations | null {
  try {
    const value = key && JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (!value || !Number.isSafeInteger(value.version) || !Number.isFinite(value.assembly_workdays)
      || !Array.isArray(value.branches) || !Array.isArray(value.routes)) return null
    if (!value.branches.every((b: any) => b && ['code', 'name', 'city', 'address'].every(k => typeof b[k] === 'string')
      && typeof b.active === 'boolean' && Array.isArray(b.weekly_days_off) && b.weekly_days_off.every(Number.isInteger)
      && Array.isArray(b.calendar_exceptions) && b.calendar_exceptions.every((e: any) => e && typeof e.date === 'string' && typeof e.working === 'boolean' && typeof e.note === 'string'))) return null
    if (!value.routes.every((r: any) => r && typeof r.from_branch === 'string' && typeof r.to_branch === 'string' && Number.isFinite(r.workdays))) return null
    return value
  } catch { return null }
}

export function writeOperationsDraft(key: string | null, value: Operations | null): boolean {
  if (!key) return false
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
    return true
  } catch { return false }
}
