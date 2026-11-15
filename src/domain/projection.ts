import { addDays, isBeforeOrEqual } from './date';
import { simulate, type SimulateInput } from './simulate';
import type {
  Batch,
  DemandDeclaration,
  GapKey,
  ISODate,
  PlannedArrival,
  ScheduledInbound,
  SimulationResult,
  TransferOrder,
} from './types';

export interface TransportMatrix {
  /** key: `${fromSiteId}->${toSiteId}`，运输天数 */
  [routeKey: string]: number;
}

export function routeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export interface PlanningData {
  batches: Batch[];
  demands: DemandDeclaration[];
  inbounds: ScheduledInbound[];
  transfers: TransferOrder[];
  transport: TransportMatrix;
}

export type PlanMode = 'baseline' | 'withDrafts';

const ACTIVE_TRANSFER: ReadonlySet<TransferOrder['status']> = new Set([
  'draft',
  'approved',
  'shipped',
  'partially_received',
]);

function activeTransfers(transfers: TransferOrder[]): TransferOrder[] {
  return transfers.filter(
    (t) => ACTIVE_TRANSFER.has(t.status) && !t.invalid,
  );
}

/** 已批准未出库的来源占用（按批次） */
function approvedOccupancy(
  transfers: TransferOrder[],
  siteId: string,
  drugCode: string,
): Map<string, number> {
  const occ = new Map<string, number>();
  for (const t of activeTransfers(transfers)) {
    if (t.fromSiteId !== siteId || t.drugCode !== drugCode) continue;
    if (t.status !== 'approved') continue; // 在途已在出库时扣过正式库存
    for (const line of t.lines) {
      if (line.drugCode !== drugCode) continue;
      occ.set(
        line.batchId,
        (occ.get(line.batchId) ?? 0) + line.qtyApprovedMin,
      );
    }
  }
  return occ;
}

/** 正式在库批次扣除批准占用后的期初可用（试算不修改正式库存） */
export function openingBatchesFor(
  data: PlanningData,
  siteId: string,
  drugCode: string,
): { batchId: string; expiry: ISODate; qtyMin: number }[] {
  const occ = approvedOccupancy(data.transfers, siteId, drugCode);
  return data.batches
    .filter((b) => b.siteId === siteId && b.drugCode === drugCode && b.qtyMin > 0)
    .map((b) => ({
      batchId: b.id,
      expiry: b.expiry,
      qtyMin: Math.max(0, b.qtyMin - (occ.get(b.id) ?? 0)),
    }))
    .filter((b) => b.qtyMin > 0);
}

/** 供应商计划到货（视窗内） */
function supplierArrivals(
  data: PlanningData,
  siteId: string,
  drugCode: string,
  start: ISODate,
  end: ISODate,
): PlannedArrival[] {
  return data.inbounds
    .filter(
      (i) =>
        i.siteId === siteId &&
        i.drugCode === drugCode &&
        isBeforeOrEqual(start, i.arriveDate) &&
        isBeforeOrEqual(i.arriveDate, end),
    )
    .map((i) => ({
      key: `inbound:${i.id}`,
      batchId: i.batchId,
      batchExpiry: i.batchExpiry,
      qtyMin: i.qtyMin,
      arriveDate: i.arriveDate,
      kind: 'supplier' as const,
      refId: i.id,
    }));
}

/** 调拨到货：正式在途两种模式都计入；草稿仅 withDrafts 计入 */
function transferArrivals(
  data: PlanningData,
  siteId: string,
  drugCode: string,
  start: ISODate,
  end: ISODate,
  mode: PlanMode,
): PlannedArrival[] {
  const out: PlannedArrival[] = [];
  for (const t of activeTransfers(data.transfers)) {
    if (t.toSiteId !== siteId || t.drugCode !== drugCode) continue;
    if (t.status === 'draft' && mode === 'baseline') continue;
    if (t.status === 'approved') continue; // 批准未出库：尚不是接收点未来库存
    if (!isBeforeOrEqual(start, t.arriveDate) || !isBeforeOrEqual(t.arriveDate, end))
      continue;
    for (const line of t.lines) {
      // 已部分签收：只把尚未结清的余量作为在途到货
      const settled =
        line.receivedMin + line.damagedMin + line.quarantineMin;
      const remaining = line.qtyApprovedMin - settled;
      if (remaining <= 0) continue;
      out.push({
        key: `transfer:${t.id}:${line.batchId}`,
        batchId: line.batchId,
        batchExpiry: line.expiry,
        qtyMin: remaining,
        arriveDate: t.arriveDate,
        kind: 'transfer',
        refId: t.id,
      });
    }
  }
  return out;
}

