import { useStore } from '../store/useStore';
import type { DomainEvent, DomainEventType } from '../domain/types';

const TYPE_LABEL: Record<DomainEventType, string> = {
  'transfer.confirmed': '整组确认（审批）',
  'transfer.shipped': '出库在途',
  'transfer.received': '逐批签收',
  'transfer.cancelled': '取消（释放未发）',
  'transfer.returned': '回程登记',
  'transfer.return-received': '回程到货签收',
  'stocktake.adjusted': '盘点修订',
};

/** append-only 本地事件日志；重复事件被幂等忽略，拒收记录单独标红 */
export default function EventLog() {
  const events = useStore((s) => s.events);
  const rejected = useStore((s) => s.rejected);

  const detail = (ev: DomainEvent): string => {
    switch (ev.type) {
      case 'transfer.confirmed':
        return `单据：${ev.orders.map((o) => o.id).join(', ') || '（种子）'}`;
      case 'transfer.shipped':
        return `${ev.transferId} 出库日 ${ev.shipDate}`;
      case 'transfer.received':
        return `${ev.transferId} 行：${ev.lines
          .map((l) => `${l.batchId}(收${l.receivedMin}/损${l.damagedMin}/查${l.quarantineMin})`)
          .join('，')}`;
      case 'transfer.cancelled':
        return ev.transferId;
      case 'transfer.returned':
        return `${ev.transferId} 批次 ${ev.batchId} 回程 ${ev.qtyMin}，${ev.arriveDate} 到`;
      case 'transfer.return-received':
        return `${ev.transferId} / ${ev.returnId}`;
      case 'stocktake.adjusted':
        return `${ev.siteId} 修订 ${ev.adjustments.map((a) => `${a.batchId}=${a.newQtyMin}`).join('，')}`;
      default:
        return '';
    }
  };

  return (
    <section className="panel">
      <h2>
        本地事件日志
        <span className="hint">仅浏览器内适配器生成，不接真实医疗系统；事件 id 去重，乱序/重复不产生双份库存</span>
      </h2>
      <div className="event-log">
        {rejected.map((r) => (
          <div className="ev reject" key={`rej-${r.eventId}`}>
            <div>拒收事件 <span className="mono">{r.eventId}</span></div>
            <div className="meta">{r.reason}</div>
          </div>
        ))}
        {[...events].reverse().map((ev) => (
          <div className="ev" key={ev.id}>
            <div>
              <span className="badge central">{TYPE_LABEL[ev.type]}</span>
              <span className="mono muted" style={{ marginLeft: 8 }}>{ev.id}</span>
              <span className="meta" style={{ marginLeft: 8 }}>{ev.at}</span>
            </div>
            <div style={{ marginTop: 3 }}>{detail(ev)}</div>
            {ev.note && <div className="meta" style={{ marginTop: 2 }}>{ev.note}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
