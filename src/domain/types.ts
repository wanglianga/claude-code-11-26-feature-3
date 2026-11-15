// 领域模型类型：所有数量除特别说明外均为「最小库存单位」（支/袋/瓶）

export type ISODate = string; // YYYY-MM-DD

/** 固定药品编码目录（演示数据，不接真实医疗系统） */
export interface Drug {
  code: string;
  name: string;
  spec: string;
  category: string;
}

/** 包装关系：1 个包装单位 = unitsPerPack 个最小单位 */
export interface PackageSpec {
  drugCode: string;
  packUnit: string;
  minUnit: string;
  unitsPerPack: number;
}

/** 缺少换算资料的库存条目：分开显示，禁止推断 */
export interface MissingConversionItem {
  id: string;
  siteId: string;
  drugCode: string;
  rawLabel: string;
  packQty: number;
  note: string;
}

export type SiteKind = 'central' | 'district' | 'station' | 'field';

export interface Site {
  id: string;
  name: string;
  kind: SiteKind;
  /** 声明的保障优先级，数字越小优先级越高 */
  priority: number;
  /** 接收点要求的最低剩余效期（天），到货日 + 该天数 <= 批次效期方可接收 */
  minRemainingDays: number;
  /** 是否允许作为调拨来源（中心仓显式声明） */
  allowAsSource: boolean;
  /** 是否具备已声明需求资料；缺资料的点不能自动当成富余仓 */
  demandDeclared: boolean;
}

/** 批次库存（正式库存快照中的一条） */
export interface Batch {
  id: string;
  drugCode: string;
  siteId: string;
  expiry: ISODate;
  qtyMin: number;
}

/** 已声明的每日演示消耗（最小单位/日） */
export interface DemandDeclaration {
  siteId: string;
  drugCode: string;
  dailyMin: number;
}

/** 计划中的供应商到货事件 */
export interface ScheduledInbound {
  id: string;
  drugCode: string;
  batchId: string;
  batchExpiry: ISODate;
  siteId: string;
  qtyMin: number;
  arriveDate: ISODate;
  note?: string;
}

// ---------- 调拨单生命周期 ----------

export type TransferStatus =
  | 'draft' // 草稿：仅试算占用，未写正式库存
  | 'approved' // 已批准未出库：占用来源余额
  | 'shipped' // 在途：已转为接收点未来库存
  | 'partially_received' // 部分签收，余量待查/在途
  | 'received' // 全部签收完成
  | 'cancelled'; // 未发取消（已发部分须走回程）

export interface TransferLine {
  batchId: string;
  drugCode: string;
  /** 行自带效期，签收/到货校验不依赖来源批次行是否仍保留 */
  expiry: ISODate;
  qtyApprovedMin: number;
  receivedMin: number;
  damagedMin: number;
  quarantineMin: number; // 待查（少到部分停留于此，不直接退回来源可用）
}

export interface ReturnShipment {
  id: string;
  batchId: string;
  qtyMin: number;
  shipDate: ISODate;
  arriveDate: ISODate;
  received: boolean;
}

export interface TransferOrder {
  id: string;
  fromSiteId: string;
  toSiteId: string;
  drugCode: string;
  plannedShipDate: ISODate;
  shipDate: ISODate | null;
  arriveDate: ISODate;
  status: TransferStatus;
  lines: TransferLine[];
  /** 用户锁定：重算时保留，冲突须保留原因 */
  locked: boolean;
  conflictReason?: string;
  /** 由哪个候选生成（用于去重与追踪） */
  candidateId?: string;
  /** 盘点后未确认建议失效 */
  invalid?: boolean;
  /** 盘点后已批准安排列待复核，不静默改数量 */
  reviewRequired?: boolean;
  basis: string;
  returns: ReturnShipment[];
}

// ---------- 事件日志（本地适配器，append-only） ----------

export type DomainEventType =
  | 'transfer.confirmed'
  | 'transfer.shipped'
  | 'transfer.received'
  | 'transfer.cancelled'
  | 'transfer.returned'
  | 'transfer.return-received'
  | 'stocktake.adjusted';

export interface ReceiveLineInput {
  batchId: string;
  receivedMin: number;
  damagedMin: number;
  quarantineMin: number;
}

export type DomainEvent = {
  id: string;
  type: DomainEventType;
  at: ISODate;
  note?: string;
} & (
  | { type: 'transfer.confirmed'; orders: TransferOrder[] }
  | { type: 'transfer.shipped'; transferId: string; shipDate: ISODate }
  | {
      type: 'transfer.received';
      transferId: string;
      lines: ReceiveLineInput[];
    }
  | { type: 'transfer.cancelled'; transferId: string }
  | {
      type: 'transfer.returned';
      transferId: string;
      batchId: string;
      qtyMin: number;
      shipDate: ISODate;
      arriveDate: ISODate;
    }
  | { type: 'transfer.return-received'; transferId: string; returnId: string }
  | {
      type: 'stocktake.adjusted';
      siteId: string;
      adjustments: { batchId: string; newQtyMin: number }[];
    }
);

export interface RejectedEvent {
  eventId: string;
  reason: string;
}

// ---------- 推演结果 ----------

export interface BatchTick {
  batchId: string;
  expiry: ISODate;
  openMin: number;
  expiredMin: number;
  receivedInMin: number;
  removedOutMin: number;
  consumedMin: number;
  closeMin: number;
}

export interface DayTick {
  date: ISODate;
  demandMin: number;
  satisfiedMin: number;
  shortageMin: number;
  expiredMin: number;
  arrivalMin: number;
  openTotalMin: number;
  closeTotalMin: number;
  batches: BatchTick[];
}

export interface SimulationResult {
  siteId: string;
  drugCode: string;
  ticks: DayTick[];
  totalDemandMin: number;
  totalSatisfiedMin: number;
  totalShortageMin: number;
  totalExpiredMin: number;
  totalArrivalMin: number;
  /** 首个缺货日（无则 null） */
  firstGapDate: ISODate | null;
  /** 缺货日期列表 */
  gapDates: ISODate[];
}

/** 一次到货（用于推演输入装配） */
export interface PlannedArrival {
  key: string;
  batchId: string;
  batchExpiry: ISODate;
  qtyMin: number;
  arriveDate: ISODate;
  kind: 'supplier' | 'transfer' | 'return';
  refId: string;
}

// ---------- 调拨候选 ----------

export interface CandidateLine {
  batchId: string;
  expiry: ISODate;
  qtyMin: number;
}

export interface InfeasibleNote {
  reason: string;
  detail: string;
}

export interface AllocationCandidate {
  id: string;
  drugCode: string;
  fromSiteId: string;
  toSiteId: string;
  /** 针对的缺口日期 */
  gapDate: ISODate;
  latestArriveDate: ISODate;
  plannedShipDate: ISODate;
  arriveDate: ISODate;
  lines: CandidateLine[];
  qtyMin: number;
  /** 来源同一时间范围内的保留需求（最小单位） */
  sourceReserveMin: number;
  sourceFreeBeforeMin: number;
  /** 运输成本（数量 × 运输天数） */
  transportCost: number;
  /** 报废风险量：不动用时来源将在视窗内过期的同批数量 */
  wasteRiskMin: number;
  /** 送出后来源自身出现的首个新增缺口日（无则 null） */
  sourceNewGapDate: ISODate | null;
  /** 送出后来源在视窗内新增缺货总量 */
  sourceNewShortageMin: number;
  reasons: string[];
  infeasible?: InfeasibleNote[];
}

export interface GapKey {
  siteId: string;
  drugCode: string;
}
