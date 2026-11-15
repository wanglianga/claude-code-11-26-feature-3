import { simulatePair } from '../domain/projection';
import type {
  AllocationCandidate,
  ISODate,
  SimulationResult,
} from '../domain/types';
import type { PlanningData } from '../domain/projection';

export interface PairRow {
  siteId: string;
  drugCode: string;
  baseline: SimulationResult;
  withDrafts: SimulationResult;
  declared: boolean;
}

export interface Selection {
  siteIds: string[];
  startDate: ISODate;
  horizonDays: number;
}

/** 对所有选中点位 × 已声明药品计算双情景推演 */
export function computePairs(data: PlanningData, sel: Selection): PairRow[] {
  const rows: PairRow[] = [];
  const drugCodes = [...new Set(data.demands.map((d) => d.drugCode))];
  for (const siteId of sel.siteIds) {
    for (const drugCode of drugCodes) {
      const declared = data.demands.some(
        (d) => d.siteId === siteId && d.drugCode === drugCode,
      );
      if (!declared) continue;
      const pair = simulatePair(
        data,
        siteId,
        drugCode,
        sel.startDate,
        sel.horizonDays,
      );
      rows.push({ siteId, drugCode, ...pair, declared });
    }
  }
  return rows;
}

export interface GapSummary {
  row: PairRow;
  gapCount: number;
  firstGap: ISODate | null;
  baselineShortage: number;
  draftShortage: number;
  baselineExpired: number;
  draftExpired: number;
  improved: boolean;
}

export function summarizeGap(row: PairRow): GapSummary {
  return {
    row,
    gapCount: row.baseline.gapDates.length,
    firstGap: row.baseline.firstGapDate,
    baselineShortage: row.baseline.totalShortageMin,
    draftShortage: row.withDrafts.totalShortageMin,
    baselineExpired: row.baseline.totalExpiredMin,
    draftExpired: row.withDrafts.totalExpiredMin,
    improved:
      row.withDrafts.totalShortageMin < row.baseline.totalShortageMin,
  };
}

export function candidateKey(c: AllocationCandidate): string {
  return `${c.fromSiteId}->${c.toSiteId}__${c.drugCode}__${c.gapDate}`;
}

/** 双情景每日收盘库存序列（供图表） */
export function closeSeries(row: PairRow): {
  dates: ISODate[];
  baseline: number[];
  withDrafts: number[];
  shortages: number[];
  expired: number[];
  arrivals: number[];
} {
  return {
    dates: row.baseline.ticks.map((t) => t.date),
    baseline: row.baseline.ticks.map((t) => t.closeTotalMin),
    withDrafts: row.withDrafts.ticks.map((t) => t.closeTotalMin),
    shortages: row.baseline.ticks.map((t) => t.shortageMin),
    expired: row.baseline.ticks.map((t) => t.expiredMin),
    arrivals: row.baseline.ticks.map((t) => t.arrivalMin),
  };
}
