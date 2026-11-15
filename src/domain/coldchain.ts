/**
 * 冷链运输温度核查引擎（纯函数，浏览器本地推演，不接真实温控系统）。
 *
 * 核查原则：
 *  1. 原始读数先按「设备序号 + 上报序号」去重，并识别同序异值；乱序上传统一按时间归一。
 *  2. 同一设备两次读数间隔不超过最大可信采样间隔才做线性连接；超间隔断联区间标记为「未知」，
 *     绝不把两次正常读数之间的断联当成温度正常，也不跨断联把两段超限连成一段确定事实。
 *  3. 线性段与阈值（演示固定 2–8℃）求交点后拆分状态区间，逐段分类正常/越界/未知，
 *     连续越界按时段独立计算（断联两侧不合并），另给累计越界时长与未知时长；不用全量平均掩盖超限。
 *  4. 交接换传感器以交接记录衔接：新旧设备重叠窗口的数据冲突单列，不静默取舍。
 *  5. 校准修订与迟报不覆盖原检查：另生成一条新检查；已批准处置保留原记录。
 *  6. 结论只给「待复核 / 可按流程接收」，不判断真实药品是否可用；同箱多批次共享同一运输证据，
 *     时长只算一次，不按批次重复累计。
 */

// ---------- 静态资料（固定文件，不接外部系统） ----------

/** 时间戳统一用毫秒（UTC）。引擎内禁止使用 Date.now()，所有时间均来自固定演示数据与用户显式输入 */
export type EpochMs = number;

/** 演示阈值：2–8℃ 冷藏区间 */
export interface ColdThreshold {
  minC: number;
  maxC: number;
}

/** 交接区间：一次开箱/换车/换传感器的交接记录（交接资料为固定文件） */
export interface HandoverRecord {
  id: string;
  /** 交接发生时间 */
  at: EpochMs;
  /** 交接类型：普通开箱、换车交接、更换传感器 */
  kind: 'door-open' | 'vehicle-change' | 'sensor-change';
  /** 更换传感器时，旧/新设备序号（其余类型可为空） */
  fromDeviceId?: string;
  toDeviceId?: string;
  note: string;
}

/** 箱体与批次对应：同箱多批次共享同一运输证据 */
export interface ShipmentBox {
  id: string;
  shipmentId: string;
  /** 箱内批次（最小库存单位口径的批次号） */
  batchIds: string[];
  drugCode: string;
  /** 每批次在箱数量（最小单位），仅用于隔离/接收数量提示 */
  batchQtyMin: Record<string, number>;
}

/** 一次冷链运输（固定文件） */
export interface ColdShipment {
  id: string;
  boxId: string;
  fromSiteId: string;
  toSiteId: string;
  /** 运输核查窗口起点（封车发车） */
  startAt: EpochMs;
  /** 运输核查窗口终点（到场签收前） */
  endAt: EpochMs;
  threshold: ColdThreshold;
  /** 最大可信采样间隔：超过该间隔的两次读数之间不做线性连接，列未知 */
  maxCredibleGapMs: number;
  handovers: HandoverRecord[];
}

/** 单条温度读数（传感器原始上报，允许重复、乱序、同序异值、迟报、校准修订） */
export interface TemperatureReading {
  id: string;
  shipmentId: string;
  /** 设备（传感器）序号 */
  deviceId: string;
  /** 设备内上报序号：重复上报与同序异值据此识别 */
  seq: number;
  /** 读数实际采样时间（设备时钟） */
  sampledAt: EpochMs;
  /** 平台接收时间（乱序/迟报据此识别） */
  receivedAt: EpochMs;
  tempC: number;
  /** 迟报补传标志：接收时间显著晚于采样时间 */
  late?: boolean;
  /** 校准修订标志：对已存在读数的校准版本（不覆盖原值，另触发新检查） */
  revisionOfReadingId?: string;
  note?: string;
}

// ---------- 清洗与归一 ----------

export type ReadingIssue =
  | 'duplicate' // 完全重复（设备+序号+温度一致），保留首条
  | 'same-seq-conflict' // 同序异值：同设备同序号温度不一致，全部保留并单列
  | 'out-of-order' // 平台乱序接收（按采样时间归一后不影响事实）
  | 'late' // 迟报补传
  | 'revision' // 校准修订读数（可追溯，不视为同序冲突）
  | 'revised' // 已被校准修订取代的原始读数（保留展示，不参与连接）
  | 'outside-window'; // 采样时间落在运输核查窗口外，单列不参与连接

