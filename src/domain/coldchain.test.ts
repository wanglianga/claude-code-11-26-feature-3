import { describe, expect, it } from 'vitest';
import {
  analyzeShipment,
  buildCheck,
  cleanReadings,
  deviceWindows,
  evidenceForBox,
  reviewShipment,
  type ColdShipment,
  type TemperatureReading,
} from './coldchain';

const MIN = 60_000;
// 固定基准时间：2026-11-15 08:00 UTC（确定性，禁止 Date.now）
const T0 = Date.UTC(2026, 10, 15, 8, 0, 0);
const at = (min: number) => T0 + min * MIN;

const THRESHOLD = { minC: 2, maxC: 8 };
const MAX_GAP = 30 * MIN;

function shipment(
  over: Partial<ColdShipment> = {},
  windowMin = 120,
): ColdShipment {
  return {
    id: 'CC-1',
    boxId: 'BOX-1',
    fromSiteId: 'S-CENTRAL',
    toSiteId: 'S-A',
    startAt: T0,
    endAt: at(windowMin),
    threshold: THRESHOLD,
    maxCredibleGapMs: MAX_GAP,
    handovers: [],
    ...over,
  };
}

function reading(
  id: string,
  deviceId: string,
  seq: number,
  sampledMin: number,
  tempC: number,
  over: Partial<TemperatureReading> = {},
): TemperatureReading {
  return {
    id,
    shipmentId: 'CC-1',
    deviceId,
    seq,
    sampledAt: at(sampledMin),
    receivedAt: at(sampledMin),
    tempC,
    ...over,
  };
}

describe('冷链读数清洗：去重 / 同序异值 / 乱序归一', () => {
  it('按设备序号去重，完全重复只保留首条', () => {
    const s = shipment();
    const r = cleanReadings(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 1, 0, 5, { receivedAt: at(2) }),
      reading('r3', 'D1', 2, 10, 5),
    ]);
    expect(r.duplicates).toEqual([{ readingId: 'r2', keptReadingId: 'r1' }]);
    expect(r.clean.map((c) => c.reading.id)).toEqual(['r1', 'r3']);
  });

  it('同序异值识别为冲突且两条都保留，不静默取舍', () => {
    const s = shipment();
    const r = cleanReadings(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 1, 0, 6, { receivedAt: at(3) }),
    ]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].valuesC).toEqual([5, 6]);
    expect(r.clean.map((c) => c.reading.id).sort()).toEqual(['r1', 'r2']);
    expect(r.clean.every((c) => c.issues.includes('same-seq-conflict'))).toBe(true);
  });

  it('乱序上传统一按采样时间归一，只打标不改事实', () => {
    const s = shipment();
    const r = cleanReadings(s, [
      reading('r1', 'D1', 1, 0, 5, { receivedAt: at(0) }),
      reading('r2', 'D1', 2, 10, 5, { receivedAt: at(5) }),
      // r3 采样最晚但平台最先收到 → 乱序
      reading('r3', 'D1', 3, 20, 5, { receivedAt: at(2) }),
    ]);
    const byId = new Map(r.clean.map((c) => [c.reading.id, c]));
    expect(byId.get('r3')!.issues).toContain('out-of-order');
    // 归一后仍按采样时间排列
    expect(r.clean.map((c) => c.reading.sampledAt)).toEqual([at(0), at(10), at(20)]);
  });

  it('窗口外读数单列，不参与连接', () => {
    const s = shipment({}, 60);
    const r = cleanReadings(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 2, 90, 5),
    ]);
    expect(r.outsideWindow).toEqual(['r2']);
  });
});

