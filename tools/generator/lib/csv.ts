export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(content: string): ParsedCsv {
  const rows = parseCsvRows(content)
    .map((row) => row.map((cell) => normalizeCell(cell)))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (rows.length === 0) {
    return { headers: [], rows: [] };
  }

  const headerIndex = detectHeaderIndex(rows);
  const headers = rows[headerIndex] ?? [];
  const body = rows.slice(headerIndex + 1);

  return {
    headers,
    rows: body,
  };
}

export function buildCsvSummary(content: string, maxRows = 120): string {
  const parsed = parseCsv(content);
  const summary = {
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    sampleRows: parsed.rows.slice(0, maxRows),
    weekdayColumns: detectWeekdayColumns(parsed.headers),
  };
  return JSON.stringify(summary, null, 2);
}

function detectHeaderIndex(rows: string[][]): number {
  let bestIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i];
    const nonEmpty = row.filter((cell) => cell.trim().length > 0).length;
    const weekdayHits = row.filter((cell) => isWeekdayCell(cell)).length;
    const score = nonEmpty + weekdayHits * 2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function detectWeekdayColumns(headers: string[]): Array<{ index: number; header: string }> {
  return headers
    .map((header, index) => ({ index, header }))
    .filter((entry) => isWeekdayCell(entry.header));
}

function isWeekdayCell(value: string): boolean {
  return /(?:月|火|水|木|金|土|日|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(
    value
  );
}

function normalizeCell(value: string): string {
  return normalizeFullWidthDigits(value)
    .replace(/\uFEFF/g, "")
    .replace(/\r/g, "")
    .trim();
}

export function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        i++;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}