export interface CleanReading {
  reading: TemperatureReading;
  issues: ReadingIssue[];
  /** 同序异值分组键：设备序号 + 上报序号 */
  conflictKey: string;
}

export interface ReadingConflict {
  key: string;
  shipmentId: string;
  deviceId: string;
  seq: number;
  readingIds: string[];
  valuesC: number[];
  sampledAt: EpochMs;
}

/** 交接重叠窗口内两台设备同一采样时刻温度不一致：重叠数据冲突单列 */
export interface OverlapConflict {
  key: string;
  shipmentId: string;
  handoverId?: string;
  sampledAt: EpochMs;
  deviceValues: { deviceId: string; tempC: number; readingId: string }[];
}

export interface CleanResult {
  /** 归一后的有效读数（按设备、采样时间排序；冲突读数全部保留） */
  clean: CleanReading[];
  /** 被折叠的完全重复读数 id（去重依据可回溯） */
  duplicates: { readingId: string; keptReadingId: string }[];
  /** 同序异值冲突（同设备同序号温度不一致，单列） */
  conflicts: ReadingConflict[];
  /** 交接换传感器期间，新旧设备重叠数据冲突（单列，不静默取舍） */
  overlapConflicts: OverlapConflict[];
  /** 落在核查窗口外的读数 */
  outsideWindow: string[];
}

/**
 * 步骤 1–2：按设备序号去重、识别同序异值，统一时间（按采样时间归一，乱序仅打标不丢数据）。
 */