describe('可信连接与状态区间', () => {
  it('可信间隔内线性连接并按阈值交点拆出正常/越界段', () => {
    const s = shipment({}, 20);
    const a = analyzeShipment(s, [
      reading('r1', 'D1', 1, 0, 7),
      reading('r2', 'D1', 2, 20, 9), // 20 分钟 ≤ 30，可信；7→9 在上限 8℃ 处相交
    ]);
    expect(a.thresholdCrossings).toHaveLength(1);
    expect(a.thresholdCrossings[0].bound).toBe('max');
    expect(a.thresholdCrossings[0].at).toBe(at(10)); // (8-7)/(9-7)=0.5
    const statuses = a.segments.map((g) => g.status);
    expect(statuses).toContain('normal');
    expect(statuses).toContain('excursion-high');
    // 各 10 分钟
    expect(a.excursionMs).toBe(10 * MIN);
    expect(a.normalMs).toBe(10 * MIN);
  });

  it('两次正常读数断联两小时：整段列未知，不能当成两小时温度正常', () => {
    const s = shipment({}, 120);
    const a = analyzeShipment(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 2, 120, 5), // 间隔 120 分钟 > 30
    ]);
    expect(a.unknownMs).toBe(120 * MIN);
    expect(a.normalMs).toBe(0);
    expect(a.connectedMs).toBe(0);
    expect(a.unknownSegments).toHaveLength(1);
    expect(a.unknownSegments[0].status).toBe('unknown');
  });

  it('断联两侧的越界是两段独立事实，不跨断联合并成一段', () => {
    const s = shipment({}, 200);
    const a = analyzeShipment(s, [
      reading('r1', 'D1', 1, 0, 9),
      reading('r2', 'D1', 2, 20, 9), // 0–20 越界
      reading('r3', 'D1', 3, 100, 9), // 20→100 间隔 80 分钟超间隔 → 未知
      reading('r4', 'D1', 4, 120, 9), // 100–120 又越界
    ]);
    const excursionSegs = a.continuousExcursions;
    expect(excursionSegs).toHaveLength(2); // 不是一整段
    expect(a.maxContinuousExcursionMs).toBe(20 * MIN); // 最长连续仅 20 分钟
    expect(a.excursionMs).toBe(40 * MIN); // 累计 40 分钟
    // 未知 = 20→100（80）+ 120→200 窗口尾（80）
    expect(a.unknownMs).toBe(160 * MIN);
  });

  it('不用全量平均掩盖连续超限：均值在区间内仍识别出越界段', () => {
    const s = shipment({}, 30);
    const a = analyzeShipment(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 2, 10, 5),
      reading('r3', 'D1', 3, 20, 9), // 单点越上限
      reading('r4', 'D1', 4, 30, 5),
    ]);
    expect(a.excursionMs).toBeGreaterThan(0);
    expect(a.continuousExcursions.length).toBeGreaterThan(0);
  });
});

describe('交接换传感器与重叠冲突', () => {
  it('以交接依据衔接两台设备，重叠时刻温度不一致单列冲突', () => {
    const s = shipment(
      {
        handovers: [
          {
            id: 'H-1',
            at: at(60),
            kind: 'sensor-change',
            fromDeviceId: 'D1',
            toDeviceId: 'D2',
            note: '中转交接更换传感器',
          },
        ],
      },
      120,
    );
    const windows = deviceWindows(s, [
      reading('a', 'D1', 1, 50, 5),
      reading('b', 'D1', 2, 60, 7),
      reading('c', 'D2', 1, 60, 9), // 同一时刻新设备 9℃，与旧设备 7℃ 冲突
      reading('d', 'D2', 2, 70, 5),
    ]);
    expect(windows.map((w) => w.deviceId)).toEqual(['D1', 'D2']);
    expect(windows[0].activeTo).toBe(at(60));
    expect(windows[1].activeFrom).toBe(at(60));

    const clean = cleanReadings(s, [
      reading('a', 'D1', 1, 50, 5),
      reading('b', 'D1', 2, 60, 7),
      reading('c', 'D2', 1, 60, 9),
      reading('d', 'D2', 2, 70, 5),
    ]);
    expect(clean.overlapConflicts).toHaveLength(1);
    expect(clean.overlapConflicts[0].deviceValues.map((v) => v.deviceId).sort()).toEqual(['D1', 'D2']);

    // 冲突阻断 → 待复核
    const review = reviewShipment(s, [
      reading('a', 'D1', 1, 50, 5),
      reading('b', 'D1', 2, 60, 7),
      reading('c', 'D2', 1, 60, 9),
      reading('d', 'D2', 2, 70, 5),
    ]);
    expect(review.verdict).toBe('pending-review');
    expect(review.reasons.join('；')).toContain('冲突');
  });
});

