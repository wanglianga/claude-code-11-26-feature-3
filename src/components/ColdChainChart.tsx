import { useMemo, useState } from 'react';
import {
  formatClock,
  formatDateTime,
  type ColdChainAnalysis,
  type ColdShipment,
  type TemperatureSegment,
} from '../domain/coldchain';

interface Props {
  shipment: ColdShipment;
  analysis: ColdChainAnalysis;
}

const W = 880;
const H = 320;
const PAD = { top: 24, right: 20, bottom: 46, left: 56 };

const STATUS_FILL: Record<TemperatureSegment['status'], string> = {
  normal: 'rgba(30,132,73,0.10)',
  'excursion-high': 'rgba(192,57,43,0.16)',
  'excursion-low': 'rgba(108,63,180,0.16)',
  unknown: 'url(#unknownHatch)',
};

const ISSUE_LABEL: Record<string, string> = {
  duplicate: '完全重复',
  'same-seq-conflict': '同序异值冲突',
  'out-of-order': '乱序',
  late: '迟报补传',
  revision: '校准修订值',
  revised: '已被修订（原值）',
  'outside-window': '窗口外',
};

/** 冷链时间曲线 + 状态区间：阈值线、可信连接、断联未知、越界、交接标记，点击异常回溯原始读数 */
export default function ColdChainChart({ shipment, analysis }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const { x, y, iw, ih, tempMin, tempMax } = useMemo(() => {
    const temps = analysis.clean.clean
      .filter((c) => !c.issues.includes('outside-window'))
      .map((c) => c.reading.tempC);
    const lo = Math.min(shipment.threshold.minC, ...temps) - 1;
    const hi = Math.max(shipment.threshold.maxC, ...temps) + 1;
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const span = shipment.endAt - shipment.startAt;
    return {
      iw,
      ih,
      tempMin: lo,
      tempMax: hi,
      x: (t: number) => PAD.left + ((t - shipment.startAt) / span) * iw,
      y: (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih,
    };
  }, [analysis, shipment]);

  // 每台设备的可信折线：相邻读数超可信间隔处断开（断联不连线）
  const devicePaths = useMemo(() => {
    return analysis.deviceTraces.map((trace) => {
      const pts = trace.readings.filter(
        (c) => !c.issues.includes('revised'),
      );
      const sub: string[][] = [];
      let cur: string[] = [];
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) {
          const gap = pts[i].reading.sampledAt - pts[i - 1].reading.sampledAt;
          if (gap > shipment.maxCredibleGapMs) {
            sub.push(cur);
            cur = [];
          }
        }
        const r = pts[i].reading;
        cur.push(`${cur.length === 0 ? 'M' : 'L'}${x(r.sampledAt).toFixed(1)},${y(r.tempC).toFixed(1)}`);
      }
      if (cur.length) sub.push(cur);
      return { deviceId: trace.deviceId, paths: sub.map((p) => p.join(' ')) };
    });
  }, [analysis, shipment, x, y]);

  const allReadings = analysis.clean.clean.filter(
    (c) => !c.issues.includes('outside-window'),
  );
  const conflictReadingIds = useMemo(() => {
    const ids = new Set<string>();
    analysis.clean.conflicts.forEach((c) => c.readingIds.forEach((id) => ids.add(id)));
    analysis.clean.overlapConflicts.forEach((c) =>
      c.deviceValues.forEach((v) => ids.add(v.readingId)),
    );
    return ids;
  }, [analysis]);

  const selected = allReadings.filter((c) => selectedIds.includes(c.reading.id));
  const tickEvery = Math.max(1, Math.round(240 / iw) || 1);
  const labelTimes = Array.from(
    new Set([
      ...analysis.deviceTraces.flatMap((t) =>
        t.readings.map((c) => c.reading.sampledAt),
      ),
    ]),
  ).sort((a, b) => a - b);

  return (
    <div>
      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />可信温度曲线（超间隔断开）</span>
        <span><i style={{ background: 'var(--gap)' }} />越界区间</span>
        <span><i style={{ background: '#94a3b8' }} />未知/断联（缺测）</span>
        <span><i style={{ background: 'var(--primary)' }} />阈值 {shipment.threshold.minC}–{shipment.threshold.maxC}℃</span>
        <span>◆ 冲突/异常点（点击回溯原始读数）</span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${shipment.id} 冷链温度核查曲线`}
        style={{ width: '100%', height: 'auto' }}
      >
        <title>{`${shipment.id} 温度曲线与状态区间`}</title>
        <defs>
          <pattern id="unknownHatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="rgba(148,163,184,0.18)" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(100,116,139,0.55)" strokeWidth="2" />
          </pattern>
        </defs>

        {/* 纵向网格与时间刻度 */}
        {labelTimes.map((t, i) =>
          i % tickEvery === 0 ? (
            <g key={`g${t}`}>
              <line x1={x(t)} x2={x(t)} y1={PAD.top} y2={PAD.top + ih} stroke="#eef1f5" />
              <text x={x(t)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={10} fill="#5d6b7a">
                {formatClock(t)}
              </text>
            </g>
          ) : null,
        )}

        {/* 温度刻度 */}
        {Array.from({ length: 5 }, (_, i) => tempMin + ((tempMax - tempMin) / 4) * i).map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#eef1f5" />
            <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="#5d6b7a">{v.toFixed(0)}℃</text>
          </g>
        ))}

        {/* 状态区间背景（正常/越界/未知） */}
        {analysis.segments.map((seg) => {
          const x0 = x(seg.from);
          const x1 = x(Math.max(seg.to, seg.from + 60_000)); // 零长段也给最小可见宽度
          return (
            <rect
              key={seg.id}
              x={x0}
              y={PAD.top}
              width={Math.max(1.5, x1 - x0)}
              height={ih}
              fill={STATUS_FILL[seg.status]}
              stroke={seg.status === 'unknown' ? 'rgba(100,116,139,0.35)' : 'none'}
              strokeDasharray={seg.status === 'unknown' ? '2 2' : undefined}
              className="cold-seg"
              onClick={() => setSelectedIds(seg.sourceReadingIds)}
            >
              <title>
                {`${seg.status}｜${formatClock(seg.from)}–${formatClock(seg.to)}｜来源读数 ${seg.sourceReadingIds.join(', ') || '无'}`}
              </title>
            </rect>
          );
        })}

        {/* 阈值线 */}
        {[shipment.threshold.minC, shipment.threshold.maxC].map((lv) => (
          <g key={lv}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(lv)}
              y2={y(lv)}
              stroke="var(--primary)"
              strokeWidth={1.4}
              strokeDasharray="6 4"
            />
            <text x={W - PAD.right - 2} y={y(lv) - 4} textAnchor="end" fontSize={10} fill="var(--primary)">
              {lv}℃
            </text>
          </g>
        ))}

        {/* 交接标记 */}
        {shipment.handovers.map((h) => (
          <g key={h.id}>
            <line
              x1={x(h.at)}
              x2={x(h.at)}
              y1={PAD.top}
              y2={PAD.top + ih}
              stroke={h.kind === 'sensor-change' ? 'var(--purple)' : 'var(--warn)'}
              strokeWidth={1.6}
            />
            <text x={x(h.at) + 3} y={PAD.top + 12} fontSize={9.5}
              fill={h.kind === 'sensor-change' ? 'var(--purple)' : 'var(--warn)'}>
              {h.kind === 'sensor-change' ? '换传感器' : h.kind === 'vehicle-change' ? '换车' : '开箱'}
            </text>
          </g>
        ))}

        {/* 可信折线（每台设备一种颜色） */}
        {devicePaths.map((d, di) =>
          d.paths.map((dpath, pi) => (
            <path
              key={`${d.deviceId}-${pi}`}
              d={dpath}
              fill="none"
              stroke={di === 0 ? 'var(--ok)' : 'var(--purple)'}
              strokeWidth={2}
            />
          )),
        )}

        {/* 原始读数点 */}
        {allReadings.map((c) => {
          const r = c.reading;
          const isConflict = conflictReadingIds.has(r.id);
          const isRevised = c.issues.includes('revised');
          const cx = x(r.sampledAt);
          const cy = y(r.tempC);
          return (
            <g key={r.id} onClick={() => setSelectedIds([r.id])} style={{ cursor: 'pointer' }}>
              {isConflict ? (
                <path
                  d={`M${cx},${cy - 5} L${cx + 5},${cy} L${cx},${cy + 5} L${cx - 5},${cy} Z`}
                  fill="var(--danger)"
                  stroke="#fff"
                  strokeWidth={1}
                >
                  <title>{`${r.id} 冲突读数 ${r.tempC}℃`}</title>
                </path>
              ) : (
                <circle
                  cx={cx}
                  cy={cy}
                  r={isRevised ? 3 : 3.6}
                  fill={isRevised ? '#94a3b8' : c.issues.includes('revision') ? 'var(--primary)' : 'var(--ok)'}
                  opacity={isRevised ? 0.55 : 1}
                  stroke={selectedIds.includes(r.id) ? 'var(--danger)' : '#fff'}
                  strokeWidth={selectedIds.includes(r.id) ? 2 : 1}
                >
                  <title>{`${r.id}｜${r.deviceId}#${r.seq}｜${r.tempC}℃`}</title>
                </circle>
              )}
            </g>
          );
        })}
      </svg>

      {/* 点击异常回溯到的原始读数 */}
      {selected.length > 0 && (
        <div className="detail-box" style={{ marginTop: 6 }}>
          <strong>原始读数回溯（{selected.length} 条，点击曲线其它区间可切换）</strong>
          <table style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>读数 ID</th>
                <th>设备/序号</th>
                <th>采样时间(UTC)</th>
                <th>平台接收(UTC)</th>
                <th className="num">温度</th>
                <th>标记</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((c) => (
                <tr key={c.reading.id} className={conflictReadingIds.has(c.reading.id) ? 'missing-row' : ''}>
                  <td className="mono">{c.reading.id}</td>
                  <td className="mono">{c.reading.deviceId}#{c.reading.seq}</td>
                  <td className="mono">{formatDateTime(c.reading.sampledAt)}</td>
                  <td className="mono">{formatDateTime(c.reading.receivedAt)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{c.reading.tempC}℃</td>
                  <td>{c.issues.map((i) => ISSUE_LABEL[i] ?? i).join('、') || '正常'}</td>
                  <td className="muted">{c.reading.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
