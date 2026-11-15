import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { formatQty } from '../domain/units';

export default function CandidatePanel() {
  const buildCandidates = useStore((s) => s.buildCandidates);
  const addCandidateToDraft = useStore((s) => s.addCandidateToDraft);
  const sites = useStore((s) => s.sites);
  const drugs = useStore((s) => s.drugs);
  const packageSpecs = useStore((s) => s.packageSpecs);
  const startDate = useStore((s) => s.startDate);
  const horizonDays = useStore((s) => s.horizonDays);
  const selectedSiteIds = useStore((s) => s.selectedSiteIds);
  const batches = useStore((s) => s.batches);
  const transfers = useStore((s) => s.transfers);
  const user = useStore((s) => s.user);

  const result = useMemo(
    () => buildCandidates(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batches, transfers, startDate, horizonDays, selectedSiteIds],
  );

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const drugName = (code: string) => drugs.find((d) => d.code === code)?.name ?? code;
  const readOnly = user?.role === 'viewer';

  return (
    <section className="panel">
      <h2>
        调拨候选（仅报可行建议，不宣称最优）
        <span className="hint">
          按保障优先级与缺口日期逐次分配，再比较报废风险与运输成本；到货时未失效且满足最低剩余效期的批次才可入选
        </span>
      </h2>

      {result.candidates.length === 0 && result.infeasible.length === 0 && (
        <div className="notice info">当前选择下没有需要调拨的缺口，或所有缺口均已被草稿覆盖。</div>
      )}

      {result.candidates.map((c) => {
        const inDraft = transfers.some(
          (t) => t.candidateId === c.id && t.status === 'draft' && !t.invalid,
        );
        return (
          <div className="candidate-card" key={c.id}>
            <div className="head">
              <div className="title">
                {siteName(c.fromSiteId)} → {siteName(c.toSiteId)}
                <span className="badge central" style={{ margin: '0 6px' }}>{drugName(c.drugCode)}</span>
                <span className="mono muted">{c.id}</span>
              </div>
              <div className="pill-row">
                <span className="badge danger">缺口日 {c.gapDate}</span>
                <span className="badge muted">最晚到货 {c.latestArriveDate}</span>
                <span className="badge ok">计划 {c.plannedShipDate} 发 / {c.arriveDate} 到</span>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>批次</th>
                  <th>效期</th>
                  <th className="num">数量</th>
                  <th>包装口径</th>
                </tr>
              </thead>
              <tbody>
                {c.lines.map((l) => (
                  <tr key={l.batchId}>
                    <td className="mono">{l.batchId}</td>
                    <td className="mono">{l.expiry}</td>
                    <td className="num">{l.qtyMin}</td>
                    <td className="muted">{formatQty(c.drugCode, l.qtyMin, packageSpecs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="kpi-row" style={{ marginTop: 10 }}>
              <div className="kpi"><div className="l">合计调出</div><div className="v">{c.qtyMin}</div></div>
              <div className="kpi"><div className="l">来源同范围保留需求</div><div className="v">{c.sourceReserveMin}</div></div>
              <div className="kpi"><div className="l">扣减前来源可用</div><div className="v">{c.sourceFreeBeforeMin}</div></div>
              <div className="kpi"><div className="l">运输成本（量×天）</div><div className="v">{c.transportCost}</div></div>
              <div className="kpi"><div className="l">可避免报废风险</div><div className="v warn-text">{c.wasteRiskMin}</div></div>
              <div className="kpi">
                <div className="l">送出后来源新增缺口</div>
                <div className={`v ${c.sourceNewShortageMin > 0 ? 'danger-text' : 'ok-text'}`}>
                  {c.sourceNewShortageMin}
                  {c.sourceNewGapDate && <div style={{ fontSize: 11 }}>首现 {c.sourceNewGapDate}</div>}
                </div>
              </div>
            </div>
            <ul className="reason-list">
              {c.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            <div style={{ marginTop: 8 }}>
              <button
                className="primary small"
                disabled={readOnly || inDraft}
                onClick={() => addCandidateToDraft(c)}
              >
                {inDraft ? '已在草稿中' : '加入草稿（试算）'}
              </button>
            </div>
          </div>
        );
      })}

      {result.infeasible.length > 0 && (
        <>
          <h2 style={{ marginTop: 18 }}>
            不可行缺口记录
            <span className="hint">这些缺口未生成调拨建议，原因必须保留可追溯</span>
          </h2>
          {result.infeasible.map((x) => (
            <div className="candidate-card infeasible" key={`${x.siteId}-${x.drugCode}-${x.gapDate}`}>
              <div className="head">
                <div className="title">
                  {siteName(x.siteId)} · {drugName(x.drugCode)}
                  <span className="badge danger" style={{ marginLeft: 8 }}>缺口日 {x.gapDate}</span>
                </div>
              </div>
              <ul className="reason-list">
                {x.notes.map((n, i) => (
                  <li key={i}><strong>{n.reason}：</strong>{n.detail}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
