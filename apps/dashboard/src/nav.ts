import {
  LayoutDashboard,
  Bot,
  Plug,
  Send,
  Users,
  LifeBuoy,
  BookOpen,
  Image,
  Settings,
  ScrollText,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';
import type { IconTone } from './components/IconChip';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  tone: IconTone;
  end?: boolean;
  /** Shown in the mobile bottom tab bar (keep this to ~5 items). */
  inBottomBar?: boolean;
  adminOnly?: boolean;
}

/** Single source of truth for navigation — desktop sidebar, mobile drawer, and bottom tab bar. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Bosh sahifa', icon: LayoutDashboard, tone: 'blue', end: true, inBottomBar: true },
  { to: '/agents', label: 'AI Agentlar', icon: Bot, tone: 'violet', inBottomBar: true },
  { to: '/leads', label: 'Mijozlar (CRM)', icon: Users, tone: 'amber', inBottomBar: true },
  { to: '/telegram', label: 'Telegram', icon: Send, tone: 'cyan', inBottomBar: true },
  { to: '/connections', label: 'Ulanishlar', icon: Plug, tone: 'green' },
  { to: '/handoffs', label: "Operatorga o'tkazilgan", icon: LifeBuoy, tone: 'amber' },
  { to: '/knowledge', label: 'Bilimlar bazasi', icon: BookOpen, tone: 'green' },
  { to: '/media', label: 'Media · Rasmlar', icon: Image, tone: 'pink' },
  { to: '/settings', label: 'Sozlamalar', icon: Settings, tone: 'slate', adminOnly: true },
  { to: '/logs', label: 'Jurnal', icon: ScrollText, tone: 'slate' },
  { to: '/manual-actions', label: "Qo'lda bajariladigan ishlar", icon: ClipboardList, tone: 'red' },
];
