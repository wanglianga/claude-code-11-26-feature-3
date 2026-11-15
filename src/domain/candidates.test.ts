import { describe, expect, it } from 'vitest';
import { generateCandidates } from './candidates';
import { buildSimInput, simulatePair } from './projection';
import { simulate } from './simulate';
import {
  createDemoData,
  demoDemands,
  demoDrugs,
  demoInbounds,
  demoPackageSpecs,
  demoSites,
  demoTransport,
  DEMO_START,
} from '../data/sampleData';
import type { PlanningData } from './projection';

function planning(): PlanningData {
  const demo = createDemoData();
  return {
    batches: demo.batches,
    demands: demoDemands,
    inbounds: demoInbounds,
    transfers: demo.transfers,
    transport: demoTransport,
  };
}

const HORIZON = 30;
const SELECTED = ['S-CENTRAL', 'S-A', 'S-B', 'S-C'];

describe('样例数据健康检查', () => {
  it('所有有包装关系的批次完成换算，缺资料条目被分流', () => {
    const demo = createDemoData();
    expect(demo.batches.length).toBeGreaterThan(10);
    expect(demo.missingConversions.length).toBeGreaterThanOrEqual(2);
    expect(
      demo.missingConversions.every((m) => m.drugCode === 'DRG-005'),
    ).toBe(true);
  });

  it('药品目录固定且不含临床替代推断', () => {
    expect(demoDrugs.map((d) => d.code).sort()).toEqual(
      ['DRG-001', 'DRG-002', 'DRG-003', 'DRG-004', 'DRG-005'].sort(),
    );
    expect(demoPackageSpecs.find((s) => s.drugCode === 'DRG-005')).toBeUndefined();
  });
});

describe('规定场景 A：有货但来不及', () => {
  it('远端 B 肾上腺素缺口早于中心仓最早到货日，候选被标记不可行', () => {
    const data = planning();
    const pair = simulatePair(data, 'S-B', 'DRG-001', DEMO_START, HORIZON);
    // B 期初 24 支、日耗 8 → 首缺口 11-18
    expect(pair.baseline.firstGapDate).toBe('2026-11-18');
    // 中心仓路线 6 天，11-15 出库 → 11-21 到货，晚于 11-18
    const result = generateCandidates(
      data,
      demoSites,
      { siteIds: SELECTED, startDate: DEMO_START, horizonDays: HORIZON },
    );
    const bEpiCandidates = result.candidates.filter(
      (c) => c.toSiteId === 'S-B' && c.drugCode === 'DRG-001',
    );
    expect(bEpiCandidates.length).toBe(0);
    const infeasible = result.infeasible.find(
      (i) => i.siteId === 'S-B' && i.drugCode === 'DRG-001',
    );
    expect(infeasible).toBeDefined();
    expect(infeasible!.notes.some((n) => n.reason === '有货但来不及')).toBe(true);
  });
});

describe('规定场景 B：到货后先过期', () => {
  it('供应商 11-22 到货的 40 支在 11-25 失效，推演记录过期且不形成后续可用', () => {
    const data = planning();
    const pair = simulatePair(data, 'S-B', 'DRG-001', DEMO_START, HORIZON);
    const tick22 = pair.baseline.ticks.find((t) => t.date === '2026-11-22')!;
    const tick25 = pair.baseline.ticks.find((t) => t.date === '2026-11-25')!;
    expect(tick22.arrivalMin).toBe(40);
    // 22/23/24 各消耗 8（FEFO 先用近效期批次），25 日余量 40-24=16 过期
    expect(tick25.expiredMin).toBe(16);
    const batch25 = tick25.batches.find((b) => b.batchId === 'B-EPI-S1');
    expect(batch25?.expiredMin).toBe(16);
    // 过期之后该批不再产生满足量
    const later = pair.baseline.ticks.filter((t) => t.date > '2026-11-25');
    expect(
      later.every(
        (t) => (t.batches.find((b) => b.batchId === 'B-EPI-S1')?.closeMin ?? 0) === 0,
      ),
    ).toBe(true);
  });

  it('中心仓近效期批次不满足接收点最低剩余效期，不能成为候选', () => {
    const data = planning();
    const result = generateCandidates(
      data,
      demoSites,
      { siteIds: SELECTED, startDate: DEMO_START, horizonDays: HORIZON },
    );
    const allLines = result.candidates.flatMap((c) => c.lines);
    expect(allLines.find((l) => l.batchId === 'B-EPI-02')).toBeUndefined();
  });
});