export function cleanReadings(
  shipment: ColdShipment,
  readings: TemperatureReading[],
): CleanResult {
  const mine = readings.filter((r) => r.shipmentId === shipment.id);
  const duplicates: CleanResult['duplicates'] = [];
  const outsideWindow: string[] = [];
  // 完全重复键：设备 + 序号 + 温度（首条保留，其余折叠）
  const exact = new Map<string, TemperatureReading>();
  // 同序键：设备 + 序号（不论温度，用于同序异值分组）；校准修订组单独标记
  const seqGroup = new Map<string, { readings: TemperatureReading[]; revised: boolean }>();
  // 被校准修订取代的原始读数 id
  const revisedIds = new Set(
    mine.filter((r) => r.revisionOfReadingId).map((r) => r.revisionOfReadingId!),
  );

  const tagged: CleanReading[] = [];

  for (const r of mine) {
    const seqKey = `${r.deviceId}#${r.seq}`;
    const exactKey = `${seqKey}@${r.tempC}`;
    const issues: ReadingIssue[] = [];

    if (r.sampledAt < shipment.startAt || r.sampledAt > shipment.endAt) {
      issues.push('outside-window');
      outsideWindow.push(r.id);
    }
    if (r.late) issues.push('late');
    if (r.revisionOfReadingId) issues.push('revision');
    if (revisedIds.has(r.id)) issues.push('revised');

    const prevExact = exact.get(exactKey);
    if (prevExact) {
      // 完全重复：保留首条，重复条折叠（乱序接收也只打标）
      duplicates.push({ readingId: r.id, keptReadingId: prevExact.id });
      if (r.receivedAt < prevExact.receivedAt) issues.push('out-of-order');
      continue;
    }

    const group = seqGroup.get(seqKey);
    if (group && group.readings.length > 0) {
      const isRevisionPair =
        !!r.revisionOfReadingId &&
        group.readings.some((g) => g.id === r.revisionOfReadingId);
      if (isRevisionPair) {
        // 可追溯的校准修订：原值保留、新值采用，不列为同序异值冲突
        group.revised = true;
        group.readings.push(r);
      } else {
        // 同设备同序号但温度不同且无修订依据 → 同序异值冲突，读数保留不静默取舍
        issues.push('same-seq-conflict');
        group.readings.push(r);
      }
    } else {
      seqGroup.set(seqKey, { readings: [r], revised: false });
    }
    exact.set(exactKey, r);
    tagged.push({ reading: r, issues, conflictKey: seqKey });
  }

  // 乱序标记：同一设备内，平台接收顺序与采样顺序不一致
  const byDevice = new Map<string, CleanReading[]>();
  for (const c of tagged) {
    const arr = byDevice.get(c.reading.deviceId) ?? [];
    arr.push(c);
    byDevice.set(c.reading.deviceId, arr);
  }
  for (const arr of byDevice.values()) {
    let maxReceived = -Infinity;
    for (const c of arr) {
      if (c.reading.receivedAt < maxReceived && !c.issues.includes('out-of-order')) {
        c.issues.push('out-of-order');
      }
      maxReceived = Math.max(maxReceived, c.reading.receivedAt);
    }
  }

  const conflicts: ReadingConflict[] = [];
  for (const [key, group] of seqGroup) {
    if (group.revised) continue; // 校准修订组不列为冲突
    const distinctVals = [...new Set(group.readings.map((g) => g.tempC))];
    if (distinctVals.length > 1) {
      conflicts.push({
        key,
        shipmentId: shipment.id,
        deviceId: group.readings[0].deviceId,
        seq: group.readings[0].seq,
        readingIds: group.readings.map((g) => g.id),
        valuesC: distinctVals,
        sampledAt: group.readings[0].sampledAt,
      });
    }
  }

  // 同序异值回标：分组建立后，把无修订依据的冲突组内读数（含首条）统一标记
  for (const c of tagged) {
    const group = seqGroup.get(c.conflictKey);
    if (
      group &&
      !group.revised &&
      new Set(group.readings.map((g) => g.tempC)).size > 1
    ) {
      if (!c.issues.includes('same-seq-conflict')) c.issues.push('same-seq-conflict');
    }
  }

  tagged.sort(
    (a, b) =>
      a.reading.deviceId.localeCompare(b.reading.deviceId) ||
      a.reading.sampledAt - b.reading.sampledAt ||
      a.reading.receivedAt - b.reading.receivedAt,
  );
  conflicts.sort((a, b) => a.sampledAt - b.sampledAt);

  // 重叠数据冲突：同一采样时刻存在两台及以上设备（交接换传感器的重叠窗口），
  // 温度不一致时单列，不静默取舍
  const overlapConflicts: OverlapConflict[] = [];
  const atInstant = new Map<EpochMs, CleanReading[]>();
  for (const c of tagged) {
    if (c.issues.includes('outside-window') || c.issues.includes('revised')) continue;
    const arr = atInstant.get(c.reading.sampledAt) ?? [];
    arr.push(c);
    atInstant.set(c.reading.sampledAt, arr);
  }
  for (const [at, arr] of atInstant) {
    const devices = [...new Set(arr.map((c) => c.reading.deviceId))];
    if (devices.length < 2) continue;
    const vals = [...new Set(arr.map((c) => c.reading.tempC))];
    if (vals.length < 2) continue;
    const nearest = [...shipment.handovers]
      .filter((h) => h.kind === 'sensor-change')
      .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
    overlapConflicts.push({
      key: `overlap@${at}`,
      shipmentId: shipment.id,
      handoverId: nearest?.id,
      sampledAt: at,
      deviceValues: arr.map((c) => ({
        deviceId: c.reading.deviceId,
        tempC: c.reading.tempC,
        readingId: c.reading.id,
      })),
    });
  }
  overlapConflicts.sort((a, b) => a.sampledAt - b.sampledAt);

  return { clean: tagged, duplicates, conflicts, overlapConflicts, outsideWindow };
}

// ---------- 可信连接与状态区间 ----------

export type SegmentStatus = 'normal' | 'excursion-high' | 'excursion-low' | 'unknown';

export interface TemperatureSegment {
  id: string;
  deviceId: string;
  from: EpochMs;
  to: EpochMs;
  /** 区间起点/终点温度；unknown 区间端点可能为 null（断联） */
  fromTempC: number | null;
  toTempC: number | null;
  status: SegmentStatus;
  /** 时长（毫秒） */
  durationMs: number;
  /** 该段是否由线性插值/交点计算得到（未知段为 false） */
  interpolated: boolean;
  /** 关联的原始读数 id（点击异常回溯原始点） */
  sourceReadingIds: string[];
  /** 关联交接 id（换传感器衔接点） */
  handoverId?: string;
}

