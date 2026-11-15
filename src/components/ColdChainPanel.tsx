import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { latestCheck, dispositionOf } from '../store/coldChainState';
import { coldBoxes, coldShipments } from '../data/coldChainData';
import {
  fmtMinutes,
  formatClock,
  formatDateTime,
  type ColdCheck,
} from '../domain/coldchain';
import ColdChainChart from './ColdChainChart';

const TRIGGER_LABEL: Record<ColdCheck['trigger'], string> = {
  initial: '初始核查',
  'late-upload': '迟报补传触发',
  'calibration-revision': '校准修订触发',
};

const KIND_LABEL: Record<string, string> = {
  'door-open': '开箱',
  'vehicle-change': '换车交接',
  'sensor-change': '更换传感器',
};

export default function ColdChainPanel() {
  const {
    sites,
    drugs,
    coldChecks,
    coldDispositions,
    coldQuarantine,
    lateInserted,
    calibrationApplied,
    user,
    insertLateReading,
    applyCalibration,
    decideColdDisposition,
  } = useStore();

  const [selectedShipment, setSelectedShipment] = useState(coldShipments[0].id);
  const readOnly = user?.role === 'viewer';

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const drugName = (code: string) => drugs.find((d) => d.code === code)?.name ?? code;

  const shipment = coldShipments.find((s) => s.id === selectedShipment)!;
  const box = coldBoxes.find((b) => b.shipmentId === shipment.id)!;
  const latest = latestCheck(coldChecks, shipment.id)!;
  const analysis = latest.result.analysis;
  const disposition = dispositionOf(coldDispositions, shipment.id);
  const shipmentChecks = coldChecks.filter((c) => c.shipmentId === shipment.id);
  const quarantineLines = coldQuarantine.filter((q) => q.shipmentId === shipment.id);

  const verdictBadge = (verdict: ColdCheck['result']['verdict']) =>
    verdict === 'acceptable'
      ? { text: '可按流程接收', cls: 'ok' }
      : { text: '待复核', cls: 'danger' };

  const kpis = useMemo(
    () => [
      { label: '核查窗口', value: `${fmtMinutes(analysis.totalWindowMs)} 分钟` },
      { label: '连续越界(最长)', value: `${fmtMinutes(analysis.maxContinuousExcursionMs)} 分钟`, danger: analysis.maxContinuousExcursionMs >= latest.result.rule.maxContinuousExcursionMs },
      { label: '累计越界', value: `${fmtMinutes(analysis.excursionMs)} 分钟`, danger: analysis.excursionMs >= latest.result.rule.maxCumulativeExcursionMs },
      { label: '未知/缺测', value: `${fmtMinutes(analysis.unknownMs)} 分钟`, danger: analysis.unknownMs >= latest.result.rule.maxUnknownMs },
      { label: '可信正常', value: `${fmtMinutes(analysis.normalMs)} 分钟` },
      { label: '连续越界段', value: `${analysis.continuousExcursions.length} 段` },
      { label: '未知区间', value: `${analysis.unknownSegments.length} 段` },
    ],
    [analysis, latest],
  );

  const badge = verdictBadge(latest.result.verdict);

  return (
    <section className="panel">
      <h2>
        冷链运输记录核查
        <span className="hint">
          按设备序号去重、同序异值单列；仅在最大可信采样间隔（{fmtMinutes(shipment.maxCredibleGapMs)} 分钟）内线性连接，超间隔列未知；
          只给流程结论，不判断真实药品是否可用
        </span>
      </h2>

      {/* 运输任务选择 */}
      <div className="site-picker" style={{ marginBottom: 14 }}>
        {coldShipments.map((s) => {
          const chk = latestCheck(coldChecks, s.id)!;
          const b = verdictBadge(chk.result.verdict);
          return (
            <button
              key={s.id}
              className={`site-chip ${s.id === selectedShipment ? 'active' : ''}`}
              onClick={() => setSelectedShipment(s.id)}
            >
              <span className="mono">{s.id}</span>
              <span className={`badge ${b.cls}`}>{b.text}</span>
            </button>
          );
        })}
      </div>

      {/* 任务与箱体信息 */}
      <div className="detail-box">
        <div className="pill-row" style={{ justifyContent: 'space-between' }}>
          <div>
            <strong className="mono">{shipment.id}</strong>
            <span className="muted"> ｜ 箱体 {box.id} ｜ {siteName(shipment.fromSiteId)} → {siteName(shipment.toSiteId)}</span>
          </div>
          <div>
            <span className={`badge ${badge.cls}`} style={{ fontSize: 12 }}>
              最新检查 {latest.id}：{badge.text}
            </span>
            {disposition && (
              <span className="badge central" style={{ fontSize: 12, marginLeft: 6 }}>
                已处置：{disposition.decision === 'release' ? '批准放行' : '继续隔离'}（{disposition.checkId}）
              </span>
            )}
          </div>
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          核查窗口（UTC）：{formatDateTime(shipment.startAt)} – {formatDateTime(shipment.endAt)} ｜ 阈值 {shipment.threshold.minC}–{shipment.threshold.maxC}℃ ｜ 药品 {drugName(box.drugCode)}
        </div>
        <div style={{ marginTop: 6 }}>
          同箱批次（共享同一运输证据，时长不重复累计）：
          {box.batchIds.map((b) => {
            const line = quarantineLines.find((q) => q.batchId === b)!;
            const statusText = line.status === 'released' ? '已进入可用余量' : line.status === 'held' ? '复核后继续隔离' : '隔离待处置';
            const statusCls = line.status === 'released' ? 'ok' : 'warn';
            return (
              <span key={b} className="site-chip" style={{ padding: '3px 8px', marginLeft: 6 }}>
                <span className="mono">{b}</span>
                <span className="muted">{line.qtyMin} 单位</span>
                <span className={`badge ${statusCls}`}>{statusText}</span>
              </span>
            );
          })}
        </div>
      </div>

      {/* 指标 */}
      <div className="kpi-row" style={{ marginTop: 12 }}>
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <div className="l">{k.label}</div>
            <div className="v" style={k.danger ? { color: 'var(--danger)' } : undefined}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* 结论原因 */}
      <div className={`notice ${latest.result.verdict === 'acceptable' ? 'info' : 'error'}`} style={{ marginTop: 4 }}>
        {latest.result.reasons.length > 0 ? (
          <>
            <strong>待复核依据（不跨断联把两段超限连成一段确定事实）：</strong>
            <ul className="reason-list">
              {latest.result.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </>
        ) : (
          <span>连续越界、累计越界、未知缺测均低于待复核阈值且无数据冲突，可按流程接收（仍不代表对真实药品可用性的判断）。</span>
        )}
      </div>

      {/* 曲线图 */}
      <ColdChainChart shipment={shipment} analysis={analysis} />

      {/* 数据质量：冲突/重复/窗口外 */}
      <h2 style={{ fontSize: 13.5, marginTop: 18 }}>数据质量与交接资料（固定文件）</h2>
      <div className="grid-2">
        <div>
          <table>
            <thead>
              <tr><th>类型</th><th>明细</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="danger-text">同序异值冲突</td>
                <td>{analysis.clean.conflicts.length ? analysis.clean.conflicts.map((c) => `${c.deviceId}#${c.seq}=${c.valuesC.join('/')}℃`).join('；') : '无'}</td>
              </tr>
              <tr>
                <td className="danger-text">重叠数据冲突</td>
                <td>{analysis.clean.overlapConflicts.length ? analysis.clean.overlapConflicts.map((c) => `${formatClock(c.sampledAt)} ${c.deviceValues.map((v) => `${v.deviceId}:${v.tempC}℃`).join(' vs ')}`).join('；') : '无'}</td>
              </tr>
              <tr>
                <td className="muted">完全重复（已折叠）</td>
                <td>{analysis.clean.duplicates.length ? analysis.clean.duplicates.map((d) => `${d.readingId}→保留${d.keptReadingId}`).join('；') : '无'}</td>
              </tr>
              <tr>
                <td className="muted">窗口外读数</td>
                <td>{analysis.clean.outsideWindow.length ? analysis.clean.outsideWindow.join('、') : '无'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <table>
            <thead>
              <tr><th>时间(UTC)</th><th>交接类型</th><th>说明 / 设备衔接</th></tr>
            </thead>
            <tbody>
              {shipment.handovers.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{formatClock(h.at)}</td>
                  <td>{KIND_LABEL[h.kind]}</td>
                  <td className="muted">{h.note}{h.fromDeviceId ? `（${h.fromDeviceId} → ${h.toDeviceId}）` : ''}</td>
                </tr>
              ))}
              {shipment.handovers.length === 0 && <tr><td colSpan={3} className="muted">无交接记录</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* 检查历史：迟报/校准生成新检查，已批准处置保留原记录 */}
      <h2 style={{ fontSize: 13.5, marginTop: 18 }}>检查历史（固定任务文件；迟报/校准另生成新检查，不覆盖历史）</h2>
      <table>
        <thead>
          <tr>
            <th>检查号</th><th>触发方式</th><th>生成时间(UTC)</th><th>结论</th>
            <th className="num">连续越界(分)</th><th className="num">累计越界(分)</th><th className="num">未知(分)</th><th>读数快照数</th>
          </tr>
        </thead>
        <tbody>
          {shipmentChecks.map((c) => {
            const b = verdictBadge(c.result.verdict);
            return (
              <tr key={c.id}>
                <td className="mono">{c.id}</td>
                <td>{TRIGGER_LABEL[c.trigger]}</td>
                <td className="mono">{formatDateTime(c.createdAt)}</td>
                <td><span className={`badge ${b.cls}`}>{b.text}</span></td>
                <td className="num">{fmtMinutes(c.result.analysis.maxContinuousExcursionMs)}</td>
                <td className="num">{fmtMinutes(c.result.analysis.excursionMs)}</td>
                <td className="num">{fmtMinutes(c.result.analysis.unknownMs)}</td>
                <td className="num">{c.readingIds.length}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 操作区 */}
      <h2 style={{ fontSize: 13.5, marginTop: 18 }}>核查操作与处置（受影响批次先隔离，批准后才进入可用余量）</h2>
      <div className="pill-row">
        {shipment.id === 'CC-2001' && (
          <button className="small primary" disabled={readOnly || lateInserted} onClick={insertLateReading}>
            {lateInserted ? '迟报读数已插入（新检查已生成）' : '插入一条迟报读数（演示未知区间 120→90 分钟）'}
          </button>
        )}
        {shipment.id === 'CC-2002' && (
          <button className="small primary" disabled={readOnly || calibrationApplied} onClick={applyCalibration}>
            {calibrationApplied ? '校准修订已应用（已重新核验）' : '应用校准修订（4 条漂移读数，触发重新核验）'}
          </button>
        )}
        <button
          className="small"
          disabled={readOnly || !!disposition || latest.result.verdict !== 'acceptable'}
          onClick={() => decideColdDisposition(shipment.id, 'release')}
        >
          批准放行进入可用余量
        </button>
        <button
          className="small danger"
          disabled={readOnly || !!disposition}
          onClick={() => decideColdDisposition(shipment.id, 'quarantine')}
        >
          复核后继续隔离
        </button>
        {disposition && (
          <span className="badge central">已有批准处置（{disposition.checkId}），保留原记录不再改写</span>
        )}
        {!disposition && latest.result.verdict === 'pending-review' && (
          <span className="badge danger">待复核状态下「批准放行」按钮禁用；确需放行须先完成复核并使最新检查可接收</span>
        )}
      </div>
      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        隔离闸门：批次在批准前停留于隔离区，不写入正式库存、不出现在调拨候选与缺口推演中；批准放行后才逐批注入接收点可用余量。
      </div>
    </section>
  );
}
