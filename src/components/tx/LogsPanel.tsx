import { Fragment } from 'react';
import type { ChainInfo, EvmLog } from '@/lib/types';
import { isEvmAddress } from '@/lib/detect';
import AddressDisplay from '@/components/AddressDisplay';
import Card from '@/components/Card';

/** Decoded event argument: addresses become links, everything else stays monospace text. */
function DecodedValue({ value, chain }: { value: string; chain: ChainInfo }) {
  if (isEvmAddress(value)) return <AddressDisplay address={value} chain={chain.id} short={false} copy />;
  return <span className="mono">{value}</span>;
}

/** Recognised events with their decoded arguments, plus a collapsible raw-log dump. */
export default function LogsPanel({ logs, chain }: { logs: EvmLog[]; chain: ChainInfo }) {
  const events = logs.filter((l) => l.eventName);
  const raw = logs.map(({ logIndex, address, topics, data }) => ({ logIndex, address, topics, data }));
  return (
    <Card title="Events" subtitle={`${logs.length} log${logs.length === 1 ? '' : 's'} · ${events.length} decoded`}>
      {events.length ? (
        <ul className="event-list">
          {events.map((l) => (
            <li key={l.logIndex} className="event">
              <div className="event__head">
                <span className="event__index">#{l.logIndex}</span>
                <span className="event__name">{l.eventName}</span>
                <AddressDisplay address={l.address} chain={chain.id} />
              </div>
              {l.decoded && Object.keys(l.decoded).length > 0 && (
                <dl className="kv kv--compact">
                  {Object.entries(l.decoded).map(([k, v]) => (
                    <Fragment key={k}>
                      <dt>{k}</dt>
                      <dd>
                        <DecodedValue value={String(v)} chain={chain} />
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No recognised events (Transfer, Approval, Swap, …) in this transaction.</p>
      )}
      <details className="details">
        <summary>Raw logs ({logs.length})</summary>
        <pre className="code code--tall">{JSON.stringify(raw, null, 2)}</pre>
      </details>
    </Card>
  );
}
