import { useState } from 'react';
import { useStore } from './store/useStore';
import Login from './components/Login';
import Toolbar from './components/Toolbar';
import GapOverview from './components/GapOverview';
import CandidatePanel from './components/CandidatePanel';
import TransferLifecycle from './components/TransferLifecycle';
import InventoryPanel from './components/InventoryPanel';
import EventLog from './components/EventLog';
import ColdChainPanel from './components/ColdChainPanel';

type Tab = 'gap' | 'candidate' | 'transfer' | 'coldchain' | 'inventory' | 'events';

const TABS: { key: Tab; label: string }[] = [
  { key: 'gap', label: '缺口分析（双情景）' },
  { key: 'candidate', label: '调拨候选' },
  { key: 'transfer', label: '调拨工作台' },
  { key: 'coldchain', label: '冷链运输核查' },
  { key: 'inventory', label: '库存与换算' },
  { key: 'events', label: '事件日志' },
];

export default function App() {
  const user = useStore((s) => s.user);
  const notice = useStore((s) => s.notice);
  const rejected = useStore((s) => s.rejected);
  const clearNotice = useStore((s) => s.clearNotice);
  const logout = useStore((s) => s.logout);
  const [tab, setTab] = useState<Tab>('gap');

  if (!user) return <Login />;

  return (
    <div>
      <header className="app-header">
        <div>
          <h1>区域急救药品库存与调拨分析</h1>
          <div className="sub">全部计算在浏览器本地执行 · 固定演示数据 · 不接真实医疗系统，不推断临床替代</div>
        </div>
        <div className="header-user">
          <span>{user.displayName}</span>
          <span className="badge" style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}>
            {user.role === 'planner' ? '可操作' : '只读'}
          </span>
          <button
            style={{ background: 'rgba(255,255,255,0.16)', color: '#fff', borderColor: 'rgba(255,255,255,0.4)' }}
            onClick={logout}
          >
            退出
          </button>
        </div>
      </header>

      <main className="layout">
        <Toolbar />

        {notice && (
          <div className={`notice ${rejected.length ? 'error' : 'info'}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>{notice}</span>
            <button className="small" onClick={clearNotice}>知道了</button>
          </div>
        )}

        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? 'active' : ''}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'gap' && <GapOverview />}
        {tab === 'candidate' && <CandidatePanel />}
        {tab === 'transfer' && <TransferLifecycle />}
        {tab === 'coldchain' && <ColdChainPanel />}
        {tab === 'inventory' && <InventoryPanel />}
        {tab === 'events' && <EventLog />}
      </main>
    </div>
  );
}
