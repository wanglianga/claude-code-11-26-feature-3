/**
 * 冷链核查固定演示资料（不接真实温控/运输系统）：
 *  - 运输任务、箱体-批次对应、交接区间、温度序列、阈值均为静态声明；
 *  - 时间统一用 UTC 毫秒，禁止 Date.now()；
 *  - 场景覆盖：多次开箱、交接换传感器、重复/乱序/同序异值上传、两小时断联、
 *    迟报补传、校准修订、同箱多批次共享证据、重叠数据冲突。
 */
import type {
  ColdShipment,
  ShipmentBox,
  TemperatureReading,
} from '../domain/coldchain';

const MIN = 60_000;

/** 2026-11-15 06:00 UTC：冷链演示时间轴原点 */
export const COLD_BASE = Date.UTC(2026, 10, 15, 6, 0, 0);
const t = (minute: number) => COLD_BASE + minute * MIN;

/** 演示固定阈值与最大可信采样间隔（30 分钟） */
export const COLD_THRESHOLD = { minC: 2, maxC: 8 };
export const MAX_CREDIBLE_GAP = 30 * MIN;

// ---------- 运输任务（固定文件） ----------

export const coldShipments: ColdShipment[] = [
  {
    // 场景 1：多批次同箱、多次开箱、连续越界、两小时断联、重复/乱序/同序异值
    id: 'CC-2001',
    boxId: 'BOX-C1',
    fromSiteId: 'S-CENTRAL',
    toSiteId: 'S-A',
    startAt: t(0), // 06:00
    endAt: t(240), // 10:00
    threshold: COLD_THRESHOLD,
    maxCredibleGapMs: MAX_CREDIBLE_GAP,
    handovers: [
      { id: 'H-C1-1', at: t(60), kind: 'door-open', note: '中转站第一次开箱理货（6 分钟）' },
      { id: 'H-C1-2', at: t(180), kind: 'door-open', note: '第二次开箱（处于断联区间，仅交接记录可读）' },
    ],
  },
  {
    // 场景 2：交接换传感器（重叠读数一致，无冲突）、短时开箱越界、校准修订
    id: 'CC-2002',
    boxId: 'BOX-C2',
    fromSiteId: 'S-CENTRAL',
    toSiteId: 'S-B',
    startAt: t(0),
    endAt: t(120), // 08:00
    threshold: COLD_THRESHOLD,
    maxCredibleGapMs: MAX_CREDIBLE_GAP,
    handovers: [
      {
        id: 'H-C2-1',
        at: t(60), // 07:00 中转换车并更换传感器
        kind: 'sensor-change',
        fromDeviceId: 'D-CC02A',
        toDeviceId: 'D-CC02B',
        note: '中转交接换车：旧传感器 D-CC02A 拆下，新传感器 D-CC02B 启用，重叠 1 个采样点',
      },
    ],
  },
  {
    // 场景 3：交接换传感器且重叠时刻温度不一致 → 重叠数据冲突单列
    id: 'CC-2003',
    boxId: 'BOX-C3',
    fromSiteId: 'S-CENTRAL',
    toSiteId: 'S-C',
    startAt: t(0),
    endAt: t(90), // 07:30
    threshold: COLD_THRESHOLD,
    maxCredibleGapMs: MAX_CREDIBLE_GAP,
    handovers: [
      {
        id: 'H-C3-1',
        at: t(45), // 06:45
        kind: 'sensor-change',
        fromDeviceId: 'D-CC03A',
        toDeviceId: 'D-CC03B',
        note: '交接更换传感器：新旧设备重叠采样点温度不一致，须人工核对原件',
      },
    ],
  },
];

// ---------- 箱体与批次对应（同箱多批次共享同一运输证据） ----------

export const coldBoxes: ShipmentBox[] = [
  {
    id: 'BOX-C1',
    shipmentId: 'CC-2001',
    drugCode: 'DRG-001',
    batchIds: ['B-CC-EPI-1', 'B-CC-EPI-2'],
    batchQtyMin: { 'B-CC-EPI-1': 20, 'B-CC-EPI-2': 10 },
  },
  {
    id: 'BOX-C2',
    shipmentId: 'CC-2002',
    drugCode: 'DRG-003',
    batchIds: ['B-CC-CAL-1'],
    batchQtyMin: { 'B-CC-CAL-1': 15 },
  },
  {
    id: 'BOX-C3',
    shipmentId: 'CC-2003',
    drugCode: 'DRG-001',
    batchIds: ['B-CC-EPI-3'],
    batchQtyMin: { 'B-CC-EPI-3': 12 },
  },
];

