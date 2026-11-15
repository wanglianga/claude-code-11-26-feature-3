import { addDays, diffDays, isBeforeOrEqual } from './date';
import type {
  BatchTick,
  DayTick,
  ISODate,
  PlannedArrival,
  SimulationResult,
} from './types';

interface LiveBatch {
  batchId: string;
  expiry: ISODate;
  qty: number;
}

export interface SimulateInput {
  siteId: string;
  drugCode: string;
  startDate: ISODate;
  horizonDays: number;
  /** 起始在库批次（已扣除占用后的可用量，由装配层计算） */
  openingBatches: { batchId: string; expiry: ISODate; qtyMin: number }[];
  /** 计划到货（供应商 / 调拨 / 回程） */
  arrivals: PlannedArrival[];
  /** 每日演示消耗（最小单位），缺声明时由调用方决定是否传 0 */
  dailyDemandMin: number;
  /** 调出移除：某日某批次从本站移出（在失效处理之后、到货与消耗之前执行） */
  removals?: { date: ISODate; batchId: string; qtyMin: number; refId: string }[];
}

/**
 * 按日批次库存推演。每日顺序固定：
 *   1) 先移除已到失效时点的余量（记录过期量）
 *   2) 执行调出移除（草稿在计划出库日移出；正式占用已在装配层从期初扣除）
 *   3) 再接收到货（到货当日已失效的批次不入库，计入过期）
 *   4) 按先到期先出（FEFO）消耗，分别记录满足 / 缺货
 * 纯函数，不修改任何输入。
 */