describe('核查结论规则', () => {
  it('全程正常且无冲突 → 可按流程接收', () => {
    const s = shipment({}, 30);
    const review = reviewShipment(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 2, 15, 6),
      reading('r3', 'D1', 3, 30, 5),
    ]);
    expect(review.verdict).toBe('acceptable');
    expect(review.reasons).toHaveLength(0);
  });

  it('连续越界达到 30 分钟 → 待复核', () => {
    const s = shipment({}, 40);
    const review = reviewShipment(s, [
      reading('r1', 'D1', 1, 0, 9),
      reading('r2', 'D1', 2, 30, 9), // 连续越界 30 分钟
      reading('r3', 'D1', 3, 40, 5),
    ]);
    expect(review.verdict).toBe('pending-review');
    expect(review.reasons.some((x) => x.includes('连续越界'))).toBe(true);
  });

  it('未知缺测达到 60 分钟 → 待复核', () => {
    const s = shipment({}, 120);
    const review = reviewShipment(s, [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 2, 120, 5), // 整段 120 分钟未知
    ]);
    expect(review.verdict).toBe('pending-review');
    expect(review.reasons.some((x) => x.includes('未知'))).toBe(true);
  });
});

describe('迟报 / 校准修订与检查历史', () => {
  it('插入一条迟报读数后生成新检查，未知区间缩小，原检查保留', () => {
    const s = shipment({}, 120);
    const initial = [
      reading('r1', 'D1', 1, 0, 5),
      reading('r2', 'D1', 2, 120, 5), // 断联 120 分钟，整段未知
    ];
    const chk1 = buildCheck(s, initial, 'initial', 1, at(125));
    expect(chk1.id).toBe('CHK-1');
    expect(chk1.result.analysis.unknownMs).toBe(120 * MIN);
    expect(chk1.result.analysis.maxContinuousUnknownMs).toBe(120 * MIN);

    // 迟报补传：第 30 分钟读数在签收后才到；0→30 间隔 30 分钟恢复为可信连接，
    // 仅 30→120（90 分钟）仍未知，未知总时长与最长连续未知区间双双缩小
    const withLate = [
      ...initial,
      reading('r3', 'D1', 3, 30, 5, { receivedAt: at(130), late: true }),
    ];
    const chk2 = buildCheck(s, withLate, 'late-upload', 2, at(131));
    expect(chk2.id).toBe('CHK-2');
    expect(chk2.trigger).toBe('late-upload');
    expect(chk2.result.analysis.unknownMs).toBe(90 * MIN);
    expect(chk2.result.analysis.maxContinuousUnknownMs).toBe(90 * MIN);
    expect(chk2.result.analysis.connectedMs).toBe(30 * MIN);
    expect(chk2.result.analysis.unknownMs).toBeLessThan(
      chk1.result.analysis.unknownMs,
    );
    // 原检查对象不被改写
    expect(chk1.result.analysis.unknownMs).toBe(120 * MIN);
    expect(chk1.readingIds).not.toContain('r3');
    expect(chk2.readingIds).toContain('r3');
  });

  it('校准修订读数触发重新核验，不覆盖原读数', () => {
    const s = shipment({}, 20);
    const base = [reading('r1', 'D1', 1, 0, 9), reading('r2', 'D1', 2, 20, 9)];
    const chk1 = buildCheck(s, base, 'initial', 1, at(25));
    const revised = [
      ...base,
      reading('r1-fix', 'D1', 1, 0, 5, {
        receivedAt: at(40),
        revisionOfReadingId: 'r1',
        note: '传感器零点漂移校准修订',
      }),
    ];
    const clean = cleanReadings(s, revised);
    expect(clean.clean.some((c) => c.issues.includes('revision'))).toBe(true);
    const chk2 = buildCheck(s, revised, 'calibration-revision', 2, at(41));
    expect(chk2.trigger).toBe('calibration-revision');
    expect(chk2.id).toBe('CHK-2');
    // 原始读数仍在
    expect(chk2.readingIds).toContain('r1');
    expect(chk2.readingIds).toContain('r1-fix');
    expect(chk1.id).toBe('CHK-1'); // 历史检查保留
  });
});

describe('同箱多批次证据不重复累计', () => {
  it('同一运输证据供多个批次关联，时长只取一次', () => {
    const s = shipment({}, 20);
    const review = reviewShipment(
      s,
      [reading('r1', 'D1', 1, 0, 5), reading('r2', 'D1', 2, 20, 6)],
      undefined,
      'CHK-1',
    );
    const box = {
      id: 'BOX-1',
      shipmentId: 'CC-1',
      batchIds: ['B-A', 'B-B'],
      drugCode: 'DRG-001',
      batchQtyMin: { 'B-A': 10, 'B-B': 20 },
    };
    const ev = evidenceForBox(box, { 'CC-1': review });
    expect(ev.batchIds).toEqual(['B-A', 'B-B']);
    expect(ev.result).toBe(review); // 同一个结果对象，不按批次复制/重复累计
  });
});
