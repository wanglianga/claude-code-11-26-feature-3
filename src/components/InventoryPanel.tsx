import { useStore } from '../store/useStore';

/** 正式库存面板：正式余量、批准占用、在途量分列；缺换算资料单独显示不参与推演 */
export default function InventoryPanel() {
  const {
    batches,
    transfers,
    sites,
    drugs,
    missingConversions,
    packageSpecs,
    coldQuarantine,
  } = useStore();

  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const drugName = (code: string) => drugs.find((d) => d.code === code)?.name ?? code;
  const specOf = (code: string) => packageSpecs.find((p) => p.drugCode === code);

  // 批准未出库占用（站点+批次）
  const approved = new Map<string, number>();
  for (const t of transfers.filter((x) => x.status === 'approved' && !x.invalid)) {
    for (const l of t.lines) {
      const k = `${t.fromSiteId}__${l.batchId}`;
      approved.set(k, (approved.get(k) ?? 0) + l.qtyApprovedMin);
    }
  }
  // 在途余量（接收点视角）
  const inbound = new Map<string, number>();
  for (const t of transfers.filter((x) => x.status === 'shipped' || x.status === 'partially_received')) {
    for (const l of t.lines) {
      const remaining =
        l.qtyApprovedMin - l.receivedMin - l.damagedMin - l.quarantineMin;
      if (remaining > 0) {
        const k = `${t.toSiteId}__${l.batchId}`;
        inbound.set(k, (inbound.get(k) ?? 0) + remaining);
      }
    }
  }

  return (
    <section className="panel">
      <h2>
        正式库存与占用视图
        <span className="hint">
          正式余量为事件应用后的账面值；批准未出库与在途分别占用来源/未来接收库存，不再当自由余量；试算草稿不写正式库存
        </span>
      </h2>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>点位</th>
              <th>药品</th>
              <th>批次</th>
              <th>效期</th>
              <th className="num">正式余量</th>
              <th className="num">批准占用</th>
              <th className="num">在途未来到货</th>
              <th>包装口径</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => {
              const key = `${b.siteId}__${b.id}`;
              const spec = specOf(b.drugCode);
              return (
                <tr key={key}>
                  <td>{siteName(b.siteId)}</td>
                  <td>{drugName(b.drugCode)}</td>
                  <td className="mono">{b.id}</td>
                  <td className="mono">{b.expiry}</td>
                  <td className="num" style={{ fontWeight: 650 }}>{b.qtyMin}</td>
                  <td className="num warn-text">{approved.get(key) ?? 0}</td>
                  <td className="num" style={{ color: 'var(--arrival)' }}>{inbound.get(key) ?? 0}</td>
                  <td className="muted">
                    {spec
                      ? `${b.qtyMin} ${spec.minUnit} = ${(b.qtyMin / spec.unitsPerPack).toFixed(2)} ${spec.packUnit}`
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 18 }}>
        冷链到货隔离区（批准前不进正式库存、不参与调拨）
        <span className="hint">受影响批次先隔离；仅在冷链核查批准放行后才进入上方正式余量，签收不会自动可用</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>运输/箱体</th>
            <th>接收点位</th>
            <th>药品</th>
            <th>批次</th>
            <th>效期</th>
            <th className="num">隔离数量</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {coldQuarantine.map((q) => (
            <tr key={`${q.shipmentId}-${q.batchId}`} className={q.status === 'isolated' || q.status === 'held' ? 'missing-row' : ''}>
              <td className="mono">{q.shipmentId} / {q.boxId}</td>
              <td>{siteName(q.siteId)}</td>
              <td>{drugName(q.drugCode)}</td>
              <td className="mono">{q.batchId}</td>
              <td className="mono">{q.expiry}</td>
              <td className="num">{q.qtyMin}</td>
              <td>
                {q.status === 'released' ? (
                  <span className="badge ok">已批准进入可用余量</span>
                ) : q.status === 'held' ? (
                  <span className="badge danger">复核后继续隔离</span>
                ) : (
                  <span className="badge warn">隔离待处置</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 18 }}>
        缺换算资料（分开显示，禁止推断临床替代）
        <span className="hint">以下条目无显式包装关系，不换算、不纳入推演与候选</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>点位</th>
            <th>药品</th>
            <th>原始登记</th>
            <th className="num">包装数</th>
            <th>处理说明</th>
          </tr>
        </thead>
        <tbody>
          {missingConversions.map((m) => (
            <tr className="missing-row" key={m.id}>
              <td>{siteName(m.siteId)}</td>
              <td>{drugName(m.drugCode)} <span className="mono muted">{m.drugCode}</span></td>
              <td>{m.rawLabel}</td>
              <td className="num">{m.packQty}</td>
              <td className="warn-text">{m.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
