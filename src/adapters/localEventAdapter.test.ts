import { describe, expect, it } from 'vitest';
import { applyEvent, type AdapterState } from './localEventAdapter';
import { createDemoData } from '../data/sampleData';
import type { DomainEvent, TransferOrder } from '../domain/types';

function base(): AdapterState {
  const d = createDemoData();
  return { batches: d.batches, transfers: d.transfers, events: d.events };
}

function draftOrder(): TransferOrder {
  return {
    id: 'T-TEST',
    fromSiteId: 'S-CENTRAL',
    toSiteId: 'S-B',
    drugCode: 'DRG-001',
    plannedShipDate: '2026-11-15',
    shipDate: null,
    arriveDate: '2026-11-21',
    status: 'draft',
    locked: false,
    basis: '测试草稿',
    lines: [
      {
        batchId: 'B-EPI-01',
        drugCode: 'DRG-001',
        expiry: '2026-12-31',
        qtyApprovedMin: 10,
        receivedMin: 0,
        damagedMin: 0,
        quarantineMin: 0,
      },
    ],
    returns: [],
  };
}

let evSeq = 100;
const evId = () => `EV-T${evSeq++}`;

describe('本地事件适配器', () => {
  it('确认 → 出库只扣一次来源余额，重复出库事件幂等', () => {
    let s = base();
    s.transfers = [...s.transfers, draftOrder()];
    const before = s.batches.find((b) => b.id === 'B-EPI-01' && b.siteId === 'S-CENTRAL')!.qtyMin;

    const confirm: DomainEvent = {
      id: evId(),
      type: 'transfer.confirmed',
      at: '2026-11-15',
      orders: [s.transfers.find((t) => t.id === 'T-TEST')!],
    };
    let r = applyEvent(s, confirm);
    expect(r.rejected).toHaveLength(0);
    s = r.state;
    // 批准未出库不动正式库存
    expect(
      s.batches.find((b) => b.id === 'B-EPI-01' && b.siteId === 'S-CENTRAL')!.qtyMin,
    ).toBe(before);

    const ship: DomainEvent = { id: evId(), type: 'transfer.shipped', at: '2026-11-15', transferId: 'T-TEST', shipDate: '2026-11-15' };
    r = applyEvent(s, ship);
    s = r.state;
    const afterShip = s.batches.find((b) => b.id === 'B-EPI-01' && b.siteId === 'S-CENTRAL')!.qtyMin;
    expect(afterShip).toBe(before - 10);

    const dup = applyEvent(s, { ...ship, id: evId() });
    expect(dup.rejected).toHaveLength(0);
    expect(
      dup.state.batches.find((b) => b.id === 'B-EPI-01' && b.siteId === 'S-CENTRAL')!.qtyMin,
    ).toBe(before - 10); // 没有第二次扣减
  });

  it('整组确认预检失败时全部退回', () => {
    let s = base();
    const big = draftOrder();
    big.id = 'T-BIG';
    big.lines[0].qtyApprovedMin = 9999;
    const ok = draftOrder();
    ok.id = 'T-OK';
    s.transfers = [...s.transfers, big, ok];
    const r = applyEvent(s, {
      id: evId(),
      type: 'transfer.confirmed',
      at: '2026-11-15',
      orders: s.transfers.filter((t) => t.id === 'T-BIG' || t.id === 'T-OK'),
    });
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.state.transfers.find((t) => t.id === 'T-OK')!.status).toBe('draft');
    expect(r.state.transfers.find((t) => t.id === 'T-BIG')!.status).toBe('draft');
  });

  it('逐批签收：三量之和守恒，少到停在待查且不退回来源', () => {
    let s = base();
    // T-1003 已在途 10 支（已部分签收 7），对余量再签收
    const r = applyEvent(s, {
      id: evId(),
      type: 'transfer.received',
      at: '2026-11-17',
      transferId: 'T-1003',
      lines: [{ batchId: 'B-CAL-01', receivedMin: 2, damagedMin: 0, quarantineMin: 1 }],
    });
    expect(r.rejected).toHaveLength(0);
    s = r.state;
    const line = s.transfers.find((t) => t.id === 'T-1003')!.lines[0];
    expect(line.receivedMin + line.damagedMin + line.quarantineMin).toBe(10);
    // 实收 6（4+2）进入 A 库存
    const atA = s.batches.find((b) => b.id === 'B-CAL-01' && b.siteId === 'S-A')?.qtyMin ?? 0;
    expect(atA).toBe(6);
    // 待查不回补来源：中心仓仍是出库后的数量
    const atCentral = s.batches.find((b) => b.id === 'B-CAL-01' && b.siteId === 'S-CENTRAL')!.qtyMin;
    expect(atCentral).toBe(90); // 100 - 10
  });

  it('签收超额整组退回；乱序重复事件不产生双份库存', () => {
    let s = base();
    const bad = applyEvent(s, {
      id: evId(),
      type: 'transfer.received',
      at: '2026-11-17',
      transferId: 'T-1003',
      lines: [{ batchId: 'B-CAL-01', receivedMin: 5, damagedMin: 0, quarantineMin: 0 }],
    });
    expect(bad.rejected.length).toBeGreaterThan(0);
    expect(bad.state).toEqual(s);

    const good: DomainEvent = {
      id: evId(),
      type: 'transfer.received',
      at: '2026-11-17',
      transferId: 'T-1003',
      lines: [{ batchId: 'B-CAL-01', receivedMin: 3, damagedMin: 0, quarantineMin: 0 }],
    };
    const once = applyEvent(s, good);
    const twice = applyEvent(once.state, { ...good, id: good.id });
    expect(twice.state).toEqual(once.state);
  });

  it('取消只释放未发部分；已发退回走回程，到货才恢复来源', () => {
    let s = base();
    s.transfers = [...s.transfers, draftOrder()];
    const confirm = applyEvent(s, {
      id: evId(),
      type: 'transfer.confirmed',
      at: '2026-11-15',
      orders: [s.transfers.find((t) => t.id === 'T-TEST')!],
    });
    s = confirm.state;
    const cancel = applyEvent(s, { id: evId(), type: 'transfer.cancelled', at: '2026-11-15', transferId: 'T-TEST' });
    expect(cancel.state.transfers.find((t) => t.id === 'T-TEST')!.status).toBe('cancelled');

    // 对已出库单取消被拒
    const cancelShipped = applyEvent(cancel.state, {
      id: evId(),
      type: 'transfer.cancelled',
      at: '2026-11-17',
      transferId: 'T-1001',
    });
    expect(cancelShipped.rejected.length).toBeGreaterThan(0);
  });

  it('回程登记 → 回程到货恢复来源库存', () => {
    let s = base();
    // T-1003 在 A 实收 4 支，登记 2 支回程
    const centralBefore = s.batches.find((b) => b.id === 'B-CAL-01' && b.siteId === 'S-CENTRAL')!.qtyMin;
    const ret = applyEvent(s, {
      id: evId(),
      type: 'transfer.returned',
      at: '2026-11-17',
      transferId: 'T-1003',
      batchId: 'B-CAL-01',
      qtyMin: 2,
      shipDate: '2026-11-17',
      arriveDate: '2026-11-20',
    });
    expect(ret.rejected).toHaveLength(0);
    s = ret.state;
    // A 库存从 4 降到 2；中心仓未恢复
    expect(s.batches.find((b) => b.id === 'B-CAL-01' && b.siteId === 'S-A')!.qtyMin).toBe(2);
    expect(s.batches.find((b) => b.id === 'B-CAL-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(centralBefore);

    const returnId = s.transfers.find((t) => t.id === 'T-1003')!.returns[0].id;
    const received = applyEvent(s, {
      id: evId(),
      type: 'transfer.return-received',
      at: '2026-11-20',
      transferId: 'T-1003',
      returnId,
    });
    expect(
      received.state.batches.find((b) => b.id === 'B-CAL-01' && b.siteId === 'S-CENTRAL')!.qtyMin,
    ).toBe(centralBefore + 2);
  });

  it('盘点使草稿失效、已批准安排待复核，不静默改数量', () => {
    let s = base();
    s.transfers = [...s.transfers, draftOrder()];
    const r = applyEvent(s, {
      id: evId(),
      type: 'stocktake.adjusted',
      at: '2026-11-15',
      siteId: 'S-CENTRAL',
      adjustments: [{ batchId: 'B-EPI-01', newQtyMin: 150 }],
    });
    expect(r.rejected).toHaveLength(0);
    const draft = r.state.transfers.find((t) => t.id === 'T-TEST')!;
    expect(draft.invalid).toBe(true);
    const approved = r.state.transfers.find((t) => t.id === 'T-1002')!;
    expect(approved.reviewRequired).toBe(true);
    // 已批准行数量未被修改
    expect(approved.lines[0].qtyApprovedMin).toBe(20);
  });
});
