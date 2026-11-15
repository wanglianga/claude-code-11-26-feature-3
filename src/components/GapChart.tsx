import { useMemo, useState } from 'react';
import type { PairRow } from '../store/selectors';
import { closeSeries } from '../store/selectors';
import { minUnitOf } from '../domain/units';
import type { PackageSpec } from '../domain/types';

interface Props {
  row: PairRow;
  specs: PackageSpec[];
}

const W = 760;
const H = 240;
const PAD = { top: 18, right: 16, bottom: 42, left: 52 };

/** 自研 SVG 双情景折线图：基线 vs 含草稿，标记缺口/失效/到货事件 */
export default function GapChart({ row, specs }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => closeSeries(row), [row]);
  const unit = minUnitOf(row.drugCode, specs);

  const n = series.dates.length;
  const maxY = Math.max(
    1,
    ...series.baseline,
    ...series.withDrafts,
    ...series.arrivals,
    ...series.expired,
  );
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / maxY) * ih;

  const path = (vals: number[]) =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const yTicks = 4;
  const tickVals = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round((maxY / yTicks) * i),
  );
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  const hoverTick = hover !== null ? row.baseline.ticks[hover] : null;

  return (
    <div>
      <div className="legend">
        <span><i style={{ background: 'var(--baseline)' }} />未调拨基线（收盘库存）</span>
        <span><i style={{ background: 'var(--drafts)' }} />含草稿调拨（收盘库存）</span>
        <span><i style={{ background: 'var(--gap)' }} />缺货日</span>
        <span><i style={{ background: 'var(--expiry)' }} />失效</span>
        <span><i style={{ background: 'var(--arrival)' }} />到货</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${row.siteId} ${row.drugCode} 双情景库存推演图`}
        style={{ width: '100%', height: 'auto' }}
        onMouseLeave={() => setHover(null)}
      >
        <title>{`${row.siteId} / ${row.drugCode} 基线与含草稿库存对比（单位：${unit}）`}</title>
        <desc>灰色折线为未调拨基线，蓝色折线为加入草稿后的收盘库存；红块为缺货日，琥珀三角为失效，绿色菱形为到货。</desc>

        {tickVals.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="#e6eaf0" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="#5d6b7a">{v}</text>
          </g>
        ))}

        {series.dates.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d} x={x(i)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={9.5} fill="#5d6b7a">
              {d.slice(5)}
            </text>
          ) : null,
        )}

        {/* 缺货日红块 */}
        {row.baseline.ticks.map((t, i) =>
          t.shortageMin > 0 ? (
            <rect
              key={`gap-${i}`}
              x={x(i) - iw / n / 2}
              y={PAD.top}
              width={Math.max(2, iw / n)}
              height={ih}
              fill="var(--gap)"
              opacity={0.08}
            />
          ) : null,
        )}

        <path d={path(series.baseline)} fill="none" stroke="var(--baseline)" strokeWidth={2} />
        <path d={path(series.withDrafts)} fill="none" stroke="var(--drafts)" strokeWidth={2.2} />

        {row.baseline.ticks.map((t, i) => {
          const markers: JSX.Element[] = [];
          if (t.arrivalMin > 0)
            markers.push(
              <path
                key={`arr-${i}`}
                d={`M${x(i)},${y(t.closeTotalMin) - 7} l4,7 l-8,0 z`}
                fill="var(--arrival)"
              />,
            );
          if (t.expiredMin > 0)
            markers.push(
              <path
                key={`exp-${i}`}
                d={`M${x(i) - 4},${PAD.top + 4} L${x(i) + 4},${PAD.top + 4} L${x(i)},${PAD.top + 11} z`}
                fill="var(--expiry)"
              />,
            );
          return markers;
        })}

        {/* 悬停十字线 */}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="#94a3b8" strokeDasharray="3 3" />
        )}

        {/* 命中区 */}
        {series.dates.map((_, i) => (
          <rect
            key={`hit-${i}`}
            x={x(i) - iw / n / 2}
            y={PAD.top}
            width={iw / n}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>

      {hoverTick && (
        <div className="detail-box" style={{ marginTop: 4 }}>
          <strong>{hoverTick.date}</strong>
          <div className="kpi-row" style={{ marginTop: 6, marginBottom: 0 }}>
            <div className="kpi"><div className="l">日需求</div><div className="v">{hoverTick.demandMin}</div></div>
            <div className="kpi"><div className="l">满足</div><div className="v ok-text">{hoverTick.satisfiedMin}</div></div>
            <div className="kpi"><div className="l">缺货</div><div className="v danger-text">{hoverTick.shortageMin}</div></div>
            <div className="kpi"><div className="l">失效</div><div className="v warn-text">{hoverTick.expiredMin}</div></div>
            <div className="kpi"><div className="l">到货</div><div className="v" style={{ color: 'var(--arrival)' }}>{hoverTick.arrivalMin}</div></div>
            <div className="kpi"><div className="l">基线收盘</div><div className="v">{series.baseline[hover!]}</div></div>
            <div className="kpi"><div className="l">含草稿收盘</div><div className="v" style={{ color: 'var(--drafts)' }}>{series.withDrafts[hover!]}</div></div>
          </div>
        </div>
      )}
    </div>
  );
}
