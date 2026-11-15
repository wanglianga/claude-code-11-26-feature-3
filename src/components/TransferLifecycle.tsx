import { useState } from 'react';
import { useStore } from '../store/useStore';
import { routeKey } from '../domain/projection';
import type { TransferOrder, TransferStatus } from '../domain/types';
import ReceiveModal from './ReceiveModal';
import StocktakeModal from './StocktakeModal';

const STATUS_LABEL: Record<TransferStatus, { text: string; cls: string }> = {
  draft: { text: '草稿（试算）', cls: 'muted' },
  approved: { text: '批准未出库', cls: 'warn' },
  shipped: { text: '在途', cls: 'central' },
  partially_received: { text: '部分签收', cls: 'warn' },
  received: { text: '签收完成', cls: 'ok' },
  cancelled: { text: '已取消', cls: 'muted' },
};

export default function TransferLifecycle() {
  const {
    transfers,
    sites,
    drugs,
    transport,
    user,
    confirmDrafts,
    shipOrder,
    cancelOrder,
    registerReturn,
    receiveReturn,
    toggleLock,
    recalc,
    removeDraft,
  } = useStore();

  const [receiveTarget, setReceiveTarget] = useState<TransferOrder | null>(null);
  const [stocktakeSite, setStocktakeSite] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [returnQty, setReturnQty] = useState<Record<string, number>>({});

  const readOnly = user?.role === 'viewer';
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const drugName = (code: string) => drugs.find((d) => d.code === code)?.name ?? code;

  const drafts = transfers.filter((t) => t.status === 'draft');
  const actives = transfers.filter((t) => t.status !== 'draft' && t.status !== 'cancelled');
  const cancelled = transfers.filter((t) => t.status === 'cancelled');

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderOrder = (t: TransferOrder) => {
    const st = STATUS_LABEL[t.status];
    return (
      <div className="order-card" key={t.id} style={t.invalid ? { borderColor: 'var(--danger)', background: 'var(--danger-soft)' } : undefined}>
        <div className="head">
          <div className="title">
            <span className="mono">{t.id}</span>
            <span className={`badge ${st.cls}`} style={{ margin: '0 6px' }}>{st.text}</span>
            {t.locked && <span className="badge central">已锁定</span>}
            {t.invalid && <span className="badge danger">盘点后失效</span>}
            {t.reviewRequired && <span className="badge warn">待复核</span>}
          </div>
          <div className="muted mono" style={{ fontSize: 11.5 }}>
            {siteName(t.fromSiteId)} → {siteName(t.toSiteId)} · {drugName(t.drugCode)} · 发 {t.plannedShipDate} / 到 {t.arriveDate}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{t.basis}</div>
        <table>
          <thead>
            <tr>
              <th>批次（效期）</th>
              <th className="num">批准/发出</th>
              <th className="num">实收</th>
              <th className="num">破损</th>
              <th className="num">待查</th>
              <th className="num">在途余量</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l) => {
              const settled = l.receivedMin + l.damagedMin + l.quarantineMin;
              return (
                <tr key={l.batchId}>
                  <td className="mono">{l.batchId}<span className="muted">（{l.expiry}）</span></td>
                  <td className="num">{l.qtyApprovedMin}</td>
                  <td className="num ok-text">{l.receivedMin}</td>
                  <td className="num warn-text">{l.damagedMin}</td>
                  <td className="num warn-text">{l.quarantineMin}</td>
                  <td className="num">{l.qtyApprovedMin - settled}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {t.conflictReason && (
          <div className="notice error" style={{ marginTop: 8 }}>锁定冲突：{t.conflictReason}</div>
        )}

        <div className="pill-row" style={{ marginTop: 10 }}>
          {t.status === 'draft' && (
            <>
              <label className="site-chip" style={{ padding: '4px 8px' }}>
                <input
                  type="checkbox"
                  checked={picked.has(t.id)}
                  disabled={t.invalid}
                  onChange={() => togglePick(t.id)}
                />
                加入本次整组确认
              </label>
              <button className="small" disabled={readOnly} onClick={() => toggleLock(t.id)}>
                {t.locked ? '解锁' : '锁定重算保留'}
              </button>
              <button className="small danger" disabled={readOnly} onClick={() => removeDraft(t.id)}>
                移除草稿
              </button>
            </>
          )}
          {t.status === 'approved' && (
            <>
              <button className="small primary" disabled={readOnly} onClick={() => shipOrder(t.id)}>
                出库（批准占用转在途，不二次扣余额）
              </button>
              <button className="small danger" disabled={readOnly} onClick={() => cancelOrder(t.id)}>
                取消（释放未发占用）
              </button>
            </>
          )}
          {(t.status === 'shipped' || t.status === 'partially_received') && (
            <>
              <button className="small primary" disabled={readOnly} onClick={() => setReceiveTarget(t)}>
                逐批签收
              </button>
              <button className="small danger" disabled={readOnly} onClick={() => cancelOrder(t.id)}>
                尝试取消（应被拒）
              </button>
            </>
          )}
          {t.status === 'received' && <span className="badge ok">全部数量已逐批结清</span>}
        </div>

        {/* 回程：仅对已实收批次可登记，到货前不恢复来源可用 */}
        {(t.status === 'shipped' || t.status === 'partially_received' || t.status === 'received') && (
          <div className="detail-box" style={{ marginTop: 8 }}>
            <strong>已发退回（回程到货恢复，不直接回补来源）</strong>
            {t.lines.filter((l) => l.receivedMin > 0).map((l) => {
              const key = `${t.id}-${l.batchId}`;
              const returning = t.returns
                .filter((r) => r.batchId === l.batchId && !r.received)
                .reduce((s, r) => s + r.qtyMin, 0);
              const maxReturn = l.receivedMin - returning;
              return (
                <div key={l.batchId} className="pill-row" style={{ alignItems: 'center' }}>
                  <span className="mono">{l.batchId}</span>
                  <span className="muted">可退回 {maxReturn}</span>
                  <input
                    type="number"
                    min={0}
                    max={maxReturn}
                    style={{ width: 80 }}
                    value={returnQty[key] ?? 0}
                    onChange={(e) =>
                      setReturnQty((prev) => ({ ...prev, [key]: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    aria-label={`${l.batchId} 回程数量`}
                  />
                  <button
                    className="small"
                    disabled={readOnly || maxReturn <= 0 || !(returnQty[key] > 0)}
                    onClick={() => {
                      registerReturn(t.id, l.batchId, returnQty[key] ?? 0);
                      setReturnQty((prev) => ({ ...prev, [key]: 0 }));
                    }}
                  >
                    登记回程（路线 {transport[routeKey(t.fromSiteId, t.toSiteId)] ?? '?'} 天）
                  </button>
                </div>
              );
            })}
            {t.returns.map((r) => (
              <div key={r.id} className="pill-row" style={{ alignItems: 'center' }}>
                <span className="mono">{r.id}</span>
                <span className="muted">{r.batchId} {r.qtyMin} ｜ {r.shipDate} 发 → {r.arriveDate} 到</span>
                {r.received ? (
                  <span className="badge ok">回程已签收</span>
                ) : (
                  <button className="small" disabled={readOnly} onClick={() => receiveReturn(t.id, r.id)}>
                    回程到货签收
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="panel">
      <h2>
        调拨工作台
        <span className="hint">试算与正式库存分离；确认整组预检、部分失败整组退回；重复事件与乱序签收幂等</span>
      </h2>

      <div className="pill-row" style={{ marginBottom: 12 }}>
        <button className="small" onClick={recalc}>按当前库存重算（锁定项保留并标注冲突）</button>
        <button
          className="small primary"
          disabled={readOnly || picked.size === 0}
          onClick={() => {
            confirmDrafts([...picked]);
            setPicked(new Set());
          }}
        >
          整组确认所选草稿（{picked.size}）
        </button>
        {sites.map((s) => (
          <button key={s.id} className="small" disabled={readOnly} onClick={() => setStocktakeSite(s.id)}>
            盘点：{s.name}
          </button>
        ))}
      </div>

      <h2 style={{ fontSize: 13.5 }}>草稿（{drafts.length}）</h2>
      {drafts.length === 0 && <div className="muted" style={{ marginBottom: 10 }}>暂无草稿，可从「调拨候选」面板加入。</div>}
      {drafts.map(renderOrder)}

      <h2 style={{ fontSize: 13.5, marginTop: 16 }}>已批准 / 在途 / 签收（{actives.length}）</h2>
      {actives.map(renderOrder)}

      {cancelled.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>已取消单据（{cancelled.length}）</summary>
          {cancelled.map(renderOrder)}
        </details>
      )}

      {receiveTarget && (
        <ReceiveModal order={receiveTarget} onClose={() => setReceiveTarget(null)} />
      )}
      {stocktakeSite && (
        <StocktakeModal siteId={stocktakeSite} onClose={() => setStocktakeSite(null)} />
      )}
    </section>
  );
}