/** 设备分段：一个传感器在其有效工作窗口内的可信连接与断联未知段 */
export interface DeviceTrace {
  deviceId: string;
  /** 该设备被交接启用的时间（首台设备为运输起点） */
  activeFrom: EpochMs;
  /** 该设备停止工作的时间（被更换为运输终点） */
  activeTo: EpochMs;
  segments: TemperatureSegment[];
  /** 参与连接的有效读数（窗口内、去重后） */
  readings: CleanReading[];
}

export interface ColdChainAnalysis {
  shipmentId: string;
  clean: CleanResult;
  deviceTraces: DeviceTrace[];
  /** 覆盖整个运输窗口的统一时间轴状态区间（含设备衔接与未知段） */
  segments: TemperatureSegment[];
  /** 连续越界时段（断联两侧不合并；每个为一段确定事实） */
  continuousExcursions: TemperatureSegment[];
  /** 指标（毫秒口径） */
  totalWindowMs: number;
  connectedMs: number;
  unknownMs: number;
  excursionMs: number;
  normalMs: number;
  /** 最长连续越界时长 */
  maxContinuousExcursionMs: number;
  /** 最长连续未知（断联/缺测）时长：迟报补传后该值会随未知区间被切分而缩小 */
  maxContinuousUnknownMs: number;
  /** 未知区间列表（断联/超间隔） */
  unknownSegments: TemperatureSegment[];
  /** 阈值交点（线性段穿越上下限的时间点） */
  thresholdCrossings: { at: EpochMs; tempC: number; bound: 'min' | 'max' }[];
}

const MINUTE = 60_000;

function classify(tempC: number, th: ColdThreshold): SegmentStatus {
  if (tempC < th.minC) return 'excursion-low';
  if (tempC > th.maxC) return 'excursion-high';
  return 'normal';
}

/**
 * 线性段与阈值求交点：返回区间内穿越 min/max 的时间点。
 */
