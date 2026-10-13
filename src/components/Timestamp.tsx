import { formatDate, timeAgo } from '@/lib/format';

interface Props {
  /** Unix seconds. */
  ts?: number;
  /** 'ago' (default): relative with absolute tooltip; 'date': absolute UTC; 'both': both. */
  mode?: 'ago' | 'date' | 'both';
  className?: string;
}

/** Unix timestamp rendered as relative / absolute time. */
export default function Timestamp({ ts, mode = 'ago', className }: Props) {
  if (!ts) return <span className={`ts ts--empty${className ? ` ${className}` : ''}`}>—</span>;
  const iso = new Date(ts * 1000).toISOString();
  const abs = formatDate(ts);
  const rel = timeAgo(ts);
  return (
    <time className={`ts${className ? ` ${className}` : ''}`} dateTime={iso} title={mode === 'date' ? rel : abs}>
      {mode === 'ago' && rel}
      {mode === 'date' && abs}
      {mode === 'both' && (
        <>
          <span className="ts__rel">{rel}</span> <span className="ts__abs muted">{abs}</span>
        </>
      )}
    </time>
  );
}
