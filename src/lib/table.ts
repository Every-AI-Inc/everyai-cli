/**
 * Plain-text tables for human output, in the same layout as `every tools list`
 * and `every deal stages`: a header row, a dash row, then one row per record.
 * The last column is not padded. A cell longer than its column width ends in
 * "...".
 */

export interface TableColumn {
  header: string;
  /** The maximum width of the column. The last column has no limit by default. */
  max?: number;
}

/** One line of text: whitespace collapses, and a long value ends in "...". */
export function cell(value: unknown, max = 60): string {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

export function renderTable(columns: TableColumn[], rows: string[][]): string {
  const widths = columns.map((column, index) => {
    const longest = Math.max(column.header.length, ...rows.map((row) => (row[index] ?? '').length));
    return column.max === undefined ? longest : Math.min(column.max, longest);
  });
  const last = columns.length - 1;
  const line = (cells: string[]): string =>
    cells
      .map((value, index) => {
        const text = cell(value, columns[index].max ?? Number.MAX_SAFE_INTEGER);
        return index === last ? text : text.padEnd(widths[index]);
      })
      .join('  ')
      .trimEnd();
  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ].join('\n');
}

/** An ISO time as `YYYY-MM-DD HH:MM` (UTC), or the value as given when it does not parse. */
export function shortTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}
