import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AdminLayout, LoginPage } from './pages'
import './style.css'
import { SourcesPage } from './sources'
import { CatalogPage, CatalogProductPage } from './catalog'
import { PerformanceModelsPage } from './performance-models'
import { PropertyRulesPage } from './properties'
import { PropertiesIndexPage } from './properties-index'
import { PropertyValuesPage } from './property-values'
import { SettingsPage } from './settings'
import { LogsPage } from './logs'
import { OrganizationsPage } from './organizations'
import { PlatformUsersPage } from './platform-users'
import { RegistrationPage } from './registration'
import { OnboardingPage } from './onboarding'
import './mini-theme.css'
import { PromoPage } from './promo'
import './public-refinement.css'
import './icons.css'
import './admin-responsive.css'
import './organization-theme.css'

function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<PromoPage />} />
    <Route path="/admin/login" element={<LoginPage />} />
    <Route path="/register" element={<RegistrationPage />} />
    <Route path="/admin" element={<AdminLayout />}>
      <Route index element={<Navigate to="catalog" replace />} />
      <Route path="catalog" element={<CatalogPage />} />
      <Route path="performance-models" element={<PerformanceModelsPage />} />
      <Route path="catalog/:productId" element={<CatalogProductPage />} />
      <Route path="properties" element={<PropertyValuesPage />} />
      <Route path="properties/categories" element={<PropertiesIndexPage />} />
      <Route path="categories/:categoryId/properties" element={<PropertyRulesPage />} />
      <Route path="sources" element={<SourcesPage />} />
      <Route path="logs" element={<LogsPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="organizations" element={<OrganizationsPage />} />
      <Route path="platform-users" element={<PlatformUsersPage />} />
      <Route path="setup" element={<OnboardingPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
