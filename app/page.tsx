import FamilyPortal from './family-portal';
import { isMaintenanceMode } from '../lib/maintenance';
import Link from 'next/link';

export default function Home() {
  if (isMaintenanceMode()) {
    return (
      <main className="maintenance-page">
        <section className="maintenance-card">
          <div className="maintenance-seal" aria-hidden="true">谱</div>
          <p className="maintenance-eyebrow">家谱系统</p>
          <h1>系统维护中</h1>
          <p>系统正在进行安全升级，暂时停止族谱读取和资料修改。</p>
          <p>账号和族谱数据会被安全保留，请稍后重新访问。</p>
          <output aria-live="polite">系统维护期间暂不提供族谱读取与资料修改。</output>
          <Link href="/">重新检查</Link>
        </section>
      </main>
    );
  }
  return <FamilyPortal />;
}