/** 回程到货（已发退回） */
function returnArrivals(
  data: PlanningData,
  siteId: string,
  drugCode: string,
  start: ISODate,
  end: ISODate,
): PlannedArrival[] {
  const out: PlannedArrival[] = [];
  for (const t of activeTransfers(data.transfers)) {
    if (t.fromSiteId !== siteId || t.drugCode !== drugCode) continue;
    for (const r of t.returns) {
      if (r.received) continue;
      if (!isBeforeOrEqual(start, r.arriveDate) || !isBeforeOrEqual(r.arriveDate, end))
        continue;
      const expiry =
        data.batches.find((b) => b.id === r.batchId)?.expiry ?? r.arriveDate;
      out.push({
        key: `return:${r.id}`,
        batchId: r.batchId,
        batchExpiry: expiry,
        qtyMin: r.qtyMin,
        arriveDate: r.arriveDate,
        kind: 'return',
        refId: r.id,
      });
    }
  }
  return out;
}

/** 草稿在计划出库日从来源移出（仅 withDrafts） */
function draftRemovals(
  data: PlanningData,
  siteId: string,
  drugCode: string,
  mode: PlanMode,
): SimulateInput['removals'] {
  if (mode === 'baseline') return [];
  const out: NonNullable<SimulateInput['removals']> = [];
  for (const t of activeTransfers(data.transfers)) {
    if (t.status !== 'draft') continue;
    if (t.fromSiteId !== siteId || t.drugCode !== drugCode) continue;
    for (const line of t.lines) {
      out.push({
        date: t.plannedShipDate,
        batchId: line.batchId,
        qtyMin: line.qtyApprovedMin,
        refId: t.id,
      });
    }
  }
  return out;
}

export function buildSimInput(
  data: PlanningData,
  siteId: string,
  drugCode: string,
  startDate: ISODate,
  horizonDays: number,
  mode: PlanMode,
): SimulateInput {
  const end = addDays(startDate, horizonDays - 1);
  const demand =
    data.demands.find((d) => d.siteId === siteId && d.drugCode === drugCode)
      ?.dailyMin ?? 0;
  const arrivals = [
    ...supplierArrivals(data, siteId, drugCode, startDate, end),
    ...transferArrivals(data, siteId, drugCode, startDate, end, mode),
    ...returnArrivals(data, siteId, drugCode, startDate, end),
  ];
  return {
    siteId,
    drugCode,
    startDate,
    horizonDays,
    openingBatches: openingBatchesFor(data, siteId, drugCode),
    arrivals,
    dailyDemandMin: demand,
    removals: draftRemovals(data, siteId, drugCode, mode),
  };
}

export function simulatePair(
  data: PlanningData,
  siteId: string,
  drugCode: string,
  startDate: ISODate,
  horizonDays: number,
): { baseline: SimulationResult; withDrafts: SimulationResult } {
  return {
    baseline: simulate(
      buildSimInput(data, siteId, drugCode, startDate, horizonDays, 'baseline'),
    ),
    withDrafts: simulate(
      buildSimInput(data, siteId, drugCode, startDate, horizonDays, 'withDrafts'),
    ),
  };
}

export function gapKey(siteId: string, drugCode: string): GapKey {
  return { siteId, drugCode };
}

export function gapKeyStr(k: GapKey): string {
  return `${k.siteId}__${k.drugCode}`;
}

/** 运输天数，无路线资料返回 null */
export function transportDays(
  data: PlanningData,
  from: string,
  to: string,
): number | null {
  const v = data.transport[routeKey(from, to)];
  return typeof v === 'number' ? v : null;
}
