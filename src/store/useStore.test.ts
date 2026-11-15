import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './useStore';
import { computePairs } from './selectors';
import { DEMO_START } from '../data/sampleData';

const s = () => useStore.getState();

describe('Zustand 工作流端到端', () => {
  beforeEach(() => {
    s().resetDemo();
    s().login('planner', 'demo1234');
  });

  it('候选 → 草稿 → 批准 → 出库 → 逐批签收全链路，正式库存按事件迁移', () => {
    const state = s();
    const cand = state.buildCandidates().candidates.find(
      (c) => c.id === 'CAND-S-CENTRAL-S-A-DRG-002',
    )!;
    expect(cand.qtyMin).toBe(100);
    s().addCandidateToDraft(cand);
    const draft = s().transfers.find((t) => t.candidateId === cand.id && t.status === 'draft')!;
    expect(draft).toBeDefined();

    // 草稿阶段不写正式库存
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(100);

    s().confirmDrafts([draft.id]);
    expect(s().transfers.find((t) => t.id === draft.id)!.status).toBe('approved');
    // 批准未出库仍不动正式库存
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(100);

    s().shipOrder(draft.id);
    expect(s().transfers.find((t) => t.id === draft.id)!.status).toBe('shipped');
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(0);

    // 逐批签收：90 收 + 5 损 + 5 待查 = 100
    s().receiveOrder(draft.id, [
      { batchId: 'B-NTG-01', receivedMin: 90, damagedMin: 5, quarantineMin: 5 },
    ]);
    const closed = s().transfers.find((t) => t.id === draft.id)!;
    expect(closed.status).toBe('received');
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-A')!.qtyMin).toBe(90);
    // 待查 5 不回补来源
    expect(s().batches.find((b) => b.id === 'B-NTG-01' && b.siteId === 'S-CENTRAL')!.qtyMin).toBe(0);

    // 已结清单再次签收被拒
    const eventsBefore = s().events.length;
    s().receiveOrder(draft.id, [
      { batchId: 'B-NTG-01', receivedMin: 1, damagedMin: 0, quarantineMin: 0 },
    ]);
    expect(s().rejected.length).toBeGreaterThan(0);
    expect(s().events.length).toBe(eventsBefore);
  });

  it('双情景选择器在节点环境输出真实缺口', () => {
    const rows = computePairs(s().planningData(), {
      siteIds: ['S-B'],
      startDate: DEMO_START,
      horizonDays: 30,
    });
    const epi = rows.find((r) => r.drugCode === 'DRG-001')!;
    expect(epi.baseline.firstGapDate).toBe('2026-11-18');
    expect(epi.baseline.totalExpiredMin).toBe(16);
  });

  it('盘点使锁定草稿产生冲突原因、已批准单待复核，且数量不被静默修改', () => {
    const cand = s().buildCandidates().candidates.find(
      (c) => c.id === 'CAND-S-CENTRAL-S-A-DRG-001',
    )!;
    s().addCandidateToDraft(cand);
    const draft = s().transfers.find((t) => t.candidateId === cand.id)!;
    s().toggleLock(draft.id);

    // 先批准一张单子用于验证待复核标记
    const cand2 = s().buildCandidates().candidates.find(
      (c) => c.id === 'CAND-S-CENTRAL-S-A-DRG-004',
    )!;
    s().addCandidateToDraft(cand2);
    const draft2 = s().transfers.find((t) => t.candidateId === cand2.id)!;
    s().confirmDrafts([draft2.id]);

    // 盘点把 B-EPI-01 调减到 50（草稿需要 110）
    s().stocktake('S-CENTRAL', [{ batchId: 'B-EPI-01', newQtyMin: 50 }]);
    expect(s().transfers.find((t) => t.id === draft.id)!.invalid).toBe(true);
    const approved = s().transfers.find((t) => t.id === draft2.id)!;
    expect(approved.reviewRequired).toBe(true);
    expect(approved.lines[0].qtyApprovedMin).toBe(60); // 数量未被静默修改

    s().recalc();
    const locked = s().transfers.find((t) => t.id === draft.id)!;
    expect(locked.conflictReason).toContain('重算后真实余量仅');
  });

  it('只读观察员的写操作被拦截', () => {
    s().logout();
    s().login('viewer', 'view1234');
    const before = s().transfers.length;
    const cand = s().buildCandidates().candidates[0];
    s().addCandidateToDraft(cand);
    expect(s().transfers.length).toBe(before);
    expect(s().notice).toContain('只读');
  });
});

