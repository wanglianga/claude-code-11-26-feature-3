import { describe, expect, it } from 'vitest';
import { simulate } from './simulate';
import { toMinUnits } from './units';
import type { PlannedArrival } from './types';

describe('单位换算', () => {
  const specs = [
    { drugCode: 'D1', packUnit: '盒', minUnit: '支', unitsPerPack: 10 },
  ];
  it('按显式包装关系换算', () => {
    expect(toMinUnits('D1', 2.4, specs)).toBe(24);
  });
  it('缺换算资料返回 null，不推断', () => {
    expect(toMinUnits('D-X', 3, specs)).toBeNull();
  });
});

describe('按日批次推演', () => {
  it('先失效、再到货、再 FEFO 消耗，并分别记账', () => {
    const arrivals: PlannedArrival[] = [
      // 到货当天已失效：直接计过期，不入库
      {
        key: 'a1',
        batchId: 'B2',
        batchExpiry: '2026-11-16',
        qtyMin: 5,
        arriveDate: '2026-11-16',
        kind: 'supplier',
        refId: 'a1',
      },
      {
        key: 'a2',
        batchId: 'B3',
        batchExpiry: '2026-12-01',
        qtyMin: 4,
        arriveDate: '2026-11-17',
        kind: 'supplier',
        refId: 'a2',
      },
    ];
    const result = simulate({
      siteId: 'S',
      drugCode: 'D1',
      startDate: '2026-11-15',
      horizonDays: 4,
      openingBatches: [
        // B1 在 11-16 失效，余 3 支
        { batchId: 'B1', expiry: '2026-11-16', qtyMin: 3 },
        { batchId: 'B0', expiry: '2026-12-31', qtyMin: 12 },
      ],
      arrivals,
      dailyDemandMin: 6,
    });
    const [d0, d1, d2, d3] = result.ticks;
    // Day0：FEFO 先动 B1（效期更早）6 支，但 B1 只有 3 → 再取 B0 3 支
    expect(d0.satisfiedMin).toBe(6);
    expect(d0.shortageMin).toBe(0);
    expect(d0.batches.find((b) => b.batchId === 'B1')?.consumedMin).toBe(3);
    expect(d0.batches.find((b) => b.batchId === 'B0')?.consumedMin).toBe(3);
    // Day1：B1 失效 0 余量（已耗尽），到货 B2 即过期 5 支
    expect(d1.expiredMin).toBe(5);
    expect(d1.batches.find((b) => b.batchId === 'B2')?.receivedInMin).toBe(0);
    // Day2：B3 到货 4，当天消耗 FEFO 先 B3 后 B0
    expect(d2.arrivalMin).toBe(4);
    expect(d2.batches.find((b) => b.batchId === 'B3')?.consumedMin).toBe(4);
    expect(d2.batches.find((b) => b.batchId === 'B0')?.consumedMin).toBe(2);
    // Day3：只剩 B0 1 支（10-3-2-4=1），需求 6 → 缺货 5
    expect(d3.shortageMin).toBe(5);
    expect(d3.satisfiedMin).toBe(1);
    expect(result.totalExpiredMin).toBe(5);
    expect(result.firstGapDate).toBe('2026-11-18');
    expect(result.gapDates).toEqual(['2026-11-18']);
  });

  it('调出移除在到货与消耗之前执行', () => {
    const result = simulate({
      siteId: 'S',
      drugCode: 'D1',
      startDate: '2026-11-15',
      horizonDays: 2,
      openingBatches: [{ batchId: 'B1', expiry: '2026-12-31', qtyMin: 10 }],
      arrivals: [],
      dailyDemandMin: 4,
      removals: [
        { date: '2026-11-15', batchId: 'B1', qtyMin: 7, refId: 'T1' },
      ],
    });
    expect(result.ticks[0].batches[0].removedOutMin).toBe(7);
    // 剩 3 支，需求 4 → 缺货 1
    expect(result.ticks[0].shortageMin).toBe(1);
    // 次日无库存 → 缺货 4
    expect(result.ticks[1].shortageMin).toBe(4);
  });
});
