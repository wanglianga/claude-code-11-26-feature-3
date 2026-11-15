/**
 * 冷链核查的本地状态装配（纯数据，不含 React）。
 * 检查任务固定文件与交接资料；迟报/校准只追加新检查，不覆盖历史；
 * 受影响批次先隔离，批准处置后才进入正式可用余量。
 */
import {
  buildCheck,
  type ColdCheck,
  type ColdDisposition,
  type ColdQuarantineLine,
  type TemperatureReading,
} from '../domain/coldchain';
import {
  coldBatchExpiry,
  coldBoxes,
  coldReadingsSeed,
  coldShipments,
} from '../data/coldChainData';

export interface ColdState {
  /** 平台当前掌握的全部读数（初始固定种子 + 迟报/校准追加，不删除原值） */
  coldReadings: TemperatureReading[];
  /** 检查历史：按运输追加，迟报/校准生成新检查，已批准处置保留原记录 */
  coldChecks: ColdCheck[];
  /** 每个运输的检查序号（从 1 开始） */
  coldCheckSeq: Record<string, number>;
  /** 已批准的处置记录 */
  coldDispositions: ColdDisposition[];
  /** 到货隔离行：批准前不进正式库存 */
  coldQuarantine: ColdQuarantineLine[];
  /** 迟报是否已插入、校准是否已应用（用于按钮状态与重置） */
  lateInserted: boolean;
  calibrationApplied: boolean;
}

/** 初始隔离行：每个箱体的批次在接收点位先隔离，等待冷链核查处置 */
export function buildInitialQuarantine(): ColdQuarantineLine[] {
  const lines: ColdQuarantineLine[] = [];
  for (const box of coldBoxes) {
    const shipment = coldShipments.find((s) => s.id === box.shipmentId)!;
    for (const batchId of box.batchIds) {
      lines.push({
        shipmentId: box.shipmentId,
        boxId: box.id,
        siteId: shipment.toSiteId,
        batchId,
        drugCode: box.drugCode,
        expiry: coldBatchExpiry[batchId],
        qtyMin: box.batchQtyMin[batchId],
        status: 'isolated',
      });
    }
  }
  return lines;
}

export function createInitialColdState(): ColdState {
  const coldCheckSeq: Record<string, number> = {};
  const coldChecks: ColdCheck[] = [];
  for (const shipment of coldShipments) {
    coldCheckSeq[shipment.id] = 1;
    coldChecks.push(
      buildCheck(
        shipment,
        coldReadingsSeed,
        'initial',
        1,
        shipment.endAt + 5 * 60_000,
      ),
    );
  }
  return {
    coldReadings: coldReadingsSeed.map((r) => ({ ...r })),
    coldChecks,
    coldCheckSeq,
    coldDispositions: [],
    coldQuarantine: buildInitialQuarantine(),
    lateInserted: false,
    calibrationApplied: false,
  };
}

/** 某运输的最新一条检查（结论以最新检查为准，但历史检查全部保留） */
export function latestCheck(
  checks: ColdCheck[],
  shipmentId: string,
): ColdCheck | undefined {
  const own = checks.filter((c) => c.shipmentId === shipmentId);
  return own[own.length - 1];
}

/** 某运输已批准的处置（已批准处置保留原记录，不因新检查改写） */
export function dispositionOf(
  dispositions: ColdDisposition[],
  shipmentId: string,
): ColdDisposition | undefined {
  return dispositions.find((d) => d.shipmentId === shipmentId);
}