/** 冷链批次效期（批准接收后进入接收点可用余量时携带） */
export const coldBatchExpiry: Record<string, string> = {
  'B-CC-EPI-1': '2027-06-30',
  'B-CC-EPI-2': '2027-05-31',
  'B-CC-CAL-1': '2027-09-30',
  'B-CC-EPI-3': '2027-04-30',
};

// ---------- 温度序列（固定种子，允许重复/乱序/冲突/修订） ----------

function r(
  id: string,
  shipmentId: string,
  deviceId: string,
  seq: number,
  sampledMin: number,
  tempC: number,
  receivedMin?: number,
  extra: Partial<TemperatureReading> = {},
): TemperatureReading {
  return {
    id,
    shipmentId,
    deviceId,
    seq,
    sampledAt: t(sampledMin),
    receivedAt: t(receivedMin ?? sampledMin),
    tempC,
    ...extra,
  };
}

export const coldReadingsSeed: TemperatureReading[] = [
  // ===== CC-2001：单传感器 D-CC01，06:00–10:00 =====
  r('C1-01', 'CC-2001', 'D-CC01', 1, 0, 5.0),
  r('C1-02', 'CC-2001', 'D-CC01', 2, 10, 5.1),
  // 完全重复上报（同设备同序号同温度），去重保留 C1-02
  r('C1-02-DUP', 'CC-2001', 'D-CC01', 2, 10, 5.1, 14, { note: '网关重发导致完全重复' }),
  r('C1-03', 'CC-2001', 'D-CC01', 3, 20, 5.0),
  // 同序异值：序号 3 被以不同温度再次上传，冲突单列
  r('C1-03-X', 'CC-2001', 'D-CC01', 3, 20, 6.5, 22, { note: '同序号异值，来源待核' }),
  // 乱序：序号 5 先于序号 4 到平台
  r('C1-04', 'CC-2001', 'D-CC01', 4, 30, 5.2, 35),
  r('C1-05', 'CC-2001', 'D-CC01', 5, 40, 5.1, 32, { note: '乱序到达' }),
  r('C1-06', 'CC-2001', 'D-CC01', 6, 50, 5.4),
  // 07:00 开箱后温度抬升，形成约 40 分钟连续越上限
  r('C1-07', 'CC-2001', 'D-CC01', 7, 60, 6.0),
  r('C1-08', 'CC-2001', 'D-CC01', 8, 70, 8.6),
  r('C1-09', 'CC-2001', 'D-CC01', 9, 80, 9.4),
  r('C1-10', 'CC-2001', 'D-CC01', 10, 90, 9.2),
  r('C1-11', 'CC-2001', 'D-CC01', 11, 100, 8.8),
  r('C1-12', 'CC-2001', 'D-CC01', 12, 110, 6.5),
  r('C1-13', 'CC-2001', 'D-CC01', 13, 120, 5.0),
  // 08:00 后断联两小时：下一条直到 10:00 才到，两次正常读数之间不是「温度正常」
  r('C1-14', 'CC-2001', 'D-CC01', 14, 240, 5.0, 242),
  // 窗口外读数：发车前设备试机，单列不参与连接
  r('C1-PRE', 'CC-2001', 'D-CC01', 0, -10, 4.9, -8, { note: '发车前试机读数' }),

  // ===== CC-2002：06:00–08:00，07:00 换传感器，重叠点温度一致 =====
  // 旧设备 D-CC02A：06:10–06:40 存在零点漂移导致的连续高读（校准前触发待复核）
  r('C2-A1', 'CC-2002', 'D-CC02A', 1, 0, 5.0),
  r('C2-A2', 'CC-2002', 'D-CC02A', 2, 10, 9.5, 11, { note: '原始读数，疑传感器零点漂移' }),
  r('C2-A3', 'CC-2002', 'D-CC02A', 3, 20, 9.4),
  r('C2-A4', 'CC-2002', 'D-CC02A', 4, 30, 9.3),
  r('C2-A5', 'CC-2002', 'D-CC02A', 5, 40, 9.1),
  r('C2-A6', 'CC-2002', 'D-CC02A', 6, 50, 6.0),
  r('C2-A7', 'CC-2002', 'D-CC02A', 7, 60, 5.0),
  // 新设备 D-CC02B：同一时刻 5.0℃，与旧设备一致 → 不构成冲突
  r('C2-B1', 'CC-2002', 'D-CC02B', 1, 60, 5.0, 61),
  r('C2-B2', 'CC-2002', 'D-CC02B', 2, 70, 4.9),
  r('C2-B3', 'CC-2002', 'D-CC02B', 3, 80, 5.1),
  r('C2-B4', 'CC-2002', 'D-CC02B', 4, 90, 5.0),
  r('C2-B5', 'CC-2002', 'D-CC02B', 5, 100, 5.2),
  r('C2-B6', 'CC-2002', 'D-CC02B', 6, 110, 5.0),
  r('C2-B7', 'CC-2002', 'D-CC02B', 7, 120, 5.1),

  // ===== CC-2003：06:00–07:30，06:45 换传感器，重叠点温度冲突 =====
  r('C3-A1', 'CC-2003', 'D-CC03A', 1, 0, 5.0),
  r('C3-A2', 'CC-2003', 'D-CC03A', 2, 15, 5.2),
  r('C3-A3', 'CC-2003', 'D-CC03A', 3, 30, 5.1),
  r('C3-A4', 'CC-2003', 'D-CC03A', 4, 45, 5.0),
  // 新设备同刻 8.9℃：重叠数据冲突，单列且阻断自动接收
  r('C3-B1', 'CC-2003', 'D-CC03B', 1, 45, 8.9, 46, { note: '与旧设备同刻读数冲突' }),
  r('C3-B2', 'CC-2003', 'D-CC03B', 2, 60, 5.3),
  r('C3-B3', 'CC-2003', 'D-CC03B', 3, 75, 5.1),
  r('C3-B4', 'CC-2003', 'D-CC03B', 4, 90, 5.0),
];

