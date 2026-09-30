import FamilyPortal from './family-portal';
import { isMaintenanceMode } from '../lib/maintenance';

export default function Home() {
  if (isMaintenanceMode()) {
    return <main className="maintenance-page"><section className="maintenance-card">
      <p className="maintenance-eyebrow">家谱系统</p>
      <h1>系统维护中</h1>
      <p>系统正在进行安全维护，族谱读取与资料修改暂不可用。</p>
      <p>账号及族谱数据会保留，请稍后重新访问。</p>
    </section></main>;
  }
  return <FamilyPortal />;
}