describe('冷链运输核查工作流', () => {
  beforeEach(() => {
    s().resetDemo();
    s().login('planner', 'demo1234');
  });

  const checkOf = (shipmentId: string) => {
    const own = s().coldChecks.filter((c) => c.shipmentId === shipmentId);
    return own[own.length - 1];
  };

  it('初始三个运输均有待复核项，隔离批次不进入正式库存也不参与候选', () => {
    expect(checkOf('CC-2001').result.verdict).toBe('pending-review');
    expect(checkOf('CC-2002').result.verdict).toBe('pending-review');
    expect(checkOf('CC-2003').result.verdict).toBe('pending-review');
    // 全部冷链批次先隔离
    expect(s().coldQuarantine.every((q) => q.status === 'isolated')).toBe(true);
    // 尚未出现在正式库存
    expect(s().batches.find((b) => b.id === 'B-CC-CAL-1')).toBeUndefined();
    expect(s().batches.find((b) => b.id === 'B-CC-EPI-1')).toBeUndefined();
  });

  it('待复核状态不能直接放行；继续隔离不写正式库存', () => {
    s().decideColdDisposition('CC-2001', 'release');
    expect(s().coldDispositions.find((d) => d.shipmentId === 'CC-2001')).toBeUndefined();
    expect(s().notice).toContain('待复核');

    s().decideColdDisposition('CC-2003', 'quarantine');
    const line = s().coldQuarantine.find((q) => q.shipmentId === 'CC-2003')!;
    expect(line.status).toBe('held');
    expect(s().batches.find((b) => b.id === 'B-CC-EPI-3')).toBeUndefined();
  });

  it('插入迟报读数生成新检查，CC-2001 未知区间由 120 缩小到 90 分钟且历史检查保留', () => {
    const before = s().coldChecks.filter((c) => c.shipmentId === 'CC-2001').length;
    s().insertLateReading();
    const after = s().coldChecks.filter((c) => c.shipmentId === 'CC-2001');
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].trigger).toBe('late-upload');
    expect(after[after.length - 1].result.analysis.unknownMs).toBe(90 * 60_000);
    expect(after[0].result.analysis.unknownMs).toBe(120 * 60_000); // 原检查不变
    // 重复插入被忽略
    s().insertLateReading();
    expect(s().coldChecks.filter((c) => c.shipmentId === 'CC-2001').length).toBe(after.length);
  });

  it('校准修订触发重新核验转为可接收，批准放行后批次才进入正式可用余量', () => {
    // 放行前先确认待复核被闸门拦截
    s().decideColdDisposition('CC-2002', 'release');
    expect(s().batches.find((b) => b.id === 'B-CC-CAL-1')).toBeUndefined();

    s().applyCalibration();
    const chk = checkOf('CC-2002');
    expect(chk.trigger).toBe('calibration-revision');
    expect(chk.result.verdict).toBe('acceptable');
    // 原始读数与修订值都保留
    expect(s().coldReadings.some((r) => r.id === 'C2-A2')).toBe(true);
    expect(s().coldReadings.some((r) => r.id === 'C2-A2-FIX')).toBe(true);

    s().decideColdDisposition('CC-2002', 'release');
    const released = s().batches.find((b) => b.id === 'B-CC-CAL-1' && b.siteId === 'S-B');
    expect(released?.qtyMin).toBe(15);
    expect(
      s().coldQuarantine.find((q) => q.shipmentId === 'CC-2002' && q.batchId === 'B-CC-CAL-1')!.status,
    ).toBe('released');
    // 已批准处置保留原记录，重复处置被拒
    const dispCount = s().coldDispositions.filter((d) => d.shipmentId === 'CC-2002').length;
    s().decideColdDisposition('CC-2002', 'quarantine');
    expect(s().coldDispositions.filter((d) => d.shipmentId === 'CC-2002').length).toBe(dispCount);
    expect(s().notice).toContain('保留原记录');
  });

  it('同箱多批次放行后逐批进入余量，证据时长不按批次重复累计', () => {
    // CC-2001 同箱两个批次：先插入迟报，仍为待复核（冲突+越界+90 分钟未知），演示隔离不变
    s().insertLateReading();
    expect(checkOf('CC-2001').result.verdict).toBe('pending-review');
    // 未知时长只有一份，不会因两个批次而翻倍
    expect(checkOf('CC-2001').result.analysis.unknownMs).toBe(90 * 60_000);
  });

  it('只读观察员不能插入迟报/校准/处置', () => {
    s().logout();
    s().login('viewer', 'view1234');
    s().insertLateReading();
    expect(s().lateInserted).toBe(false);
    expect(s().notice).toContain('只读');
    s().applyCalibration();
    expect(s().calibrationApplied).toBe(false);
    s().decideColdDisposition('CC-2002', 'release');
    expect(s().coldDispositions).toHaveLength(0);
  });
});
