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
  UserCog,
  ScrollText,
  ClipboardList,
  GraduationCap,
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

/**
 * Single source of truth for navigation — desktop sidebar, mobile drawer, and
 * bottom tab bar.
 *
 * `adminOnly` here is presentation only. The server enforces the same split
 * independently (see `adminOnly` / `requireAdmin` in the API middleware): an
 * operator who types an admin URL gets a 401 from the API even though the SPA
 * also refuses to route them there.
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Bosh sahifa', icon: LayoutDashboard, tone: 'blue', end: true, inBottomBar: true, adminOnly: true },
  { to: '/agents', label: 'AI Agentlar', icon: Bot, tone: 'violet', inBottomBar: true, adminOnly: true },
  { to: '/leads', label: 'Mijozlar (CRM)', icon: Users, tone: 'amber', inBottomBar: true },
  { to: '/registrations', label: 'Kursga yozilishlar', icon: GraduationCap, tone: 'green', inBottomBar: true },
  { to: '/telegram', label: 'Telegram', icon: Send, tone: 'cyan', inBottomBar: true, adminOnly: true },
  { to: '/connections', label: 'Ulanishlar', icon: Plug, tone: 'green', adminOnly: true },
  { to: '/handoffs', label: "Operatorga o'tkazilgan", icon: LifeBuoy, tone: 'amber' },
  { to: '/knowledge', label: 'Bilimlar bazasi', icon: BookOpen, tone: 'green', adminOnly: true },
  { to: '/media', label: 'Media · Rasmlar', icon: Image, tone: 'pink', adminOnly: true },
  { to: '/team', label: 'Jamoa va biznes', icon: UserCog, tone: 'blue', adminOnly: true },
  { to: '/settings', label: 'Sozlamalar', icon: Settings, tone: 'slate', adminOnly: true },
  { to: '/logs', label: 'Jurnal', icon: ScrollText, tone: 'slate', adminOnly: true },
  { to: '/manual-actions', label: "Qo'lda bajariladigan ishlar", icon: ClipboardList, tone: 'red', adminOnly: true },
];

/** Where a signed-in user lands, and where an unknown route sends them. */
export function homeRouteFor(role: 'ADMIN' | 'OPERATOR'): string {
  return role === 'ADMIN' ? '/' : '/leads';
}
