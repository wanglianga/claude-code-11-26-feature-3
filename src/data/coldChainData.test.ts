import { describe, expect, it } from 'vitest';
import { analyzeShipment, buildCheck, reviewShipment } from '../domain/coldchain';
import {
  coldBoxes,
  coldCalibrationRevisions,
  coldLateReading,
  coldReadingsSeed,
  coldShipments,
} from './coldChainData';

const byId = (id: string) => coldShipments.find((s) => s.id === id)!;
const readingsOf = (id: string) => coldReadingsSeed.filter((r) => r.shipmentId === id);

describe('冷链固定演示数据：三个运输任务的核查走向', () => {
  it('CC-2001 多次开箱 + 两小时断联 + 同序异值 → 待复核，且断联不被当成正常', () => {
    const s = byId('CC-2001');
    const review = reviewShipment(s, readingsOf('CC-2001'));
    const a = review.analysis;
    expect(review.verdict).toBe('pending-review');
    // 两小时断联：08:00→10:00 整段未知（120 分钟），正常时长不覆盖该段
    expect(a.unknownMs).toBe(120 * 60_000);
    expect(a.maxContinuousUnknownMs).toBe(120 * 60_000);
    // 开箱抬升形成连续越上限（≥30 分钟阈值）
    expect(a.maxContinuousExcursionMs).toBeGreaterThanOrEqual(30 * 60_000);
    // 清洗：完全重复被折叠、同序异值被识别、乱序被打标、窗口外读数单列
    expect(a.clean.duplicates.some((d) => d.readingId === 'C1-02-DUP')).toBe(true);
    expect(a.clean.conflicts.some((c) => c.key === 'D-CC01#3')).toBe(true);
    expect(a.clean.clean.some((c) => c.issues.includes('out-of-order'))).toBe(true);
    expect(a.clean.outsideWindow).toContain('C1-PRE');
  });

  it('CC-2001 插入一条迟报读数：生成新检查且未知区间由 120 缩小到 90 分钟', () => {
    const s = byId('CC-2001');
    const chk1 = buildCheck(s, readingsOf('CC-2001'), 'initial', 1, s.endAt + 5 * 60_000);
    const withLate = [...readingsOf('CC-2001'), coldLateReading];
    const chk2 = buildCheck(s, withLate, 'late-upload', 2, s.endAt + 35 * 60_000);
    expect(chk1.result.analysis.unknownMs).toBe(120 * 60_000);
    expect(chk2.result.analysis.unknownMs).toBe(90 * 60_000);
    expect(chk2.result.analysis.maxContinuousUnknownMs).toBe(90 * 60_000);
    // 06:00→08:30 之间恢复了 30 分钟可信连接
    expect(chk2.result.analysis.connectedMs).toBeGreaterThan(
      chk1.result.analysis.connectedMs,
    );
    // 历史检查不被改写
    expect(chk1.id).toBe('CHK-1');
    expect(chk2.id).toBe('CHK-2');
  });

  it('CC-2002 校准前漂移高读触发待复核；应用校准修订后重新核验转为可接收', () => {
    const s = byId('CC-2002');
    const before = reviewShipment(s, readingsOf('CC-2002'));
    expect(before.verdict).toBe('pending-review');
    expect(before.reasons.some((x) => x.includes('连续越界'))).toBe(true);
    // 换传感器重叠点温度一致 → 无重叠冲突
    expect(before.analysis.clean.overlapConflicts).toHaveLength(0);

    // 应用校准修订：原值保留、新值采用，不产生同序异值冲突，另生成新检查
    const revisedReadings = [...readingsOf('CC-2002'), ...coldCalibrationRevisions];
    const chk2 = buildCheck(s, revisedReadings, 'calibration-revision', 2, s.endAt + 75 * 60_000);
    const a = chk2.result.analysis;
    expect(a.clean.conflicts).toHaveLength(0);
    expect(a.clean.clean.some((c) => c.issues.includes('revision'))).toBe(true);
    expect(a.clean.clean.some((c) => c.issues.includes('revised'))).toBe(true);
    // 漂移高读被修订后，不再有连续越界，结论转为可按流程接收
    expect(chk2.result.verdict).toBe('acceptable');
    // 原始读数仍保留可回溯
    expect(chk2.readingIds).toContain('C2-A2');
    expect(chk2.readingIds).toContain('C2-A2-FIX');
  });

  it('CC-2003 换传感器重叠读数温度不一致 → 重叠冲突单列并阻断接收', () => {
    const s = byId('CC-2003');
    const review = reviewShipment(s, readingsOf('CC-2003'));
    expect(review.analysis.clean.overlapConflicts).toHaveLength(1);
    expect(review.verdict).toBe('pending-review');
    expect(review.reasons.join('；')).toContain('冲突');
  });

  it('同箱多批次共享同一运输证据，时长不按批次重复累计', () => {
    const box1 = coldBoxes.find((b) => b.id === 'BOX-C1')!;
    expect(box1.batchIds).toEqual(['B-CC-EPI-1', 'B-CC-EPI-2']);
    const a = analyzeShipment(byId('CC-2001'), readingsOf('CC-2001'));
    // 证据只计算一次：箱体两个批次共用同一份 unknownMs，不存在「×批次数」
    expect(a.unknownMs).toBe(120 * 60_000);
  });
});
