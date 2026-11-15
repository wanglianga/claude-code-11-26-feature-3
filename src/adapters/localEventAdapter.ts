import { addDays } from '../domain/date';
import type {
  Batch,
  DomainEvent,
  RejectedEvent,
  TransferOrder,
} from '../domain/types';

/**
 * 本地事件适配器：在浏览器内模拟审批 / 出库 / 签收 / 取消 / 回程 / 盘点交互，
 * 不连接任何真实医疗系统。所有迁移为纯函数：成功返回新状态，失败整组退回并给出原因。
 * 重复事件按事件 id 幂等忽略；乱序签收不会生成双份库存。
 */
export interface AdapterState {
  batches: Batch[];
  transfers: TransferOrder[];
  events: DomainEvent[];
}

export interface AdapterResult {
  state: AdapterState;
  rejected: RejectedEvent[];
}

const ok = (state: AdapterState): AdapterResult => ({ state, rejected: [] });
const fail = (state: AdapterState, eventId: string, reason: string): AdapterResult => ({
  state,
  rejected: [{ eventId, reason }],
});

function clone(state: AdapterState): AdapterState {
  return {
    batches: state.batches.map((b) => ({ ...b })),
    transfers: state.transfers.map((t) => ({
      ...t,
      lines: t.lines.map((l) => ({ ...l })),
      returns: t.returns.map((r) => ({ ...r })),
    })),
    events: [...state.events],
  };
}

/** 已批准未出库对批次的占用（不含指定单据自身）。同批次可跨站点存在，键含站点 */
function approvedOccupancy(
  transfers: TransferOrder[],
  excludeId?: string,
): Map<string, number> {
  const occ = new Map<string, number>();
  for (const t of transfers) {
    if (t.status !== 'approved' || t.id === excludeId || t.invalid) continue;
    for (const line of t.lines) {
      const key = `${t.fromSiteId}__${line.batchId}`;
      occ.set(key, (occ.get(key) ?? 0) + line.qtyApprovedMin);
    }
  }
  return occ;
}

function adjustBatch(
  batches: Batch[],
  siteId: string,
  batchId: string,
  drugCode: string,
  expiry: string,
  delta: number,
): Batch[] {
  const idx = batches.findIndex((b) => b.id === batchId && b.siteId === siteId);
  if (idx >= 0) {
    const next = [...batches];
    next[idx] = { ...next[idx], qtyMin: Math.max(0, next[idx].qtyMin + delta) };
    return next;
  }
  if (delta <= 0) return batches;
  // 同批次在接收点不存在时建立库存行（效期随行携带）
  return [
    ...batches,
    { id: batchId, drugCode, siteId, expiry, qtyMin: delta },
  ];
}

function applyConfirmed(s: AdapterState, ev: Extract<DomainEvent, { type: 'transfer.confirmed' }>): AdapterResult {
  const next = clone(s);
  const byId = new Map(next.transfers.map((t) => [t.id, t]));
  // 整组预检：任一单据不是草稿或库存不足，全部退回
  const occ = approvedOccupancy(next.transfers);
  for (const order of ev.orders) {
    const cur = byId.get(order.id);
    if (!cur) return fail(s, ev.id, `调拨单 ${order.id} 不存在`);
    if (cur.status !== 'draft') {
      return fail(s, ev.id, `调拨单 ${order.id} 状态为 ${cur.status}，仅草稿可提交审批确认`);
    }
    for (const line of order.lines) {
      const formal = next.batches.find(
        (b) => b.id === line.batchId && b.siteId === cur.fromSiteId,
      );
      const occKey = `${cur.fromSiteId}__${line.batchId}`;
      const available = (formal?.qtyMin ?? 0) - (occ.get(occKey) ?? 0);
      if (line.qtyApprovedMin > available) {
        return fail(
          s,
          ev.id,
          `调拨单 ${order.id} 批次 ${line.batchId} 需 ${line.qtyApprovedMin}，扣除其他批准占用后仅余 ${Math.max(0, available)}，整组退回`,
        );
      }
      occ.set(occKey, (occ.get(occKey) ?? 0) + line.qtyApprovedMin);
    }
  }
  const ids = new Set(ev.orders.map((o) => o.id));
  next.transfers = next.transfers.map((t) =>
    ids.has(t.id) ? { ...t, status: 'approved' as const, conflictReason: undefined } : t,
  );
  next.events.push(ev);
  return ok(next);
}

