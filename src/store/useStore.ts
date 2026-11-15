import { create } from 'zustand';
import {
  applyEvent,
  defaultReturnArrive,
  type AdapterState,
} from '../adapters/localEventAdapter';
import { generateCandidates } from '../domain/candidates';
import { addDays } from '../domain/date';
import {
  openingBatchesFor,
  routeKey,
  type PlanningData,
} from '../domain/projection';
import {
  createDemoData,
  demoAccounts,
  demoDemands,
  demoDrugs,
  demoInbounds,
  demoPackageSpecs,
  demoSites,
  demoTransport,
  DEMO_START,
  type DemoAccount,
} from '../data/sampleData';
import {
  coldCalibrationRevisions,
  coldLateReading,
  coldShipments,
} from '../data/coldChainData';
import {
  createInitialColdState,
  latestCheck,
  type ColdState,
} from './coldChainState';
import { buildCheck, type ColdCheck, type ColdDisposition } from '../domain/coldchain';
import type {
  AllocationCandidate,
  Batch,
  DomainEvent,
  MissingConversionItem,
  ReceiveLineInput,
  RejectedEvent,
  TransferOrder,
} from '../domain/types';

interface AuthUser {
  username: string;
  displayName: string;
  role: DemoAccount['role'];
}

interface AppState {
  // 认证
  user: AuthUser | null;
  loginError: string | null;
  // 静态参考数据
  drugs: typeof demoDrugs;
  packageSpecs: typeof demoPackageSpecs;
  sites: typeof demoSites;
  transport: Record<string, number>;
  inbounds: typeof demoInbounds;
  demands: typeof demoDemands;
  missingConversions: MissingConversionItem[];
  // 适配器状态（正式库存 + 调拨台账 + 事件日志）
  batches: Batch[];
  transfers: TransferOrder[];
  events: DomainEvent[];
  rejected: RejectedEvent[];
  // 分析参数
  startDate: string;
  horizonDays: number;
  selectedSiteIds: string[];
  // 交互
  expandedKeys: Set<string>;
  seq: number;
  notice: string | null;

  login: (username: string, password: string) => boolean;
  logout: () => void;
  setStartDate: (d: string) => void;
  setHorizon: (n: number) => void;
  toggleSite: (id: string) => void;
  toggleExpanded: (key: string) => void;
  clearNotice: () => void;

  planningData: () => PlanningData;
  buildCandidates: () => ReturnType<typeof generateCandidates>;

  addCandidateToDraft: (c: AllocationCandidate) => void;
  removeDraft: (id: string) => void;
  toggleLock: (id: string) => void;
  recalc: () => void;
  confirmDrafts: (ids: string[]) => void;
  shipOrder: (id: string) => void;
  receiveOrder: (id: string, lines: ReceiveLineInput[]) => void;
  cancelOrder: (id: string) => void;
  registerReturn: (transferId: string, batchId: string, qty: number) => void;
  receiveReturn: (transferId: string, returnId: string) => void;
  stocktake: (siteId: string, adjustments: { batchId: string; newQtyMin: number }[]) => void;
  resetDemo: () => void;

  // 冷链运输核查
  coldReadings: ColdState['coldReadings'];
  coldChecks: ColdState['coldChecks'];
  coldCheckSeq: ColdState['coldCheckSeq'];
  coldDispositions: ColdState['coldDispositions'];
  coldQuarantine: ColdState['coldQuarantine'];
  lateInserted: boolean;
  calibrationApplied: boolean;
  /** 插入固定迟报读数：对 CC-2001 生成新检查，未知区间缩小 */
  insertLateReading: () => void;
  /** 应用固定校准修订：对 CC-2002 生成新检查，触发受影响运输重新核验 */
  applyCalibration: () => void;
  /** 冷链处置：release=批准进入可用余量；quarantine=继续隔离。已批准处置保留原记录 */
  decideColdDisposition: (shipmentId: string, decision: 'quarantine' | 'release') => void;
}

