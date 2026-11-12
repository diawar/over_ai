export const canManageOrganization = (role?: string) => role === 'chief_admin' || role === 'platform_admin'
export const roleLabel = (role?: string) => role === 'platform_admin' ? 'Администратор CoreLab' : role === 'chief_admin' ? 'Главный админ' : 'Пользователь'