function applyShipped(s: AdapterState, ev: Extract<DomainEvent, { type: 'transfer.shipped' }>): AdapterResult {
  const order = s.transfers.find((t) => t.id === ev.transferId);
  if (!order) return fail(s, ev.id, `调拨单 ${ev.transferId} 不存在`);
  if (order.status === 'shipped' || order.status === 'partially_received') {
    return ok(s); // 重复出库事件幂等忽略，不第二次扣来源余额
  }
  if (order.status !== 'approved') {
    return fail(s, ev.id, `调拨单 ${ev.transferId} 状态为 ${order.status}，须先批准才能出库`);
  }
  const next = clone(s);
  const target = next.transfers.find((t) => t.id === ev.transferId)!;
  let batches = next.batches;
  for (const line of target.lines) {
    const formal = batches.find((b) => b.id === line.batchId && b.siteId === target.fromSiteId);
    if (!formal || formal.qtyMin < line.qtyApprovedMin) {
      return fail(
        s,
        ev.id,
        `出库失败：来源批次 ${line.batchId} 正式库存不足（需 ${line.qtyApprovedMin}，实有 ${formal?.qtyMin ?? 0}）`,
      );
    }
  }
  for (const line of target.lines) {
    // 出库将批准占用转为在途，只扣一次来源余额
    batches = adjustBatch(
      batches,
      target.fromSiteId,
      line.batchId,
      line.drugCode,
      line.expiry,
      -line.qtyApprovedMin,
    );
  }
  target.status = 'shipped';
  target.shipDate = ev.shipDate;
  next.batches = batches;
  next.events.push(ev);
  return ok(next);
}

function applyReceived(s: AdapterState, ev: Extract<DomainEvent, { type: 'transfer.received' }>): AdapterResult {
  const order = s.transfers.find((t) => t.id === ev.transferId);
  if (!order) return fail(s, ev.id, `调拨单 ${ev.transferId} 不存在`);
  if (order.status !== 'shipped' && order.status !== 'partially_received') {
    return fail(s, ev.id, `调拨单 ${ev.transferId} 状态为 ${order.status}，不能签收`);
  }
  const inputByBatch = new Map(ev.lines.map((l) => [l.batchId, l]));
  // 整组预检：逐批核对，任一超额或三量之和非法则整组退回
  for (const line of order.lines) {
    const input = inputByBatch.get(line.batchId);
    if (!input) return fail(s, ev.id, `缺少批次 ${line.batchId} 的逐批签收行，禁止只确认单头`);
    const { receivedMin, damagedMin, quarantineMin } = input;
    if (receivedMin < 0 || damagedMin < 0 || quarantineMin < 0) {
      return fail(s, ev.id, `批次 ${line.batchId} 签收数量不能为负`);
    }
    const settled = line.receivedMin + line.damagedMin + line.quarantineMin;
    const addSettled = receivedMin + damagedMin + quarantineMin;
    if (settled + addSettled > line.qtyApprovedMin) {
      return fail(
        s,
        ev.id,
        `批次 ${line.batchId} 本次实收+破损+待查 ${addSettled}，连同已处理 ${settled} 超过发出 ${line.qtyApprovedMin}，整组退回`,
      );
    }
  }

  const next = clone(s);
  const target = next.transfers.find((t) => t.id === ev.transferId)!;
  let batches = next.batches;
  let allClosed = true;
  for (const line of target.lines) {
    const input = inputByBatch.get(line.batchId)!;
    line.receivedMin += input.receivedMin;
    line.damagedMin += input.damagedMin;
    line.quarantineMin += input.quarantineMin;
    // 仅实收进入接收点可用库存；破损与待查不加入
    if (input.receivedMin > 0) {
      batches = adjustBatch(
        batches,
        target.toSiteId,
        line.batchId,
        line.drugCode,
        line.expiry,
        input.receivedMin,
      );
    }
    const settled = line.receivedMin + line.damagedMin + line.quarantineMin;
    if (settled < line.qtyApprovedMin) allClosed = false;
  }
  target.status = allClosed ? 'received' : 'partially_received';
  next.batches = batches;
  next.events.push(ev);
  return ok(next);
}

function applyCancelled(s: AdapterState, ev: Extract<DomainEvent, { type: 'transfer.cancelled' }>): AdapterResult {
  const order = s.transfers.find((t) => t.id === ev.transferId);
  if (!order) return fail(s, ev.id, `调拨单 ${ev.transferId} 不存在`);
  if (order.status === 'cancelled') return ok(s); // 幂等
  if (order.status !== 'draft' && order.status !== 'approved') {
    return fail(
      s,
      ev.id,
      `调拨单 ${ev.transferId} 已出库（${order.status}），取消只释放未发部分；已发退回须走回程到货`,
    );
  }
  const next = clone(s);
  const target = next.transfers.find((t) => t.id === ev.transferId)!;
  target.status = 'cancelled';
  next.events.push(ev);
  return ok(next);
}

