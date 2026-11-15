import { addDays, diffDays } from './date';
import {
  buildSimInput,
  openingBatchesFor,
  transportDays,
  type PlanningData,
} from './projection';
import { batchCloseAt, simulate } from './simulate';
import type {
  AllocationCandidate,
  CandidateLine,
  InfeasibleNote,
  ISODate,
  Site,
  SimulationResult,
} from './types';

export interface CandidateGenerationResult {
  candidates: AllocationCandidate[];
  infeasible: {
    siteId: string;
    drugCode: string;
    gapDate: ISODate;
    notes: InfeasibleNote[];
  }[];
}

export interface Selection {
  siteIds: string[];
  startDate: ISODate;
  horizonDays: number;
}

/** 视窗内某批次在来源基线推演中的过期量（不动用情况下的报废） */
function batchExpiryInWindow(
  sim: SimulationResult,
  batchId: string,
): number {
  return sim.ticks.reduce(
    (s, t) =>
      s + (t.batches.find((b) => b.batchId === batchId)?.expiredMin ?? 0),
    0,
  );
}

/**
 * 调拨候选生成（纯函数，试算不修改正式库存）：
 * 1. 缺口按「声明保障优先级 → 缺口日期」排序逐次处理；
 * 2. 来源必须显式允许调出（allowAsSource）且具备已声明需求资料，缺资料不能自动当富余仓；
 * 3. 批次仅当到货日未失效且满足接收点最低剩余效期时才可成为候选
 *    （不能用出库时尚有效代替到货可用）；
 * 4. 最晚到货 = 首个缺口日，路线来不及即不可行；
 * 5. 扣除真实来源余量（含既有草稿/批准占用），同一批货不二次许诺；
 * 6. 未来库存已足够的缺口不再分配；只报可行建议，不宣称最优。
 */