export function simulate(input: SimulateInput): SimulationResult {
  const {
    siteId,
    drugCode,
    startDate,
    horizonDays,
    arrivals,
    dailyDemandMin,
  } = input;

  const live: LiveBatch[] = input.openingBatches
    .filter((b) => b.qtyMin > 0)
    .map((b) => ({ ...b, qty: b.qtyMin }));

  const arrivalsByDate = new Map<ISODate, PlannedArrival[]>();
  for (const a of arrivals) {
    const list = arrivalsByDate.get(a.arriveDate) ?? [];
    list.push(a);
    arrivalsByDate.set(a.arriveDate, list);
  }

  const removalsByDate = new Map<
    ISODate,
    { batchId: string; qtyMin: number; refId: string }[]
  >();
  for (const r of input.removals ?? []) {
    const list = removalsByDate.get(r.date) ?? [];
    list.push(r);
    removalsByDate.set(r.date, list);
  }

  const ticks: DayTick[] = [];
  let totalDemand = 0;
  let totalSatisfied = 0;
  let totalShortage = 0;
  let totalExpired = 0;
  let totalArrival = 0;
  const gapDates: ISODate[] = [];

  for (let i = 0; i < horizonDays; i++) {
    const date = addDays(startDate, i);
    const batchTicks: BatchTick[] = [];
    const record = new Map<string, BatchTick>();
    const openTotal = live.reduce((s, b) => s + b.qty, 0);

    const ensureTick = (b: LiveBatch): BatchTick => {
      let t = record.get(b.batchId);
      if (!t) {
        t = {
          batchId: b.batchId,
          expiry: b.expiry,
          openMin: b.qty,
          expiredMin: 0,
          receivedInMin: 0,
          removedOutMin: 0,
          consumedMin: 0,
          closeMin: 0,
        };
        record.set(b.batchId, t);
        batchTicks.push(t);
      }
      return t;
    };

    // 1) 失效移除：到失效时点的余量不可再用（失效日当天即不可用）
    let expiredToday = 0;
    for (let k = live.length - 1; k >= 0; k--) {
      const b = live[k];
      if (isBeforeOrEqual(b.expiry, date)) {
        const t = ensureTick(b);
        t.expiredMin += b.qty;
        expiredToday += b.qty;
        live.splice(k, 1);
      }
    }

    // 2) 调出移除：在失效处理之后执行（批准未出库与在途的占用已在装配层扣除，
    //    此处处理草稿调拨在计划出库日从来源移出的情形；同一批货不会被二次许诺）
    for (const r of removalsByDate.get(date) ?? []) {
      const b = live.find((x) => x.batchId === r.batchId);
      if (!b || b.qty <= 0) continue;
      const take = Math.min(b.qty, r.qtyMin);
      b.qty -= take;
      ensureTick(b).removedOutMin += take;
    }

    // 3) 接收到货：到货时已失效的批次直接计过期，不进可用库存
    let arrivalToday = 0;
    let arrivalExpired = 0;
    for (const a of arrivalsByDate.get(date) ?? []) {
      if (isBeforeOrEqual(a.batchExpiry, date)) {
        arrivalExpired += a.qtyMin;
        const t: BatchTick = {
          batchId: a.batchId,
          expiry: a.batchExpiry,
          openMin: 0,
          expiredMin: a.qtyMin,
          receivedInMin: 0,
          removedOutMin: 0,
          consumedMin: 0,
          closeMin: 0,
        };
        batchTicks.push(t);
        continue;
      }
      let target = live.find((b) => b.batchId === a.batchId);
      if (!target) {
        target = { batchId: a.batchId, expiry: a.batchExpiry, qty: 0 };
        live.push(target);
      }
      const t = ensureTick(target);
      target.qty += a.qtyMin;
      t.receivedInMin += a.qtyMin;
      arrivalToday += a.qtyMin;
    }
    expiredToday += arrivalExpired;

    // 4) FEFO 消耗：效期早的先出
    let need = dailyDemandMin;
    let satisfied = 0;
    live.sort((x, y) => (x.expiry < y.expiry ? -1 : x.expiry > y.expiry ? 1 : 0));
    for (const b of live) {
      if (need <= 0) break;
      const take = Math.min(b.qty, need);
      if (take > 0) {
        b.qty -= take;
        need -= take;
        satisfied += take;
        ensureTick(b).consumedMin += take;
      }
    }
    const shortage = need;

    for (const b of live) {
      const t = ensureTick(b);
      t.closeMin = b.qty;
    }
    const closeTotal = live.reduce((s, b) => s + b.qty, 0);

    totalDemand += dailyDemandMin;
    totalSatisfied += satisfied;
    totalShortage += shortage;
    totalExpired += expiredToday;
    totalArrival += arrivalToday;
    if (shortage > 0) gapDates.push(date);

    ticks.push({
      date,
      demandMin: dailyDemandMin,
      satisfiedMin: satisfied,
      shortageMin: shortage,
      expiredMin: expiredToday,
      arrivalMin: arrivalToday,
      openTotalMin: openTotal,
      closeTotalMin: closeTotal,
      batches: batchTicks,
    });
  }

  return {
    siteId,
    drugCode,
    ticks,
    totalDemandMin: totalDemand,
    totalSatisfiedMin: totalSatisfied,
    totalShortageMin: totalShortage,
    totalExpiredMin: totalExpired,
    totalArrivalMin: totalArrival,
    firstGapDate: gapDates[0] ?? null,
    gapDates,
  };
}

/** 缺口日剩余未满足量（用于候选数量计算）：取该日 shortageMin */
export function shortageAt(result: SimulationResult, date: ISODate): number {
  return result.ticks.find((t) => t.date === date)?.shortageMin ?? 0;
}

/** 截至某日（含）累计缺货量 */
export function cumulativeShortageThrough(
  result: SimulationResult,
  date: ISODate,
): number {
  return result.ticks
    .filter((t) => t.date <= date)
    .reduce((s, t) => s + t.shortageMin, 0);
}

/** 批次在某天结束时是否仍有余量（用于来源可用性判断的辅助） */
export function batchCloseAt(
  result: SimulationResult,
  batchId: string,
  date: ISODate,
): number {
  const tick = result.ticks.find((t) => t.date === date);
  if (!tick) return 0;
  return (
    tick.batches.find((b) => b.batchId === batchId)?.closeMin ?? 0
  );
}

/** 视窗内某天的日序号（0 起） */
export function dayIndex(start: ISODate, date: ISODate): number {
  return diffDays(start, date);
}