function applyReturned(s: AdapterState, ev: Extract<DomainEvent, { type: 'transfer.returned' }>): AdapterResult {
  const order = s.transfers.find((t) => t.id === ev.transferId);
  if (!order) return fail(s, ev.id, `调拨单 ${ev.transferId} 不存在`);
  if (order.status !== 'shipped' && order.status !== 'partially_received') {
    return fail(s, ev.id, `调拨单 ${ev.transferId} 未出库，不能登记回程`);
  }
  const line = order.lines.find((l) => l.batchId === ev.batchId);
  if (!line) return fail(s, ev.id, `批次 ${ev.batchId} 不在调拨单 ${ev.transferId} 上`);
  const alreadyReturning = order.returns
    .filter((r) => r.batchId === ev.batchId)
    .reduce((sum, r) => sum + r.qtyMin, 0);
  if (ev.qtyMin <= 0) return fail(s, ev.id, '回程数量必须大于 0');
  if (alreadyReturning + ev.qtyMin > line.receivedMin) {
    return fail(
      s,
      ev.id,
      `回程 ${ev.qtyMin} 超出接收点实收余量（实收 ${line.receivedMin}，已登记回程 ${alreadyReturning}）`,
    );
  }
  const next = clone(s);
  const target = next.transfers.find((t) => t.id === ev.transferId)!;
  // 货物离开接收点：立即扣减接收点库存，在途回程由投影装配为来源到货
  next.batches = adjustBatch(
    next.batches,
    target.toSiteId,
    ev.batchId,
    line.drugCode,
    line.expiry,
    -ev.qtyMin,
  );
  target.returns.push({
    id: `RT-${target.id}-${target.returns.length + 1}`,
    batchId: ev.batchId,
    qtyMin: ev.qtyMin,
    shipDate: ev.shipDate,
    arriveDate: ev.arriveDate,
    received: false,
  });
  next.events.push(ev);
  return ok(next);
}

function applyReturnReceived(s: AdapterState, ev: Extract<DomainEvent, { type: 'transfer.return-received' }>): AdapterResult {
  const order = s.transfers.find((t) => t.id === ev.transferId);
  const ret = order?.returns.find((r) => r.id === ev.returnId);
  if (!order || !ret) return fail(s, ev.id, '回程单不存在');
  if (ret.received) return ok(s); // 重复签收幂等
  const next = clone(s);
  const target = next.transfers.find((t) => t.id === ev.transferId)!;
  const targetRet = target.returns.find((r) => r.id === ev.returnId)!;
  const line = target.lines.find((l) => l.batchId === ret.batchId)!;
  targetRet.received = true;
  next.batches = adjustBatch(
    next.batches,
    target.fromSiteId,
    ret.batchId,
    line.drugCode,
    line.expiry,
    ret.qtyMin,
  );
  next.events.push(ev);
  return ok(next);
}

function applyStocktake(s: AdapterState, ev: Extract<DomainEvent, { type: 'stocktake.adjusted' }>): AdapterResult {
  const next = clone(s);
  for (const adj of ev.adjustments) {
    const idx = next.batches.findIndex(
      (b) => b.id === adj.batchId && b.siteId === ev.siteId,
    );
    if (idx < 0) return fail(s, ev.id, `盘点批次 ${adj.batchId} 在 ${ev.siteId} 不存在`);
    if (adj.newQtyMin < 0) return fail(s, ev.id, `盘点数量不能为负（${adj.batchId}）`);
    next.batches[idx] = { ...next.batches[idx], qtyMin: adj.newQtyMin };
  }
  // 盘点更新：未确认建议（草稿）失效；已批准安排列待复核，不静默改数量
  next.transfers = next.transfers.map((t) => {
    const involvesSite =
      t.fromSiteId === ev.siteId || t.toSiteId === ev.siteId;
    if (!involvesSite) return t;
    if (t.status === 'draft') return { ...t, invalid: true };
    if (t.status === 'approved' || t.status === 'shipped' || t.status === 'partially_received') {
      return { ...t, reviewRequired: true };
    }
    return t;
  });
  next.events.push(ev);
  return ok(next);
}

/** 事件分发入口：未知事件 / 重复 id 被拒绝或忽略 */
export function applyEvent(state: AdapterState, ev: DomainEvent): AdapterResult {
  if (state.events.some((e) => e.id === ev.id)) {
    return ok(state); // 重复事件不生成双份库存
  }
  switch (ev.type) {
    case 'transfer.confirmed':
      return applyConfirmed(state, ev);
    case 'transfer.shipped':
      return applyShipped(state, ev);
    case 'transfer.received':
      return applyReceived(state, ev);
    case 'transfer.cancelled':
      return applyCancelled(state, ev);
    case 'transfer.returned':
      return applyReturned(state, ev);
    case 'transfer.return-received':
      return applyReturnReceived(state, ev);
    case 'stocktake.adjusted':
      return applyStocktake(state, ev);
  }
  // 联合类型已穷尽；兜底仅用于防御性未知事件
  return fail(state, (ev as DomainEvent).id, '未知事件类型');
}

/** 回程预计到货日：按原路线运输时间（无资料则 +3 天演示默认） */
export function defaultReturnArrive(shipDate: string, routeDays: number | null): string {
  return addDays(shipDate, routeDays ?? 3);
}
