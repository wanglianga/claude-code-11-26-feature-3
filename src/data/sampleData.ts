import { toMinUnits } from '../domain/units';
import type {
  Batch,
  DemandDeclaration,
  DomainEvent,
  Drug,
  MissingConversionItem,
  PackageSpec,
  ScheduledInbound,
  Site,
  TransferOrder,
} from '../domain/types';

/**
 * 固定演示数据（不接真实医疗系统）：
 * - 药品编码、规格、批次、每日演示消耗、库存事件、运输时间均为静态声明；
 * - 批次以包装单位录入，启动时按显式包装关系换算为最小库存单位；
 * - 缺换算资料的条目单独返回，不参与任何推演。
 *
 * 场景覆盖：
 *   A. 有货但来不及：远端医疗点 B 的肾上腺素首缺口 11-18，中心仓运输 6 天；
 *   B. 到货后先过期：B 的供应商到货批次 11-22 到、11-25 即到期；
 *      中心仓近效期批次 B-EPI-02 不满足任何接收点最低剩余效期；
 *   C. 同一批次争用：硝酸甘油中心仓仅 100 片，A 与 C 同日缺口，按优先级逐次分配；
 *   另含在途单 T-1001、批准未出库 T-1002、部分签收 T-1003、无需求资料驻点 D。
 */

export const DEMO_START = '2026-11-15';

export const demoDrugs: Drug[] = [
  { code: 'DRG-001', name: '盐酸肾上腺素注射液', spec: '1mg:1ml', category: '急救' },
  { code: 'DRG-002', name: '硝酸甘油片', spec: '0.5mg', category: '急救' },
  { code: 'DRG-003', name: '葡萄糖酸钙注射液', spec: '10ml:1g', category: '急救' },
  { code: 'DRG-004', name: '生理氯化钠溶液', spec: '500ml', category: '输液' },
  { code: 'DRG-005', name: '碘伏消毒液', spec: '500ml', category: '消毒' },
];

export const demoPackageSpecs: PackageSpec[] = [
  { drugCode: 'DRG-001', packUnit: '盒', minUnit: '支', unitsPerPack: 10 },
  { drugCode: 'DRG-002', packUnit: '瓶', minUnit: '片', unitsPerPack: 100 },
  { drugCode: 'DRG-003', packUnit: '盒', minUnit: '支', unitsPerPack: 5 },
  { drugCode: 'DRG-004', packUnit: '箱', minUnit: '袋', unitsPerPack: 30 },
  // DRG-005 故意不提供包装关系：相关库存进入「缺换算资料」清单
];

export const demoSites: Site[] = [
  {
    id: 'S-CENTRAL',
    name: '区域中心仓',
    kind: 'central',
    priority: 1,
    minRemainingDays: 7,
    allowAsSource: true,
    demandDeclared: true,
  },
  {
    id: 'S-A',
    name: '近郊急救站 A',
    kind: 'district',
    priority: 2,
    minRemainingDays: 14,
    allowAsSource: true,
    demandDeclared: true,
  },
  {
    id: 'S-B',
    name: '远端医疗点 B',
    kind: 'station',
    priority: 2,
    minRemainingDays: 30,
    allowAsSource: false,
    demandDeclared: true,
  },
  {
    id: 'S-C',
    name: '社区卫生点 C',
    kind: 'station',
    priority: 3,
    minRemainingDays: 14,
    allowAsSource: false,
    demandDeclared: true,
  },
  {
    id: 'S-D',
    name: '野外驻点 D（需求资料缺失）',
    kind: 'field',
    priority: 4,
    minRemainingDays: 14,
    allowAsSource: false,
    demandDeclared: false,
  },
];

/** 运输时间矩阵（天）；未声明的路线视为无运输资料 */
export const demoTransport: Record<string, number> = {
  'S-CENTRAL->S-A': 2,
  'S-CENTRAL->S-B': 6,
  'S-CENTRAL->S-C': 4,
  'S-CENTRAL->S-D': 3,
  'S-A->S-C': 2,
  'S-A->S-B': 5,
};

