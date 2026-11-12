import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, ArrowUpRight,
  ArrowLeftRight, Check, ChevronDown, ChevronRight, CircleDot, FileSpreadsheet,
  House, LayoutGrid, Menu, Monitor, Package, RefreshCw, Settings, ShieldCheck,
  SlidersHorizontal, Smartphone, Sparkles, History, Search, X, Zap, Ellipsis,
  QrCode, Globe, MessageCircle, Plus, Pencil, Trash2, Save, Upload, Calculator, Eye, UserPlus, Undo2,
} from 'lucide-react'

const icons = {
  activity: Activity, 'arrow-down': ArrowDown, 'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight, 'arrow-up': ArrowUp, 'arrow-up-down': ArrowUpDown,
  'arrow-up-right': ArrowUpRight, 'arrow-left-right': ArrowLeftRight,
  check: Check, 'chevron-down': ChevronDown, 'chevron-right': ChevronRight,
  'circle-dot': CircleDot, 'file-spreadsheet': FileSpreadsheet, house: House,
  'layout-grid': LayoutGrid, menu: Menu, monitor: Monitor, package: Package,
  'refresh-cw': RefreshCw, settings: Settings, 'shield-check': ShieldCheck,
  'sliders-horizontal': SlidersHorizontal, smartphone: Smartphone,
  sparkles: Sparkles, history: History, search: Search, x: X, zap: Zap, ellipsis: Ellipsis,
  'qr-code': QrCode, globe: Globe, 'message-circle': MessageCircle,
  plus: Plus, pencil: Pencil, trash: Trash2, save: Save, upload: Upload,
  calculator: Calculator, eye: Eye, 'user-plus': UserPlus, undo: Undo2,
}

/** Decorative icons inherit the surrounding control's accessible label and color. */
export function AppIcon({ name }: { name: keyof typeof icons }) {
  const Icon = icons[name]
  return <Icon className="app-icon" size="1em" strokeWidth={2} aria-hidden="true" focusable="false" />
}
