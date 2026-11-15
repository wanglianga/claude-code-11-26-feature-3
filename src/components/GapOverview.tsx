import { Fragment, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { computePairs, summarizeGap, type PairRow } from '../store/selectors';
import GapDetail from './GapDetail';
import { formatQty } from '../domain/units';

export default function GapOverview() {
  const sites = useStore((s) => s.sites);
  const drugs = useStore((s) => s.drugs);
  const packageSpecs = useStore((s) => s.packageSpecs);
  const startDate = useStore((s) => s.startDate);
  const horizonDays = useStore((s) => s.horizonDays);
  const selectedSiteIds = useStore((s) => s.selectedSiteIds);
  const batches = useStore((s) => s.batches);
  const transfers = useStore((s) => s.transfers);
  const expandedKeys = useStore((s) => s.expandedKeys);
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const planningData = useStore((s) => s.planningData);

  const rows = useMemo(
    () =>
      computePairs(planningData(), {
        siteIds: selectedSiteIds,
        startDate,
        horizonDays,
        // 正式库存与调拨台账变化即重算（试算不修改正式库存，草稿变化经 transfers 体现）
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [batches, transfers, startDate, horizonDays, selectedSiteIds],
  );

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const drugName = (code: string) => drugs.find((d) => d.code === code)?.name ?? code;
  const summaries = rows.map(summarizeGap);
  const withGap = summaries.filter((g) => g.row.baseline.totalShortageMin > 0);

  return (
    <section className="panel">
      <h2>
        保障缺口总览
        <span className="hint">
          灰色列为未调拨基线，蓝色列为加入草稿后；点击行展开当日可用量、预计消耗、失效与到货的逐批明细
        </span>
      </h2>
      {withGap.length === 0 ? (
        <div className="notice info">所选点位在保障天数内未推演到缺货。</div>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>点位 / 药品</th>
                <th className="num">首缺口日</th>
                <th className="num">缺口天数</th>
                <th className="num">基线缺货（最小单位）</th>
                <th className="num">含草稿缺货</th>
                <th className="num">基线过期</th>
                <th className="num">含草稿过期</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {withGap.map((g) => {
                const key = `${g.row.siteId}__${g.row.drugCode}`;
                const open = expandedKeys.has(key);
                return (
                  <Fragment key={key}>
                    <tr className="clickable" onClick={() => toggleExpanded(key)}>
                      <td>
                        <strong>{siteName(g.row.siteId)}</strong>
                        <div className="muted">
                          {drugName(g.row.drugCode)} · {g.row.drugCode}
                        </div>
                      </td>
                      <td className="num danger-text mono">{g.firstGap ?? '—'}</td>
                      <td className="num">{g.gapCount}</td>
                      <td className="num danger-text">{g.baselineShortage}</td>
                      <td className="num" style={{ color: 'var(--drafts)' }}>
                        {g.draftShortage}
                        {g.improved && (
                          <div className="ok-text" style={{ fontSize: 11 }}>
                            ↓ {g.row.baseline.totalShortageMin - g.row.withDrafts.totalShortageMin}
                          </div>
                        )}
                      </td>
                      <td className="num warn-text">{g.baselineExpired}</td>
                      <td className="num warn-text">{g.draftExpired}</td>
                      <td>
                        {g.improved ? (
                          <span className="badge ok">草稿已缓解</span>
                        ) : (
                          <span className="badge danger">未调拨缺口</span>
                        )}
                        <span className="badge muted" style={{ marginLeft: 6 }}>
                          {open ? '收起 ▲' : '展开 ▼'}
                        </span>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={8}>
                          <GapDetail
                            row={g.row as PairRow}
                            specs={packageSpecs}
                            drugName={drugName(g.row.drugCode)}
                            siteName={siteName(g.row.siteId)}
                          />
                          <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                            数量口径：{formatQty(g.row.drugCode, g.baselineShortage, packageSpecs)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