describe('规定场景 C：同一批次争用', () => {
  it('中心仓硝酸甘油仅 100 片，A 与 C 同日缺口，按优先级分配且不超发', () => {
    const data = planning();
    const gapA = simulate(
      buildSimInput(data, 'S-A', 'DRG-002', DEMO_START, HORIZON, 'withDrafts'),
    );
    const gapC = simulate(
      buildSimInput(data, 'S-C', 'DRG-002', DEMO_START, HORIZON, 'withDrafts'),
    );
    expect(gapA.firstGapDate).toBe(gapC.firstGapDate);
    const result = generateCandidates(
      data,
      demoSites,
      { siteIds: SELECTED, startDate: DEMO_START, horizonDays: HORIZON },
    );
    const ntg = result.candidates.filter((c) => c.drugCode === 'DRG-002');
    // 同一批次 B-NTG-01 被两个接收点争用，总分配不得超过 100 片
    const totalOnBatch = ntg
      .flatMap((c) => c.lines)
      .filter((l) => l.batchId === 'B-NTG-01')
      .reduce((s, l) => s + l.qtyMin, 0);
    expect(totalOnBatch).toBeLessThanOrEqual(100);
    // A 优先级（2）高于 C（3），A 先获得分配
    const toA = ntg.find((c) => c.toSiteId === 'S-A');
    const toC = ntg.find((c) => c.toSiteId === 'S-C');
    expect(toA).toBeDefined();
    if (toA && toC) {
      expect(toA.lines[0].qtyMin).toBeGreaterThanOrEqual(toC.qtyMin);
    }
  });
});

describe('占用与来源安全规则', () => {
  it('批准未出库占用来源余额，候选不重复许诺 T-1002 的 20 支', () => {
    const data = planning();
    const result = generateCandidates(
      data,
      demoSites,
      { siteIds: SELECTED, startDate: DEMO_START, horizonDays: HORIZON },
    );
    const onEpi03 = result.candidates
      .flatMap((c) => c.lines)
      .filter((l) => l.batchId === 'B-EPI-03')
      .reduce((s, l) => s + l.qtyMin, 0);
    // B-EPI-03 期初 120 支，T-1002 已批准占用 20 → 候选最多再动 100
    expect(onEpi03).toBeLessThanOrEqual(100);
  });

  it('缺需求资料的驻点 D 不会被当成富余来源，也不产生缺口分析', () => {
    const data = planning();
    const result = generateCandidates(
      data,
      demoSites,
      { siteIds: [...SELECTED, 'S-D'], startDate: DEMO_START, horizonDays: HORIZON },
    );
    expect(result.candidates.every((c) => c.fromSiteId !== 'S-D')).toBe(true);
    expect(result.infeasible.every((i) => i.siteId !== 'S-D')).toBe(true);
  });

  it('送出后来源新增缺口被量化输出', () => {
    const data = planning();
    const result = generateCandidates(
      data,
      demoSites,
      { siteIds: SELECTED, startDate: DEMO_START, horizonDays: HORIZON },
    );
    const fromA = result.candidates.filter((c) => c.fromSiteId === 'S-A');
    // A 的葡萄糖酸钙被用于支援 C 时，应展示来源端后果
    const cal = fromA.find((c) => c.drugCode === 'DRG-003');
    if (cal) {
      expect(cal.sourceNewShortageMin).toBeGreaterThan(0);
      expect(cal.sourceNewGapDate).not.toBeNull();
    }
  });
});