const demo = createDemoData();
const cold0 = createInitialColdState();

function nextId(seq: number, prefix: string): { id: string; seq: number } {
  return { id: `${prefix}-${2000 + seq}`, seq: seq + 1 };
}

function currentAdapter(s: AppState): AdapterState {
  return { batches: s.batches, transfers: s.transfers, events: s.events };
}

export const useStore = create<AppState>((set, get) => ({
  user: null,
  loginError: null,
  drugs: demoDrugs,
  packageSpecs: demoPackageSpecs,
  sites: demoSites,
  transport: demoTransport,
  inbounds: demoInbounds,
  demands: demoDemands,
  missingConversions: demo.missingConversions,
  batches: demo.batches,
  transfers: demo.transfers,
  events: demo.events,
  rejected: [],
  startDate: DEMO_START,
  horizonDays: 30,
  selectedSiteIds: ['S-CENTRAL', 'S-A', 'S-B', 'S-C'],
  expandedKeys: new Set<string>(),
  seq: 1,
  notice: null,

  // 冷链核查初始切片（固定文件 + 初始检查；隔离行暂不进正式库存）
  coldReadings: cold0.coldReadings,
  coldChecks: cold0.coldChecks,
  coldCheckSeq: cold0.coldCheckSeq,
  coldDispositions: cold0.coldDispositions,
  coldQuarantine: cold0.coldQuarantine,
  lateInserted: cold0.lateInserted,
  calibrationApplied: cold0.calibrationApplied,

  login: (username, password) => {
    const acc = demoAccounts.find(
      (a) => a.username === username && a.password === password,
    );
    if (!acc) {
      set({ loginError: '账号或密码错误（演示账号见 README）' });
      return false;
    }
    set({
      user: { username: acc.username, displayName: acc.displayName, role: acc.role },
      loginError: null,
    });
    return true;
  },
  logout: () => set({ user: null }),

  setStartDate: (d) => set({ startDate: d }),
  setHorizon: (n) => set({ horizonDays: Math.min(90, Math.max(7, n)) }),
  toggleSite: (id) =>
    set((s) => ({
      selectedSiteIds: s.selectedSiteIds.includes(id)
        ? s.selectedSiteIds.filter((x) => x !== id)
        : [...s.selectedSiteIds, id],
    })),
  toggleExpanded: (key) =>
    set((s) => {
      const next = new Set(s.expandedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { expandedKeys: next };
    }),
  clearNotice: () => set({ notice: null, rejected: [] }),

  planningData: () => {
    const s = get();
    return {
      batches: s.batches,
      demands: s.demands,
      inbounds: s.inbounds,
      transfers: s.transfers,
      transport: s.transport,
    };
  },

  buildCandidates: () => {
    const s = get();
    return generateCandidates(s.planningData(), s.sites, {
      siteIds: s.selectedSiteIds,
      startDate: s.startDate,
      horizonDays: s.horizonDays,
    });
  },

  addCandidateToDraft: (c) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能编辑草稿' });
      return;
    }
    if (s.transfers.some((t) => t.candidateId === c.id && t.status === 'draft')) {
      set({ notice: '该候选已在草稿中，不重复加入' });
      return;
    }
    const { id, seq } = nextId(s.seq, 'T');
    const order: TransferOrder = {
      id,
      candidateId: c.id,
      fromSiteId: c.fromSiteId,
      toSiteId: c.toSiteId,
      drugCode: c.drugCode,
      plannedShipDate: c.plannedShipDate,
      shipDate: null,
      arriveDate: c.arriveDate,
      status: 'draft',
      locked: false,
      basis: `候选 ${c.id}：覆盖 ${c.toSiteId} 缺口日 ${c.gapDate}（最晚到货 ${c.latestArriveDate}）`,
      lines: c.lines.map((l) => ({
        batchId: l.batchId,
        drugCode: c.drugCode,
        expiry: l.expiry,
        qtyApprovedMin: l.qtyMin,
        receivedMin: 0,
        damagedMin: 0,
        quarantineMin: 0,
      })),
      returns: [],
    };
    set({ transfers: [...s.transfers, order], seq, notice: `候选 ${c.id} 已加入草稿（试算占用，未写正式库存）` });
  },

  removeDraft: (id) =>
    set((s) => ({
      transfers: s.transfers.filter((t) => t.id !== id),
      notice: `草稿 ${id} 已移除`,
    })),

  toggleLock: (id) =>
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id ? { ...t, locked: !t.locked, conflictReason: t.locked ? t.conflictReason : undefined } : t,
      ),
    })),

  recalc: () => {
    const s = get();
    // 重算：锁定项保留；依据当前正式库存复核锁定草稿的真实余量，冲突保留原因
    const data = s.planningData();
    const transfers = s.transfers.map((t) => {
      if (t.status !== 'draft' || !t.locked) return t;
      const reasons: string[] = [];
      for (const line of t.lines) {
        const opening = openingBatchesFor(data, t.fromSiteId, line.drugCode).find(
          (b) => b.batchId === line.batchId,
        );
        const committedByOtherDrafts = s.transfers
          .filter((o) => o.id !== t.id && o.status === 'draft' && !o.invalid)
          .flatMap((o) => o.lines)
          .filter((l) => l.batchId === line.batchId)
          .reduce((sum, l) => sum + l.qtyApprovedMin, 0);
        const free = (opening?.qtyMin ?? 0) - committedByOtherDrafts;
        if (line.qtyApprovedMin > free) {
          reasons.push(
            `锁定批次 ${line.batchId} 需 ${line.qtyApprovedMin}，重算后真实余量仅 ${Math.max(0, free)}`,
          );
        }
      }
      return { ...t, conflictReason: reasons.length ? reasons.join('；') : undefined };
    });
    set({
      transfers,
      notice: '已按当前正式库存与占用重算候选；锁定调拨保留，冲突原因已标注',
    });
  },

  confirmDrafts: (ids) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能确认调拨' });
      return;
    }
    const orders = s.transfers.filter((t) => ids.includes(t.id));
    const { id, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id,
      type: 'transfer.confirmed',
      at: s.startDate,
      orders,
      note: '整组审批确认：任一单据预检失败则全部退回，试算不直接修改正式库存',
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `确认被整组退回：${result.rejected.map((r) => r.reason).join('；')}`
        : `已批准 ${orders.length} 张调拨单（批准未出库，继续占用来源余额）`,
    });
  },

  shipOrder: (id) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能出库' });
      return;
    }
    const order = s.transfers.find((t) => t.id === id);
    if (!order) return;
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.shipped',
      at: s.startDate,
      transferId: id,
      shipDate: s.startDate,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `出库失败：${result.rejected.map((r) => r.reason).join('；')}`
        : `${id} 已出库在途：批准占用转为在途，来源余额只扣一次，预计 ${order.arriveDate} 到货`,
    });
  },

  receiveOrder: (id, lines) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能签收' });
      return;
    }
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.received',
      at: s.startDate,
      transferId: id,
      lines,
      note: '逐批签收：实收+破损+待查须等于本次发出',
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `签收整组退回：${result.rejected.map((r) => r.reason).join('；')}`
        : `${id} 签收完成；少到部分停留待查/在途，未直接退回来源可用`,
    });
  },

  cancelOrder: (id) => {
    const s = get();
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.cancelled',
      at: s.startDate,
      transferId: id,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `取消被拒：${result.rejected.map((r) => r.reason).join('；')}`
        : `${id} 已取消：仅释放未发部分；已发退回请登记回程`,
    });
  },

  registerReturn: (transferId, batchId, qty) => {
    const s = get();
    const order = s.transfers.find((t) => t.id === transferId);
    if (!order) return;
    const route = s.transport[routeKey(order.fromSiteId, order.toSiteId)] ?? null;
    const shipDate = s.startDate;
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.returned',
      at: shipDate,
      transferId,
      batchId,
      qtyMin: qty,
      shipDate,
      arriveDate: defaultReturnArrive(shipDate, route),
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `回程登记失败：${result.rejected.map((r) => r.reason).join('；')}`
        : `回程已登记，预计 ${ev.arriveDate} 回到来源；到达前不恢复来源可用`,
    });
  },

  receiveReturn: (transferId, returnId) => {
    const s = get();
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'transfer.return-received',
      at: s.startDate,
      transferId,
      returnId,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice: result.rejected.length
        ? `回程签收失败：${result.rejected.map((r) => r.reason).join('；')}`
        : '回程到货已恢复来源库存（重复签收幂等忽略）',
    });
  },

  stocktake: (siteId, adjustments) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能盘点' });
      return;
    }
    const { id: evId, seq } = nextId(s.seq, 'EV');
    const ev: DomainEvent = {
      id: evId,
      type: 'stocktake.adjusted',
      at: s.startDate,
      siteId,
      adjustments,
    };
    const result = applyEvent(currentAdapter(s), ev);
    set({
      batches: result.state.batches,
      transfers: result.state.transfers,
      events: result.state.events,
      rejected: result.rejected,
      seq,
      notice:
        '盘点已更新：未确认草稿标记失效，已批准/在途安排列待复核，数量未被静默修改',
    });
  },

  resetDemo: () => {
    const fresh = createDemoData();
    const freshCold = createInitialColdState();
    set({
      batches: fresh.batches,
      transfers: fresh.transfers,
      events: fresh.events,
      missingConversions: fresh.missingConversions,
      rejected: [],
      expandedKeys: new Set<string>(),
      seq: 1,
      startDate: DEMO_START,
      horizonDays: 30,
      selectedSiteIds: ['S-CENTRAL', 'S-A', 'S-B', 'S-C'],
      coldReadings: freshCold.coldReadings,
      coldChecks: freshCold.coldChecks,
      coldCheckSeq: freshCold.coldCheckSeq,
      coldDispositions: freshCold.coldDispositions,
      coldQuarantine: freshCold.coldQuarantine,
      lateInserted: false,
      calibrationApplied: false,
      notice: '演示数据已重置（含冷链核查状态）',
    });
  },

  insertLateReading: () => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能插入迟报读数' });
      return;
    }
    if (s.lateInserted) {
      set({ notice: '固定迟报读数已插入，重复插入被忽略（检查任务固定文件）' });
      return;
    }
    const shipment = coldShipments.find((x) => x.id === coldLateReading.shipmentId)!;
    const nextSeq = (s.coldCheckSeq[shipment.id] ?? 1) + 1;
    const readings = [...s.coldReadings, { ...coldLateReading }];
    const check: ColdCheck = buildCheck(
      shipment,
      readings,
      'late-upload',
      nextSeq,
      coldLateReading.receivedAt,
    );
    set({
      coldReadings: readings,
      coldChecks: [...s.coldChecks, check],
      coldCheckSeq: { ...s.coldCheckSeq, [shipment.id]: nextSeq },
      lateInserted: true,
      notice:
        `已插入迟报读数 ${coldLateReading.id} 并生成新检查 ${check.id}：` +
        `未知区间由 120 分钟缩小为 90 分钟，原检查保留不变`,
    });
  },

  applyCalibration: () => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能应用校准修订' });
      return;
    }
    if (s.calibrationApplied) {
      set({ notice: '校准修订已应用，不重复触发（原值与历史检查均保留）' });
      return;
    }
    const shipment = coldShipments.find((x) => x.id === 'CC-2002')!;
    const nextSeq = (s.coldCheckSeq[shipment.id] ?? 1) + 1;
    const readings = [...s.coldReadings, ...coldCalibrationRevisions.map((r) => ({ ...r }))];
    const createdAt = Math.max(...coldCalibrationRevisions.map((r) => r.receivedAt));
    const check: ColdCheck = buildCheck(
      shipment,
      readings,
      'calibration-revision',
      nextSeq,
      createdAt,
    );
    set({
      coldReadings: readings,
      coldChecks: [...s.coldChecks, check],
      coldCheckSeq: { ...s.coldCheckSeq, [shipment.id]: nextSeq },
      calibrationApplied: true,
      notice:
        `已应用 ${coldCalibrationRevisions.length} 条校准修订并触发 ${shipment.id} 重新核验（新检查 ${check.id}）：` +
        `原始读数保留可追溯，结论由待复核转为「${check.result.verdict === 'acceptable' ? '可按流程接收' : '待复核'}」`,
    });
  },

  decideColdDisposition: (shipmentId, decision) => {
    const s = get();
    if (s.user?.role === 'viewer') {
      set({ notice: '只读观察员不能批准冷链处置' });
      return;
    }
    if (s.coldDispositions.some((d) => d.shipmentId === shipmentId)) {
      set({ notice: '该运输已有批准处置，保留原记录；新检查不改变已批准结论' });
      return;
    }
    const check = latestCheck(s.coldChecks, shipmentId);
    if (!check) {
      set({ notice: '该运输尚无检查记录，不能处置' });
      return;
    }
    // 流程闸门：最新检查为待复核时不能直接放行进入可用余量，只能继续隔离
    if (decision === 'release' && check.result.verdict !== 'acceptable') {
      set({
        notice: `${shipmentId} 最新检查 ${check.id} 结论为待复核，不能批准放行；请先完成复核或继续隔离`,
      });
      return;
    }
    const lines = s.coldQuarantine.filter((q) => q.shipmentId === shipmentId);
    const disposition: ColdDisposition = {
      shipmentId,
      checkId: check.id,
      decision,
      decidedAt: check.createdAt + 60_000,
      note:
        decision === 'release'
          ? `依据 ${check.id}（${check.result.verdict === 'acceptable' ? '可按流程接收' : '人工复核后放行'}）批准进入可用余量`
          : `依据 ${check.id} 复核后继续隔离，不进入可用余量、不参与调拨`,
    };

    let batches = s.batches;
    let quarantine = s.coldQuarantine;
    if (decision === 'release') {
      // 批准后才把隔离量写入正式库存（同箱多批次逐批注入，证据时长不重复累计）
      for (const line of lines) {
        const idx = batches.findIndex(
          (b) => b.id === line.batchId && b.siteId === line.siteId,
        );
        if (idx >= 0) {
          batches = batches.map((b, i) =>
            i === idx ? { ...b, qtyMin: b.qtyMin + line.qtyMin } : b,
          );
        } else {
          batches = [
            ...batches,
            {
              id: line.batchId,
              drugCode: line.drugCode,
              siteId: line.siteId,
              expiry: line.expiry,
              qtyMin: line.qtyMin,
            },
          ];
        }
      }
      quarantine = quarantine.map((q) =>
        q.shipmentId === shipmentId ? { ...q, status: 'released' as const } : q,
      );
    } else {
      quarantine = quarantine.map((q) =>
        q.shipmentId === shipmentId ? { ...q, status: 'held' as const } : q,
      );
    }

    set({
      batches,
      coldQuarantine: quarantine,
      coldDispositions: [...s.coldDispositions, disposition],
      notice:
        decision === 'release'
          ? `${shipmentId} 已批准：${lines.length} 个隔离批次进入接收点可用余量（此前不参与任何调拨）`
          : `${shipmentId} 复核后继续隔离：批次不进入可用余量、不参与调拨`,
    });
  },
}));

export function horizonEndDate(startDate: string, horizonDays: number): string {
  return addDays(startDate, horizonDays - 1);
}