/** 以包装单位录入的批次种子（qtyPack 为包装数） */
interface RawBatchSeed {
  id: string;
  drugCode: string;
  siteId: string;
  expiry: string;
  qtyPack: number;
  note?: string;
}

const rawBatches: RawBatchSeed[] = [
  // 肾上腺素（支）：中心仓三批次，含近效期 B-EPI-02
  { id: 'B-EPI-01', drugCode: 'DRG-001', siteId: 'S-CENTRAL', expiry: '2026-12-31', qtyPack: 20 },
  { id: 'B-EPI-02', drugCode: 'DRG-001', siteId: 'S-CENTRAL', expiry: '2026-11-20', qtyPack: 6 },
  { id: 'B-EPI-03', drugCode: 'DRG-001', siteId: 'S-CENTRAL', expiry: '2027-03-31', qtyPack: 12 },
  { id: 'B-EPI-A1', drugCode: 'DRG-001', siteId: 'S-A', expiry: '2027-01-31', qtyPack: 4 },
  { id: 'B-EPI-B1', drugCode: 'DRG-001', siteId: 'S-B', expiry: '2027-02-28', qtyPack: 2.4 },
  { id: 'B-EPI-C1', drugCode: 'DRG-001', siteId: 'S-C', expiry: '2027-05-31', qtyPack: 3 },
  { id: 'B-EPI-D1', drugCode: 'DRG-001', siteId: 'S-D', expiry: '2027-01-15', qtyPack: 5 },

  // 硝酸甘油（片）：中心仓仅 1 瓶，制造同批争用
  { id: 'B-NTG-01', drugCode: 'DRG-002', siteId: 'S-CENTRAL', expiry: '2027-08-31', qtyPack: 1 },
  { id: 'B-NTG-A1', drugCode: 'DRG-002', siteId: 'S-A', expiry: '2027-07-31', qtyPack: 0.2 },
  { id: 'B-NTG-C1', drugCode: 'DRG-002', siteId: 'S-C', expiry: '2027-07-31', qtyPack: 0.2 },
  { id: 'B-NTG-B1', drugCode: 'DRG-002', siteId: 'S-B', expiry: '2027-07-31', qtyPack: 0.1 },

  // 葡萄糖酸钙（支）：A 可作为来源，调出后自身将出现新增缺口
  // B-CAL-01 中心仓 100 支中已有 10 支随 T-1003 出库 → 正式库存 90 支；
  // 其中 4 支已签收进入 A（同批次跨站点行），1 支破损、2 支待查、3 支仍在途
  { id: 'B-CAL-01', drugCode: 'DRG-003', siteId: 'S-CENTRAL', expiry: '2027-09-30', qtyPack: 18 },
  { id: 'B-CAL-01', drugCode: 'DRG-003', siteId: 'S-A', expiry: '2027-09-30', qtyPack: 0.8 },
  { id: 'B-CAL-A1', drugCode: 'DRG-003', siteId: 'S-A', expiry: '2027-04-30', qtyPack: 10 },
  { id: 'B-CAL-C1', drugCode: 'DRG-003', siteId: 'S-C', expiry: '2027-04-30', qtyPack: 1 },

  // 生理盐水（袋）
  { id: 'B-NS-01', drugCode: 'DRG-004', siteId: 'S-CENTRAL', expiry: '2028-01-31', qtyPack: 10 },
  { id: 'B-NS-A1', drugCode: 'DRG-004', siteId: 'S-A', expiry: '2028-01-31', qtyPack: 1 },
];

/** 缺换算资料条目：分开显示，禁止推断 */
const rawMissing: Omit<MissingConversionItem, 'id'>[] = [
  {
    siteId: 'S-D',
    drugCode: 'DRG-005',
    rawLabel: '碘伏消毒液 2 桶（未声明桶与瓶/毫升换算关系）',
    packQty: 2,
    note: '无包装换算资料，不纳入库存推演与调拨候选',
  },
  {
    siteId: 'S-B',
    drugCode: 'DRG-005',
    rawLabel: '碘伏消毒液 1 散装容器（规格登记缺失）',
    packQty: 1,
    note: '无包装换算资料，不纳入库存推演与调拨候选',
  },
];