/**
 * 迟报补传演示读数（固定）：CC-2001 在 08:30 的读数签收后才补传到平台，
 * 插入后 08:00→08:30 恢复为可信连接，未知区间由 120 分钟缩小为 90 分钟。
 * 不在初始种子内，由页面「插入迟报读数」动作显式加入并生成新检查。
 */
export const coldLateReading: TemperatureReading = r(
  'C1-LATE',
  'CC-2001',
  'D-CC01',
  15,
  150, // 08:30
  5.0,
  275, // 10:35 才到平台
  { late: true, note: '断联恢复后迟报补传' },
);

/**
 * 校准修订演示（固定）：CC-2002 旧传感器 D-CC02A 在 06:10–06:40 的 4 条高读
 * 经计量校准确认是零点漂移（实际全程 5℃ 上下）。修订读数保留原值可追溯、
 * 不覆盖历史检查，应用后另生成一条新检查，使该运输由待复核转为可按流程接收。
 */
export const coldCalibrationRevisions: TemperatureReading[] = [
  r('C2-A2-FIX', 'CC-2002', 'D-CC02A', 2, 10, 5.4, 130, {
    revisionOfReadingId: 'C2-A2',
    note: '零点漂移校准修订（原值保留，触发重新核验）',
  }),
  r('C2-A3-FIX', 'CC-2002', 'D-CC02A', 3, 20, 5.3, 131, {
    revisionOfReadingId: 'C2-A3',
    note: '零点漂移校准修订（原值保留，触发重新核验）',
  }),
  r('C2-A4-FIX', 'CC-2002', 'D-CC02A', 4, 30, 5.2, 132, {
    revisionOfReadingId: 'C2-A4',
    note: '零点漂移校准修订（原值保留，触发重新核验）',
  }),
  r('C2-A5-FIX', 'CC-2002', 'D-CC02A', 5, 40, 5.1, 133, {
    revisionOfReadingId: 'C2-A5',
    note: '零点漂移校准修订（原值保留，触发重新核验）',
  }),
];
