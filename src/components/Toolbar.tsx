import { useStore } from '../store/useStore';
import { horizonEndDate } from '../store/useStore';

const KIND_LABEL: Record<string, string> = {
  central: '中心仓',
  district: '区级站',
  station: '医疗点',
  field: '野外驻点',
};

export default function Toolbar() {
  const {
    sites,
    startDate,
    horizonDays,
    selectedSiteIds,
    setStartDate,
    setHorizon,
    toggleSite,
    resetDemo,
    user,
  } = useStore();

  return (
    <section className="panel">
      <h2>
        分析参数
        <span className="hint">先选起日、保障天数与参与点位，页面展示未调拨基线；候选与草稿只做试算，不写正式库存</span>
      </h2>
      <div className="toolbar-grid">
        <div className="field">
          <label htmlFor="start">分析起日</label>
          <input
            id="start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="horizon">保障天数（7–90）</label>
          <input
            id="horizon"
            type="number"
            min={7}
            max={90}
            value={horizonDays}
            onChange={(e) => setHorizon(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label>视窗截止</label>
          <input type="date" value={horizonEndDate(startDate, horizonDays)} disabled />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 320 }}>
          <label>参与点位（缺需求资料的驻点不能自动当成富余仓）</label>
          <div className="site-picker">
            {sites.map((s) => (
              <label key={s.id} className={`site-chip ${selectedSiteIds.includes(s.id) ? 'active' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedSiteIds.includes(s.id)}
                  onChange={() => toggleSite(s.id)}
                  style={{ margin: 0 }}
                />
                <span className={`badge ${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                {s.name}
                {!s.demandDeclared && <span className="badge warn">需求资料缺失</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="field">
          <button onClick={resetDemo}>重置演示数据</button>
        </div>
        <div className="field">
          <span className="muted" style={{ fontSize: 12 }}>
            当前身份：{user?.displayName}（{user?.role === 'planner' ? '可操作' : '只读'}）
          </span>
        </div>
      </div>
    </section>
  );
}
