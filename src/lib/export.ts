/**
 * Shared export helpers: CSV serialisation with spreadsheet formula-injection
 * protection, and a browser file download that never leaks blob URLs.
 */

export type CsvValue = string | number | bigint | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

/** Escape one CSV cell. Text starting with = + - @ TAB CR is prefixed with ' (CWE-1236). */
export function csvCell(value: CsvValue): string {
  if (value === undefined || value === null) return '';
  let s = typeof value === 'bigint' ? value.toString() : String(value);
  const dangerous = typeof value === 'string' && /^[=+\-@\t\r]/.test(s);
  if (dangerous) s = `'${s}`;
  return dangerous || /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows to CSV (CRLF line endings, header first). */
export function rowsToCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row))).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Make a safe download filename: ASCII letters, digits, dot, dash, underscore. */
export function safeFilename(name: string, fallback = 'export'): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  return cleaned || fallback;
}

/** Trigger a browser download of text content. No-op outside a DOM. */
export function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename(filename);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, csv: string): void {
  downloadText(filename.endsWith('.csv') ? filename : `${filename}.csv`, csv, 'text/csv;charset=utf-8');
}

export function downloadJson(filename: string, data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  downloadText(filename.endsWith('.json') ? filename : `${filename}.json`, text, 'application/json');
}
