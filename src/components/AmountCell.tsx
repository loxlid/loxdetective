import type { Amount } from '@/lib/types';
import { formatAmount, formatUsd } from '@/lib/format';

interface Props {
  amount: Amount;
  usd?: number;
  /** Colours and sign relative to the viewed address. */
  direction?: 'in' | 'out' | 'self' | 'unknown';
  /** Prefix +/− for in/out (default true when `direction` is given). */
  sign?: boolean;
  maxFraction?: number;
  /** Hide the symbol (when the column header already names it). */
  hideSymbol?: boolean;
  className?: string;
}

/** Token / native amount with symbol, optional USD line and direction colouring. */
export default function AmountCell({ amount, usd, direction, sign, maxFraction = 6, hideSymbol, className }: Props) {
  const showSign = sign ?? direction !== undefined;
  const prefix = showSign && amount.raw !== 0n ? (direction === 'in' ? '+' : direction === 'out' ? '−' : '') : '';
  const full = `${formatAmount(amount.raw, amount.decimals, Math.max(maxFraction, 18))} ${amount.symbol}`;
  return (
    <span className={`amount${direction ? ` amount--${direction}` : ''}${className ? ` ${className}` : ''}`} title={full}>
      <span className="amount__value mono">
        {prefix}
        {formatAmount(amount.raw, amount.decimals, maxFraction)}
        {!hideSymbol && amount.symbol && <span className="amount__symbol"> {amount.symbol}</span>}
      </span>
      {usd !== undefined && <span className="amount__usd">{formatUsd(usd)}</span>}
    </span>
  );
}
