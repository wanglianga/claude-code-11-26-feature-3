import type { PackageSpec } from './types';

/**
 * 包装换算：仅依据显式声明的包装关系换算成最小库存单位。
 * 缺少换算资料时返回 null，由 UI 分开显示，禁止推断临床替代或猜测规格。
 */
export function toMinUnits(
  drugCode: string,
  packQty: number,
  specs: PackageSpec[],
): number | null {
  const spec = specs.find((s) => s.drugCode === drugCode);
  if (!spec) return null;
  return Math.round(packQty * spec.unitsPerPack);
}

export function toPackUnits(
  drugCode: string,
  minQty: number,
  specs: PackageSpec[],
): { qty: number; packUnit: string; minUnit: string } | null {
  const spec = specs.find((s) => s.drugCode === drugCode);
  if (!spec) return null;
  return {
    qty: minQty / spec.unitsPerPack,
    packUnit: spec.packUnit,
    minUnit: spec.minUnit,
  };
}

export function minUnitOf(drugCode: string, specs: PackageSpec[]): string {
  return specs.find((s) => s.drugCode === drugCode)?.minUnit ?? '最小单位';
}

export function formatQty(
  drugCode: string,
  minQty: number,
  specs: PackageSpec[],
): string {
  const spec = specs.find((s) => s.drugCode === drugCode);
  if (!spec) return `${minQty}（最小单位）`;
  const packs = minQty / spec.unitsPerPack;
  const packText = Number.isInteger(packs)
    ? `${packs} ${spec.packUnit}`
    : `${packs.toFixed(2)} ${spec.packUnit}`;
  return `${minQty} ${spec.minUnit}（${packText}）`;
}
