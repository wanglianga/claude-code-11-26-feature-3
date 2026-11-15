import { useState } from 'react';
import { useStore } from '../store/useStore';

interface Props {
  siteId: string;
  onClose: () => void;
}

/** 盘点弹窗：按批次登记新实盘数；确认后草稿失效、已批准安排待复核 */
export default function StocktakeModal({ siteId, onClose }: Props) {
  const batches = useStore((s) => s.batches);
  const drugs = useStore((s) => s.drugs);
  const stocktake = useStore((s) => s.stocktake);
  const siteBatches = batches.filter((b) => b.siteId === siteId);
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries(siteBatches.map((b) => [b.id, b.qtyMin])),
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>盘点修订 · {siteId}</h3>
        <div className="notice warn">
          盘点确认后：未确认的草稿建议立即失效；已批准/在途安排列入待复核，系统不会静默改动其数量。
        </div>
        <table>
          <thead>
            <tr>
              <th>批次</th>
              <th>药品</th>
              <th>效期</th>
              <th className="num">账面数量</th>
              <th className="num">实盘数量</th>
            </tr>
          </thead>
          <tbody>
            {siteBatches.map((b) => (
              <tr key={b.id}>
                <td className="mono">{b.id}</td>
                <td>{drugs.find((d) => d.code === b.drugCode)?.name ?? b.drugCode}</td>
                <td className="mono">{b.expiry}</td>
                <td className="num muted">{b.qtyMin}</td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    value={qty[b.id] ?? 0}
                    onChange={(e) =>
                      setQty((prev) => ({ ...prev, [b.id]: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    style={{ width: 90 }}
                    aria-label={`${b.id} 实盘数量`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              stocktake(
                siteId,
                siteBatches
                  .filter((b) => qty[b.id] !== b.qtyMin)
                  .map((b) => ({ batchId: b.id, newQtyMin: qty[b.id] })),
              );
              onClose();
            }}
          >
            确认盘点修订
          </button>
        </div>
      </div>
    </div>
  );
}
