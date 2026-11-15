import { useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import type { TransferOrder } from '../domain/types';

interface Props {
  order: TransferOrder;
  onClose: () => void;
}

interface RowState {
  received: number;
  damaged: number;
  quarantine: number;
}

/** 逐批签收弹窗：不同批次装在同一调拨单也须逐批签收，禁止只确认单头 */
export default function ReceiveModal({ order, onClose }: Props) {
  const receiveOrder = useStore((s) => s.receiveOrder);
  const [rows, setRows] = useState<RowState[]>(
    order.lines.map(() => ({ received: 0, damaged: 0, quarantine: 0 })),
  );

  const lineState = order.lines.map((line, i) => {
    const settled = line.receivedMin + line.damagedMin + line.quarantineMin;
    const remaining = line.qtyApprovedMin - settled;
    const r = rows[i];
    const addSum = r.received + r.damaged + r.quarantine;
    return { line, remaining, addSum, valid: addSum <= remaining && addSum > 0, exact: addSum === remaining };
  });

  const allValid = lineState.every((x) => x.valid);
  const allExact = lineState.every((x) => x.exact);
  const totalAdd = useMemo(
    () => rows.reduce((s, r) => s + r.received + r.damaged + r.quarantine, 0),
    [rows],
  );

  const set = (i: number, field: keyof RowState, raw: string) => {
    const v = Math.max(0, Number(raw) || 0);
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>逐批签收 · {order.id}</h3>
        <div className="notice warn">
          每批次须逐行登记；本次「实收 + 破损 + 待查」之和不得超过本次未结清发出量。
          少到部分停在待查/在途，不直接退回来源可用。
        </div>
        <table>
          <thead>
            <tr>
              <th>批次 / 效期</th>
              <th className="num">发出</th>
              <th className="num">已结清</th>
              <th className="num">本次实收</th>
              <th className="num">破损</th>
              <th className="num">待查（少到）</th>
              <th className="num">本次合计</th>
            </tr>
          </thead>
          <tbody>
            {lineState.map((x, i) => (
              <tr key={x.line.batchId}>
                <td>
                  <div className="mono">{x.line.batchId}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>效期 {x.line.expiry}</div>
                </td>
                <td className="num">{x.line.qtyApprovedMin}</td>
                <td className="num muted">
                  {x.line.receivedMin + x.line.damagedMin + x.line.quarantineMin}
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={x.remaining}
                    value={rows[i].received}
                    onChange={(e) => set(i, 'received', e.target.value)}
                    style={{ width: 78 }}
                    aria-label={`${x.line.batchId} 实收`}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={x.remaining}
                    value={rows[i].damaged}
                    onChange={(e) => set(i, 'damaged', e.target.value)}
                    style={{ width: 64 }}
                    aria-label={`${x.line.batchId} 破损`}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    min={0}
                    max={x.remaining}
                    value={rows[i].quarantine}
                    onChange={(e) => set(i, 'quarantine', e.target.value)}
                    style={{ width: 78 }}
                    aria-label={`${x.line.batchId} 待查`}
                  />
                </td>
                <td className="num">
                  <span className={x.valid ? 'ok-text' : 'danger-text'}>{x.addSum}</span>
                  <span className="muted"> / {x.remaining}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          本次登记总量：{totalAdd}；{allExact ? '全部批次本次结清' : '存在未结清余量，将继续在途/待查'}
        </div>
        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={!allValid || totalAdd === 0}
            onClick={() => {
              receiveOrder(
                order.id,
                order.lines.map((l, i) => ({
                  batchId: l.batchId,
                  receivedMin: rows[i].received,
                  damagedMin: rows[i].damaged,
                  quarantineMin: rows[i].quarantine,
                })),
              );
              onClose();
            }}
          >
            提交逐批签收
          </button>
        </div>
      </div>
    </div>
  );
}
