import type { ChainId, TokenInfo } from '@/lib/types';
import AddressDisplay from '@/components/AddressDisplay';

/** Key/value block describing a token contract (name, symbol, decimals, standard, address). */
export default function TokenMeta({ token, chain }: { token: TokenInfo; chain: ChainId }) {
  return (
    <dl className="kv">
      <dt>Name</dt>
      <dd>{token.name || '—'}</dd>
      <dt>Symbol</dt>
      <dd className="mono">{token.symbol || '—'}</dd>
      <dt>Standard</dt>
      <dd>
        <span className="chip chip--token">{token.type}</span>
      </dd>
      <dt>Decimals</dt>
      <dd className="mono">{token.decimals}</dd>
      <dt>Contract</dt>
      <dd>
        <AddressDisplay address={token.address} chain={chain} short={false} showLabel={false} copy />
      </dd>
    </dl>
  );
}