export function generateCandidates(
  data: PlanningData,
  sites: Site[],
  selection: Selection,
): CandidateGenerationResult {
  const { startDate, horizonDays, siteIds } = selection;
  const siteMap = new Map(sites.map((s) => [s.id, s]));

  // 草稿占用台账：批准未出库已在 openingBatchesFor 中扣除、在途已移出正式库存，
  // 此处只登记草稿与本轮新选候选，避免同一批货被两次许诺或重复扣减。
  // 同一批次可在不同站点各有库存行，键必须含站点。
  const ledger = new Map<string, number>();
  const ledgerKey = (siteId: string, batchId: string) => `${siteId}__${batchId}`;
  const bump = (siteId: string, batchId: string, qty: number) =>
    ledger.set(ledgerKey(siteId, batchId), (ledger.get(ledgerKey(siteId, batchId)) ?? 0) + qty);
  for (const t of data.transfers) {
    if (t.status !== 'draft' || t.invalid) continue;
    for (const line of t.lines) bump(t.fromSiteId, line.batchId, line.qtyApprovedMin);
  }

  // 接收点缺口：以含草稿推演为准，已被草稿覆盖的缺口不再重复分配
  const drugSet = new Set(data.demands.map((d) => d.drugCode));
  const gaps: {
    siteId: string;
    drugCode: string;
    sim: SimulationResult;
    firstGap: ISODate;
    totalShortage: number;
  }[] = [];
  for (const siteId of siteIds) {
    for (const drugCode of drugSet) {
      const declared = data.demands.some(
        (d) => d.siteId === siteId && d.drugCode === drugCode,
      );
      if (!declared) continue; // 缺需求资料不参与缺口分析
      const sim = simulate(
        buildSimInput(
          data,
          siteId,
          drugCode,
          startDate,
          horizonDays,
          'withDrafts',
        ),
      );
      if (sim.totalShortageMin <= 0 || !sim.firstGapDate) continue;
      gaps.push({
        siteId,
        drugCode,
        sim,
        firstGap: sim.firstGapDate,
        totalShortage: sim.totalShortageMin,
      });
    }
  }
  gaps.sort((a, b) => {
    const pa = siteMap.get(a.siteId)?.priority ?? 999;
    const pb = siteMap.get(b.siteId)?.priority ?? 999;
    return (
      pa - pb || (a.firstGap < b.firstGap ? -1 : a.firstGap > b.firstGap ? 1 : 0)
    );
  });

  const candidates: AllocationCandidate[] = [];
  const infeasible: CandidateGenerationResult['infeasible'] = [];

  for (const gap of gaps) {
    const target = siteMap.get(gap.siteId);
    const minRemaining = target?.minRemainingDays ?? 0;
    const latestArrive = gap.firstGap;
    const notes: InfeasibleNote[] = [];
    let filled = 0; // 本缺口已由候选覆盖的量

    for (const src of sites.filter((x) => siteIds.includes(x.id))) {
      if (filled >= gap.totalShortage) break;
      if (src.id === gap.siteId) continue;
      // 来源资格：显式允许调出 + 已声明需求资料
      if (!src.allowAsSource || !src.demandDeclared) continue;
      const sourceDemand = data.demands.find(
        (d) => d.siteId === src.id && d.drugCode === gap.drugCode,
      );
      if (!sourceDemand) continue;
      const route = transportDays(data, src.id, gap.siteId);
      if (route === null) {
        notes.push({
          reason: '无运输路线资料',
          detail: `${src.id} → ${gap.siteId} 未声明运输时间，无法承诺到货日`,
        });
        continue;
      }

      const plannedShipDate = startDate;
      const arriveDate = addDays(plannedShipDate, route);
      const sourceSim = simulate(
        buildSimInput(
          data,
          src.id,
          gap.drugCode,
          startDate,
          horizonDays,
          'baseline',
        ),
      );

      if (arriveDate > latestArrive) {
        notes.push({
          reason: '有货但来不及',
          detail: `来源 ${src.id} 运输 ${route} 天，预计 ${arriveDate} 到货，晚于最晚到货日 ${latestArrive}`,
        });
        continue;
      }

      const shipEve = addDays(plannedShipDate, -1);
      const opening = openingBatchesFor(data, src.id, gap.drugCode);
      // 出库日即视窗首日时，出库日前一天落在视窗外，直接按期初可用量取值
      const freeAtShipOf = (batchId: string): number => {
        if (shipEve < startDate) {
          return opening.find((o) => o.batchId === batchId)?.qtyMin ?? 0;
        }
        return batchCloseAt(sourceSim, batchId, shipEve);
      };
      const eligible: CandidateLine[] = [];
      const perBatchReject: string[] = [];
      let sourceFreeBefore = 0;
      for (const ob of opening) {
        const freeAtShip = freeAtShipOf(ob.batchId);
        const committed = ledger.get(ledgerKey(src.id, ob.batchId)) ?? 0;
        const free = freeAtShip - committed;
        if (free <= 0) continue;
        sourceFreeBefore += free;
        if (ob.expiry <= arriveDate) {
          perBatchReject.push(
            `批次 ${ob.batchId} 到货日 ${arriveDate} 已失效（效期 ${ob.expiry}），不能用出库时尚有效代替到货可用`,
          );
          continue;
        }
        const remainingAtArrive = diffDays(arriveDate, ob.expiry);
        if (remainingAtArrive < minRemaining) {
          perBatchReject.push(
            `批次 ${ob.batchId} 到货时剩余效期 ${remainingAtArrive} 天，低于接收点要求 ${minRemaining} 天`,
          );
          continue;
        }
        eligible.push({ batchId: ob.batchId, expiry: ob.expiry, qtyMin: free });
      }
      if (eligible.length === 0) {
        notes.push({
          reason: '无合格批次',
          detail:
            perBatchReject.length > 0
              ? perBatchReject.join('；')
              : '来源在出库日前无可用余量（已扣除批准/在途/草稿占用）',
        });
        continue;
      }

      // FEFO 分配，封顶到剩余缺口，避免过度调拨与重复申请
      eligible.sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
      let need = gap.totalShortage - filled;
      const lines: CandidateLine[] = [];
      for (const e of eligible) {
        if (need <= 0) break;
        const take = Math.min(e.qtyMin, need);
        need -= take;
        lines.push({ ...e, qtyMin: take });
      }
      const qty = lines.reduce((s, l) => s + l.qtyMin, 0);
      if (qty <= 0) continue;

      // 占用台账立即扣除，后续候选不能重复许诺同一批货
      for (const l of lines) bump(src.id, l.batchId, l.qtyMin);

      // 来源送出后复算：新增缺口必须展示
      const afterSim = simulate({
        ...buildSimInput(
          data,
          src.id,
          gap.drugCode,
          startDate,
          horizonDays,
          'baseline',
        ),
        removals: lines.map((l) => ({
          date: plannedShipDate,
          batchId: l.batchId,
          qtyMin: l.qtyMin,
          refId: 'candidate',
        })),
      });

      const wasteRisk = lines.reduce(
        (s, l) =>
          s + Math.min(batchExpiryInWindow(sourceSim, l.batchId), l.qtyMin),
        0,
      );

      candidates.push({
        id: `CAND-${src.id}-${gap.siteId}-${gap.drugCode}`,
        drugCode: gap.drugCode,
        fromSiteId: src.id,
        toSiteId: gap.siteId,
        gapDate: gap.firstGap,
        latestArriveDate: latestArrive,
        plannedShipDate,
        arriveDate,
        lines,
        qtyMin: qty,
        sourceReserveMin: sourceSim.totalDemandMin,
        sourceFreeBeforeMin: sourceFreeBefore,
        transportCost: qty * route,
        wasteRiskMin: wasteRisk,
        sourceNewGapDate: afterSim.firstGapDate,
        sourceNewShortageMin: Math.max(
          0,
          afterSim.totalShortageMin - sourceSim.totalShortageMin,
        ),
        reasons: [
          `接收点 ${gap.siteId} 首个缺口日 ${gap.firstGap}，最晚到货 ${latestArrive}`,
          `来源 ${src.id} 同范围保留需求 ${sourceSim.totalDemandMin}，可用余量经按日 FEFO 推演取得`,
          `候选批次均满足到货未失效且剩余效期 ≥ ${minRemaining} 天`,
        ],
      });
      filled += qty;
    }

    if (candidates.filter((c) => c.toSiteId === gap.siteId && c.drugCode === gap.drugCode).length === 0) {
      infeasible.push({
        siteId: gap.siteId,
        drugCode: gap.drugCode,
        gapDate: gap.firstGap,
        notes:
          notes.length > 0
            ? notes
            : [
                {
                  reason: '无可行来源',
                  detail: '没有同时满足路线、需求资料与效期要求的来源点',
                },
              ],
      });
    }
  }

  // 方案排序：覆盖高优先级缺口为先（生成顺序已保证），再比较报废与运输成本；
  // 只报可行建议，不宣称最优
  candidates.sort((a, b) => {
    const pa = siteMap.get(a.toSiteId)?.priority ?? 999;
    const pb = siteMap.get(b.toSiteId)?.priority ?? 999;
    return (
      pa - pb ||
      (a.gapDate < b.gapDate ? -1 : a.gapDate > b.gapDate ? 1 : 0) ||
      b.wasteRiskMin - a.wasteRiskMin ||
      a.transportCost - b.transportCost
    );
  });

  return { candidates, infeasible };
}