function crossings(
  t0: EpochMs,
  v0: number,
  t1: EpochMs,
  v1: number,
  th: ColdThreshold,
): { at: EpochMs; tempC: number; bound: 'min' | 'max' }[] {
  const out: ColdChainAnalysis['thresholdCrossings'] = [];
  if (t1 === t0) return out;
  for (const bound of ['min', 'max'] as const) {
    const level = bound === 'min' ? th.minC : th.maxC;
    if ((v0 - level) * (v1 - level) < 0) {
      // 严格异号：区间内穿越
      const ratio = (level - v0) / (v1 - v0);
      out.push({ at: t0 + ratio * (t1 - t0), tempC: level, bound });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 把一条可信线性段按阈值交点拆成 normal/越界 子段 */
function splitLinearSegment(
  deviceId: string,
  t0: EpochMs,
  v0: number,
  t1: EpochMs,
  v1: number,
  th: ColdThreshold,
  sourceReadingIds: string[],
  handoverId: string | undefined,
  prefix: string,
): TemperatureSegment[] {
  const cuts = crossings(t0, v0, t1, v1, th);
  if (cuts.length === 0) {
    return [
      {
        id: `${prefix}-s`,
        deviceId,
        from: t0,
        to: t1,
        fromTempC: v0,
        toTempC: v1,
        status: classify(v0 === v1 ? v0 : (v0 + v1) / 2, th),
        durationMs: t1 - t0,
        interpolated: true,
        sourceReadingIds: [...sourceReadingIds],
        handoverId,
      },
    ];
  }
  const pieces: TemperatureSegment[] = [];
  let cursorT = t0;
  let cursorV = v0;
  cuts.forEach((cut, i) => {
    const midV = (cursorV + cut.tempC) / 2;
    pieces.push({
      id: `${prefix}-c${i}a`,
      deviceId,
      from: cursorT,
      to: cut.at,
      fromTempC: cursorV,
      toTempC: cut.tempC,
      status: classify(midV, th),
      durationMs: cut.at - cursorT,
      interpolated: true,
      sourceReadingIds: [...sourceReadingIds],
      handoverId,
    });
    pieces.push({
      id: `${prefix}-c${i}b`,
      deviceId,
      from: cut.at,
      to: cut.at,
      fromTempC: cut.tempC,
      toTempC: cut.tempC,
      status: classify(cut.tempC, th),
      durationMs: 0,
      interpolated: true,
      sourceReadingIds: [...sourceReadingIds],
      handoverId,
    });
    cursorT = cut.at;
    cursorV = cut.tempC;
  });
  pieces.push({
    id: `${prefix}-ce`,
    deviceId,
    from: cursorT,
    to: t1,
    fromTempC: cursorV,
    toTempC: v1,
    status: classify((cursorV + v1) / 2, th),
    durationMs: t1 - cursorT,
    interpolated: true,
    sourceReadingIds: [...sourceReadingIds],
    handoverId,
  });
  return pieces.filter((p) => p.durationMs > 0);
}

/**
 * 合并同设备内首尾相接（前一段 to === 后一段 from）且状态相同的分段。
 * 用于把跨多个采样间隔的连续越界累计为一段；未知断联与设备边界天然打断连续性。
 */
function mergeAdjacentRuns(segments: TemperatureSegment[]): TemperatureSegment[] {
  const out: TemperatureSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.deviceId === seg.deviceId &&
      prev.status === seg.status &&
      prev.to === seg.from
    ) {
      const sourceIds = [...new Set([...prev.sourceReadingIds, ...seg.sourceReadingIds])];
      out[out.length - 1] = {
        ...prev,
        to: seg.to,
        toTempC: seg.toTempC,
        durationMs: seg.to - prev.from,
        interpolated: prev.interpolated && seg.interpolated,
        sourceReadingIds: sourceIds,
        handoverId: prev.handoverId ?? seg.handoverId,
      };
    } else {
      out.push({ ...seg, sourceReadingIds: [...seg.sourceReadingIds] });
    }
  }
  return out;
}

/** 交接链：给出每台设备的有效工作窗口（换传感器以交接依据衔接） */
export function deviceWindows(
  shipment: ColdShipment,
  readings: TemperatureReading[] = [],
): { deviceId: string; activeFrom: EpochMs; activeTo: EpochMs; handoverId?: string }[] {
  const changes = shipment.handovers
    .filter((h) => h.kind === 'sensor-change' && h.fromDeviceId && h.toDeviceId)
    .sort((a, b) => a.at - b.at);
  const windows: ReturnType<typeof deviceWindows> = [];
  let currentDevice: string | undefined;
  let currentFrom = shipment.startAt;
  for (const h of changes) {
    if (!currentDevice) currentDevice = h.fromDeviceId;
    windows.push({
      deviceId: currentDevice!,
      activeFrom: currentFrom,
      activeTo: h.at,
      handoverId: windows.length === 0 ? undefined : h.id,
    });
    currentDevice = h.toDeviceId;
    currentFrom = h.at;
  }
  if (windows.length === 0) {
    // 无换传感器记录：按实际出现的设备序号各给一个全窗口（多设备即数据异常，留待冲突识别）
    const devices = [...new Set(readings.filter((r) => r.shipmentId === shipment.id).map((r) => r.deviceId))]
      .sort();
    if (devices.length > 0) {
      return devices.map((deviceId) => ({
        deviceId,
        activeFrom: shipment.startAt,
        activeTo: shipment.endAt,
      }));
    }
    return [{ deviceId: 'DEVICE-UNKNOWN', activeFrom: shipment.startAt, activeTo: shipment.endAt }];
  }
  // 末台设备持续到运输终点
  windows.push({
    deviceId: currentDevice!,
    activeFrom: currentFrom,
    activeTo: shipment.endAt,
    handoverId: changes.length ? changes[changes.length - 1].id : undefined,
  });
  return windows;
}

/**
 * 步骤 3–4：在每台设备窗口内，只对最大可信采样间隔内的相邻读数做线性连接，
 * 超间隔列未知；再按阈值交点拆段。设备窗口之间以交接依据衔接，不跨设备/断联连接。
 */
export function analyzeShipment(
  shipment: ColdShipment,
  readings: TemperatureReading[],
): ColdChainAnalysis {
  const clean = cleanReadings(shipment, readings);
  const windows = deviceWindows(shipment, readings);

  // 窗口内有效读数（外部读数不参与连接），按设备分组
  const validByDevice = new Map<string, CleanReading[]>();
  for (const c of clean.clean) {
    // 窗口外读数与已被校准修订取代的原值不参与可信连接（原值仍在清洗结果可回溯）
    if (c.issues.includes('outside-window') || c.issues.includes('revised')) continue;
    const arr = validByDevice.get(c.reading.deviceId) ?? [];
    arr.push(c);
    validByDevice.set(c.reading.deviceId, arr);
  }
  for (const arr of validByDevice.values()) {
    arr.sort((a, b) => a.reading.sampledAt - b.reading.sampledAt);
  }

  const deviceTraces: DeviceTrace[] = [];
  const allSegments: TemperatureSegment[] = [];
  const thresholdCrossings: ColdChainAnalysis['thresholdCrossings'] = [];
  let segCounter = 0;
  const nextSegId = () => `${shipment.id}-seg${++segCounter}`;

  for (const win of windows) {
    const arr = (validByDevice.get(win.deviceId) ?? []).filter(
      (c) => c.reading.sampledAt >= win.activeFrom && c.reading.sampledAt <= win.activeTo,
    );
    const segments: TemperatureSegment[] = [];
    if (arr.length === 0) {
      // 整个设备窗口无任何可信读数 → 全段未知
      segments.push({
        id: nextSegId(),
        deviceId: win.deviceId,
        from: win.activeFrom,
        to: win.activeTo,
        fromTempC: null,
        toTempC: null,
        status: 'unknown',
        durationMs: win.activeTo - win.activeFrom,
        interpolated: false,
        sourceReadingIds: [],
        handoverId: win.handoverId,
      });
    } else {
      // 窗口起点到首点：若在可信间隔内则线性连接，否则未知
      const first = arr[0].reading;
      if (first.sampledAt > win.activeFrom) {
        const gap = first.sampledAt - win.activeFrom;
        if (gap <= shipment.maxCredibleGapMs) {
          segments.push(
            ...splitLinearSegment(
              win.deviceId,
              win.activeFrom,
              first.tempC,
              first.sampledAt,
              first.tempC,
              shipment.threshold,
              [first.id],
              win.handoverId,
              nextSegId(),
            ),
          );
        } else {
          segments.push({
            id: nextSegId(),
            deviceId: win.deviceId,
            from: win.activeFrom,
            to: first.sampledAt,
            fromTempC: null,
            toTempC: first.tempC,
            status: 'unknown',
            durationMs: gap,
            interpolated: false,
            sourceReadingIds: [first.id],
            handoverId: win.handoverId,
          });
        }
      }

      for (let i = 0; i < arr.length - 1; i++) {
        const a = arr[i].reading;
        const b = arr[i + 1].reading;
        const gap = b.sampledAt - a.sampledAt;
        if (gap === 0) {
          // 同一时刻多条读数（同序异值冲突已单列）：不产生零长度连接段
          continue;
        }
        if (gap <= shipment.maxCredibleGapMs) {
          const pieces = splitLinearSegment(
            win.deviceId,
            a.sampledAt,
            a.tempC,
            b.sampledAt,
            b.tempC,
            shipment.threshold,
            [a.id, b.id],
            undefined,
            nextSegId(),
          );
          segments.push(...pieces);
          thresholdCrossings.push(
            ...crossings(a.sampledAt, a.tempC, b.sampledAt, b.tempC, shipment.threshold),
          );
        } else {
          // 超间隔：两侧各自留边界点，中间整段未知；不跨断联连接
          segments.push({
            id: nextSegId(),
            deviceId: win.deviceId,
            from: a.sampledAt,
            to: b.sampledAt,
            fromTempC: a.tempC,
            toTempC: b.tempC,
            status: 'unknown',
            durationMs: gap,
            interpolated: false,
            sourceReadingIds: [a.id, b.id],
          });
        }
      }

      // 末点到窗口终点
      const last = arr[arr.length - 1].reading;
      if (last.sampledAt < win.activeTo) {
        const gap = win.activeTo - last.sampledAt;
        if (gap <= shipment.maxCredibleGapMs) {
          segments.push(
            ...splitLinearSegment(
              win.deviceId,
              last.sampledAt,
              last.tempC,
              win.activeTo,
              last.tempC,
              shipment.threshold,
              [last.id],
              win.handoverId,
              nextSegId(),
            ),
          );
        } else {
          segments.push({
            id: nextSegId(),
            deviceId: win.deviceId,
            from: last.sampledAt,
            to: win.activeTo,
            fromTempC: last.tempC,
            toTempC: null,
            status: 'unknown',
            durationMs: gap,
            interpolated: false,
            sourceReadingIds: [last.id],
            handoverId: win.handoverId,
          });
        }
      }
    }

    deviceTraces.push({
      deviceId: win.deviceId,
      activeFrom: win.activeFrom,
      activeTo: win.activeTo,
      segments,
      readings: arr,
    });
    allSegments.push(...segments);
  }

  allSegments.sort((a, b) => a.from - b.from || a.to - b.to);
  thresholdCrossings.sort((a, b) => a.at - b.at);

  // 同设备内合并首尾相接的同状态段：连续越界应跨多个采样间隔累计为一段确定事实；
  // 但不跨设备（换传感器是证据边界）、不跨未知断联（未知会打断连续性）。
  const mergedRuns = mergeAdjacentRuns(allSegments);

  // 指标汇总
  let connectedMs = 0;
  let unknownMs = 0;
  let excursionMs = 0;
  let normalMs = 0;
  const unknownSegments: TemperatureSegment[] = mergedRuns.filter(
    (g) => g.status === 'unknown',
  );
  const continuousExcursions: TemperatureSegment[] = mergedRuns.filter(
    (g) => g.status === 'excursion-high' || g.status === 'excursion-low',
  );
  for (const seg of allSegments) {
    if (seg.status === 'unknown') {
      unknownMs += seg.durationMs;
      continue;
    }
    connectedMs += seg.durationMs;
    if (seg.status === 'normal') {
      normalMs += seg.durationMs;
    } else {
      excursionMs += seg.durationMs;
    }
  }
  const maxContinuousExcursionMs = continuousExcursions.reduce(
    (m, s) => Math.max(m, s.durationMs),
    0,
  );
  const maxContinuousUnknownMs = unknownSegments.reduce(
    (m, s) => Math.max(m, s.durationMs),
    0,
  );

  return {
    shipmentId: shipment.id,
    clean,
    deviceTraces,
    segments: allSegments,
    continuousExcursions,
    totalWindowMs: shipment.endAt - shipment.startAt,
    connectedMs,
    unknownMs,
    excursionMs,
    normalMs,
    maxContinuousExcursionMs,
    maxContinuousUnknownMs,
    unknownSegments,
    thresholdCrossings,
  };
}

// ---------- 核查结论与处置 ----------

export type ColdReviewVerdict = 'pending-review' | 'acceptable';

export interface ColdReviewRule {
  /** 连续越界达到该时长（毫秒）→ 待复核 */
  maxContinuousExcursionMs: number;
  /** 累计越界达到该时长（毫秒）→ 待复核 */
  maxCumulativeExcursionMs: number;
  /** 未知（缺测）时长达到该时长（毫秒）→ 待复核 */
  maxUnknownMs: number;
  /** 存在同序异值/重叠冲突且未解决 → 待复核 */
  conflictBlocks: boolean;
}

/** 演示规则（固定）：连续越界 ≥30 分钟、累计越界 ≥60 分钟、未知 ≥60 分钟、冲突阻断 */
export const DEMO_REVIEW_RULE: ColdReviewRule = {
  maxContinuousExcursionMs: 30 * MINUTE,
  maxCumulativeExcursionMs: 60 * MINUTE,
  maxUnknownMs: 60 * MINUTE,
  conflictBlocks: true,
};

export interface ColdReviewResult {
  shipmentId: string;
  verdict: ColdReviewVerdict;
  reasons: string[];
  /** 结论依据的检查编号（检查固定文件，迟报/校准生成新检查） */
  checkId: string;
  analysis: ColdChainAnalysis;
  rule: ColdReviewRule;
}

/**
 * 步骤 5：依据示例规则给出结论。只输出流程结论（待复核/可按流程接收），
 * 不判断真实药品是否可用。
 */
export function reviewShipment(
  shipment: ColdShipment,
  readings: TemperatureReading[],
  rule: ColdReviewRule = DEMO_REVIEW_RULE,
  checkId = 'CHK-1',
): ColdReviewResult {
  const analysis = analyzeShipment(shipment, readings);
  const reasons: string[] = [];
  if (analysis.maxContinuousExcursionMs >= rule.maxContinuousExcursionMs) {
    reasons.push(
      `存在连续越界 ${fmtMinutes(analysis.maxContinuousExcursionMs)} 分钟，达到待复核阈值 ${fmtMinutes(rule.maxContinuousExcursionMs)} 分钟`,
    );
  }
  if (analysis.excursionMs >= rule.maxCumulativeExcursionMs) {
    reasons.push(
      `累计越界 ${fmtMinutes(analysis.excursionMs)} 分钟，达到待复核阈值 ${fmtMinutes(rule.maxCumulativeExcursionMs)} 分钟`,
    );
  }
  if (analysis.unknownMs >= rule.maxUnknownMs) {
    reasons.push(
      `传感器缺测/断联未知时长 ${fmtMinutes(analysis.unknownMs)} 分钟，达到待复核阈值 ${fmtMinutes(rule.maxUnknownMs)} 分钟`,
    );
  }
  if (
    rule.conflictBlocks &&
    (analysis.clean.conflicts.length > 0 || analysis.clean.overlapConflicts.length > 0)
  ) {
    const total = analysis.clean.conflicts.length + analysis.clean.overlapConflicts.length;
    reasons.push(`存在 ${total} 组同序异值/重叠数据冲突，须人工核对传感器原件`);
  }
  return {
    shipmentId: shipment.id,
    verdict: reasons.length ? 'pending-review' : 'acceptable',
    reasons,
    checkId,
    analysis,
    rule,
  };
}

export function fmtMinutes(ms: number): number {
  return Math.round(ms / MINUTE);
}

/** UTC 时钟格式 HH:mm（演示时间轴统一 UTC，避免本地时区漂移） */
export function formatClock(ms: EpochMs): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** UTC 完整日期时间 YYYY-MM-DD HH:mm */
export function formatDateTime(ms: EpochMs): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da} ${formatClock(ms)}`;
}

// ---------- 检查历史（迟报/校准触发新检查，已批准处置保留原记录） ----------

export type ColdCheckTrigger = 'initial' | 'late-upload' | 'calibration-revision';

export interface ColdCheck {
  id: string;
  shipmentId: string;
  trigger: ColdCheckTrigger;
  createdAt: EpochMs;
  /** 该检查纳入的读数 id 快照（固定文件 + 当时已到读数） */
  readingIds: string[];
  result: ColdReviewResult;
}

export interface ColdDisposition {
  shipmentId: string;
  /** 处置依据的检查 id（已批准处置保留原记录，不因新检查而改写） */
  checkId: string;
  decision: 'quarantine' | 'release';
  decidedAt: EpochMs;
  note: string;
}

/**
 * 生成一条新检查。迟报或校准修订都不覆盖历史检查：
 * 读数集扩大后重新核查，检查编号递增；已存在的批准处置保持不变。
 */
export function buildCheck(
  shipment: ColdShipment,
  readings: TemperatureReading[],
  trigger: ColdCheckTrigger,
  checkSeq: number,
  createdAt: EpochMs,
  rule: ColdReviewRule = DEMO_REVIEW_RULE,
): ColdCheck {
  const checkId = `CHK-${checkSeq}`;
  const result = reviewShipment(shipment, readings, rule, checkId);
  return {
    id: checkId,
    shipmentId: shipment.id,
    trigger,
    createdAt,
    readingIds: readings.filter((r) => r.shipmentId === shipment.id).map((r) => r.id),
    result,
  };
}

/** 同箱多批次共享同一运输证据：时长指标只取一次，不按批次重复累计 */
export function evidenceForBox(
  box: ShipmentBox,
  reviews: Record<string, ColdReviewResult>,
): { shipmentId: string; result: ColdReviewResult | null; batchIds: string[] } {
  return {
    shipmentId: box.shipmentId,
    result: reviews[box.shipmentId] ?? null,
    batchIds: [...box.batchIds],
  };
}

/** 冷链到货隔离行：批准前不进入正式库存，不参与任何调拨/推演 */
export interface ColdQuarantineLine {
  shipmentId: string;
  boxId: string;
  /** 货物所在（接收）点位 */
  siteId: string;
  batchId: string;
  drugCode: string;
  expiry: string;
  qtyMin: number;
  /** isolated=隔离待处置；released=已批准进入可用余量；held=复核后继续隔离 */
  status: 'isolated' | 'released' | 'held';
}