export const demoDemands: DemandDeclaration[] = [
  // 肾上腺素 支/日
  { siteId: 'S-CENTRAL', drugCode: 'DRG-001', dailyMin: 2 },
  { siteId: 'S-A', drugCode: 'DRG-001', dailyMin: 6 },
  { siteId: 'S-B', drugCode: 'DRG-001', dailyMin: 8 },
  { siteId: 'S-C', drugCode: 'DRG-001', dailyMin: 4 },
  // S-D 故意无需求声明
  // 硝酸甘油 片/日
  { siteId: 'S-CENTRAL', drugCode: 'DRG-002', dailyMin: 5 },
  { siteId: 'S-A', drugCode: 'DRG-002', dailyMin: 10 },
  { siteId: 'S-B', drugCode: 'DRG-002', dailyMin: 10 },
  { siteId: 'S-C', drugCode: 'DRG-002', dailyMin: 10 },
  // 葡萄糖酸钙 支/日
  { siteId: 'S-CENTRAL', drugCode: 'DRG-003', dailyMin: 1 },
  { siteId: 'S-A', drugCode: 'DRG-003', dailyMin: 4 },
  { siteId: 'S-C', drugCode: 'DRG-003', dailyMin: 2 },
  // 生理盐水 袋/日
  { siteId: 'S-CENTRAL', drugCode: 'DRG-004', dailyMin: 2 },
  { siteId: 'S-A', drugCode: 'DRG-004', dailyMin: 3 },
  { siteId: 'S-B', drugCode: 'DRG-004', dailyMin: 4 },
  { siteId: 'S-C', drugCode: 'DRG-004', dailyMin: 2 },
];

/** 供应商计划到货 */
export const demoInbounds: ScheduledInbound[] = [
  {
    id: 'IB-01',
    drugCode: 'DRG-001',
    batchId: 'B-EPI-S1',
    batchExpiry: '2026-11-25',
    siteId: 'S-B',
    qtyMin: 40,
    arriveDate: '2026-11-22',
    note: '场景B：到货后先过期（40 支，3 天后到期，B 日耗 8 支）',
  },
  {
    id: 'IB-02',
    drugCode: 'DRG-003',
    batchId: 'B-CAL-S2',
    batchExpiry: '2027-10-31',
    siteId: 'S-C',
    qtyMin: 20,
    arriveDate: '2026-11-25',
  },
  {
    id: 'IB-03',
    drugCode: 'DRG-004',
    batchId: 'B-NS-S3',
    batchExpiry: '2028-06-30',
    siteId: 'S-B',
    qtyMin: 60,
    arriveDate: '2026-11-24',
  },
];

