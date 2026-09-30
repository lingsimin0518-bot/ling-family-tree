import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isMaintenanceMode } from '../../lib/maintenance';
import MaintenanceAdminPanel from './panel';
import './style.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '维护期管理员入口 · 家谱',
  robots: { index: false, follow: false },
};

export default function MaintenanceAdminPage() {
  if (!isMaintenanceMode()) notFound();
  return <MaintenanceAdminPanel />;
}
