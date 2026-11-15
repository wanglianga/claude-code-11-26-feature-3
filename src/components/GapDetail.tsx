import type { PairRow } from '../store/selectors';
import type { PackageSpec } from '../domain/types';
import { minUnitOf } from '../domain/units';
import GapChart from './GapChart';

interface Props {
  row: PairRow;
  specs: PackageSpec[];
  drugName: string;
  siteName: string;
}

/** 缺口展开：双情景图表 + 按日批次消耗/失效/到货明细表 */
export default function GapDetail({ row, specs, drugName, siteName }: Props) {
  const unit = minUnitOf(row.drugCode, specs);
  return (
    <div className="detail-box">
      <div style={{ fontWeight: 650, marginBottom: 8 }}>
        {siteName} · {drugName}（{row.drugCode}，单位：{unit}）按日推演明细
      </div>
      <GapChart row={row} specs={specs} />
      <div className="legend" style={{ marginTop: 10 }}>
        <span>每日执行顺序：① 移除已到失效时点余量 → ② 草稿调出移除 → ③ 接收到货 → ④ FEFO 先到期先出消耗</span>
      </div>
      <div className="day-table-wrap">
        <table className="day-table">
          <thead>
            <tr>
              <th>日期</th>
              <th className="num">日初可用</th>
              <th className="num">预计消耗</th>
              <th className="num">满足</th>
              <th className="num">缺货</th>
              <th className="num">失效移除</th>
              <th className="num">到货</th>
              <th className="num">调出</th>
              <th className="num">收盘库存</th>
              <th>批次过程</th>
            </tr>
          </thead>
          <tbody>
            {row.baseline.ticks.map((t) => {
              const removed = t.batches.reduce((s, b) => s + b.removedOutMin, 0);
              const isGap = t.shortageMin > 0;
              return (
                <tr key={t.date} style={isGap ? { background: 'var(--danger-soft)' } : undefined}>
                  <td className="mono">
                    {t.date}
                    {isGap && <span className="badge danger" style={{ marginLeft: 6 }}>缺口</span>}
                  </td>
                  <td className="num">{t.openTotalMin}</td>
                  <td className="num">{t.demandMin}</td>
                  <td className="num ok-text">{t.satisfiedMin}</td>
                  <td className="num danger-text">{t.shortageMin}</td>
                  <td className="num warn-text">{t.expiredMin}</td>
                  <td className="num" style={{ color: 'var(--arrival)' }}>{t.arrivalMin}</td>
                  <td className="num">{removed}</td>
                  <td className="num" style={{ fontWeight: 650 }}>{t.closeTotalMin}</td>
                  <td style={{ minWidth: 320 }}>
                    {t.batches.map((b) => (
                      <div className="batch-line mono" key={`${t.date}-${b.batchId}`}>
                        {b.batchId}（效期 {b.expiry}）：初 {b.openMin}
                        {b.expiredMin > 0 && <span className="warn-text"> / 失效 {b.expiredMin}</span>}
                        {b.receivedInMin > 0 && <span style={{ color: 'var(--arrival)' }}> / 到货 {b.receivedInMin}</span>}
                        {b.removedOutMin > 0 && <span className="muted"> / 调出 {b.removedOutMin}</span>}
                        {b.consumedMin > 0 && <span> / 消耗 {b.consumedMin}</span>}
                        {` → 余 ${b.closeMin}`}
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