/** 预置调拨单：在途 / 批准未出库 / 部分签收 */
export function demoTransfers(): TransferOrder[] {
  return [
    {
      id: 'T-1001',
      fromSiteId: 'S-CENTRAL',
      toSiteId: 'S-A',
      drugCode: 'DRG-001',
      plannedShipDate: '2026-11-13',
      shipDate: '2026-11-13',
      arriveDate: '2026-11-17',
      status: 'shipped',
      locked: false,
      basis: '例行补给（在途，已扣中心仓正式库存，计 A 未来到货）',
      lines: [
        {
          batchId: 'B-EPI-T1',
          drugCode: 'DRG-001',
          expiry: '2027-06-30',
          qtyApprovedMin: 30,
          receivedMin: 0,
          damagedMin: 0,
          quarantineMin: 0,
        },
      ],
      returns: [],
    },
    {
      id: 'T-1002',
      fromSiteId: 'S-CENTRAL',
      toSiteId: 'S-C',
      drugCode: 'DRG-001',
      plannedShipDate: '2026-11-16',
      shipDate: null,
      arriveDate: '2026-11-20',
      status: 'approved',
      locked: false,
      basis: '批准未出库：占用中心仓 B-EPI-03 20 支，尚不计 C 的未来库存',
      lines: [
        {
          batchId: 'B-EPI-03',
          drugCode: 'DRG-001',
          expiry: '2027-03-31',
          qtyApprovedMin: 20,
          receivedMin: 0,
          damagedMin: 0,
          quarantineMin: 0,
        },
      ],
      returns: [],
    },
    {
      id: 'T-1003',
      fromSiteId: 'S-CENTRAL',
      toSiteId: 'S-A',
      drugCode: 'DRG-003',
      plannedShipDate: '2026-11-12',
      shipDate: '2026-11-12',
      arriveDate: '2026-11-16',
      status: 'partially_received',
      locked: false,
      basis: '部分签收：4 支入库、1 支破损、2 支待查，余 3 支仍在途',
      lines: [
        {
          batchId: 'B-CAL-01',
          drugCode: 'DRG-003',
          expiry: '2027-09-30',
          qtyApprovedMin: 10,
          receivedMin: 4,
          damagedMin: 1,
          quarantineMin: 2,
        },
      ],
      returns: [],
    },
  ];
}

export function demoEvents(): DomainEvent[] {
  return [
    {
      id: 'EV-0001',
      type: 'transfer.confirmed',
      at: '2026-11-11',
      orders: [],
      note: 'T-1001/T-1002/T-1003 审批流（演示种子，orders 详情见调拨单台账）',
    },
    {
      id: 'EV-0002',
      type: 'transfer.shipped',
      at: '2026-11-12',
      transferId: 'T-1003',
      shipDate: '2026-11-12',
    },
    {
      id: 'EV-0003',
      type: 'transfer.shipped',
      at: '2026-11-13',
      transferId: 'T-1001',
      shipDate: '2026-11-13',
    },
    {
      id: 'EV-0004',
      type: 'transfer.received',
      at: '2026-11-16',
      transferId: 'T-1003',
      lines: [
        { batchId: 'B-CAL-01', receivedMin: 4, damagedMin: 1, quarantineMin: 2 },
      ],
      note: '逐批签收：实收+破损+待查=7，剩余 3 支继续在途',
    },
  ];
}

export interface DemoAccount {
  username: string;
  password: string;
  displayName: string;
  role: 'planner' | 'viewer';
}

export const demoAccounts: DemoAccount[] = [
  { username: 'planner', password: 'demo1234', displayName: '保障计划员（演示）', role: 'planner' },
  { username: 'viewer', password: 'view1234', displayName: '只读观察员（演示）', role: 'viewer' },
];

export interface DemoData {
  batches: Batch[];
  missingConversions: MissingConversionItem[];
  transfers: TransferOrder[];
  events: DomainEvent[];
}

/** 启动时一次性换算：包装单位 → 最小库存单位；缺资料条目分流 */
export function createDemoData(): DemoData {
  const batches: Batch[] = [];
  const missingConversions: MissingConversionItem[] = [];
  rawBatches.forEach((rb, idx) => {
    const qtyMin = toMinUnits(rb.drugCode, rb.qtyPack, demoPackageSpecs);
    if (qtyMin === null) {
      missingConversions.push({
        id: `MC-${idx + 1}`,
        siteId: rb.siteId,
        drugCode: rb.drugCode,
        rawLabel: `${rb.qtyPack} 个未登记包装（批次 ${rb.id}）`,
        packQty: rb.qtyPack,
        note: '无包装换算资料，不纳入库存推演与调拨候选',
      });
      return;
    }
    batches.push({
      id: rb.id,
      drugCode: rb.drugCode,
      siteId: rb.siteId,
      expiry: rb.expiry,
      qtyMin,
    });
  });
  rawMissing.forEach((m, idx) => {
    missingConversions.push({ id: `MC-RAW-${idx + 1}`, ...m });
  });
  return {
    batches,
    missingConversions,
    transfers: demoTransfers(),
    events: demoEvents(),
  };
}
