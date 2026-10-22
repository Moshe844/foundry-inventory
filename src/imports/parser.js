'use strict';

/**
 * Turning whatever the customer gave us into rows.
 *
 * Real inventory files are messy: stray title rows above the header, blank
 * lines, trailing empty columns, headers repeated part-way down where someone
 * pasted a second export underneath the first. None of that is the customer's
 * fault and none of it should require them to clean a file before Foundry will
 * look at it.
 *
 * Everything here is deterministic. No model is involved in reading bytes —
 * the model's job starts once there are rows and columns to reason about.
 */

const { readWorkbook, SpreadsheetError } = require('./xlsx-reader');
const config = require('../config');

const LIMITS = {
  // This is a safety ceiling, not a product tier. A 250k-SKU source must not
  // be silently truncated. Request bytes remain bounded independently.
  maxRows: 1000000,
  maxColumns: 512,
  maxBytes: config.uploads.maxBytes,
};

/** Splits delimited text, honouring quotes and embedded newlines. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"' && field === '') { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > LIMITS.maxRows + 1) throw new SpreadsheetError('This file exceeds the import row capacity. No rows were truncated or imported. Split the source into reviewed parts.');
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length > LIMITS.maxRows + 1) throw new SpreadsheetError('This file exceeds the import row capacity. No rows were truncated or imported. Split the source into reviewed parts.');
  return rows;
}

/** Whichever separator explains the text best. */
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 20).filter((line) => line.trim());
  if (sample.length === 0) return ',';

  const candidates = [',', '\t', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const delimiter of candidates) {
    // Title/date rows need not have the table's width. Compare the dominant
    // multi-column shape instead of requiring the first line to be a header.
    // Parse the sample together so quoted fields can contain line breaks.
    const counts = parseDelimited(sample.join('\n'), delimiter).map(row=>row.length);
    const frequencies = new Map();
    for(const count of counts)if(count>1)frequencies.set(count,(frequencies.get(count)||0)+1);
    const [columns,frequency]=[...frequencies].sort((a,b)=>b[1]-a[1]||b[0]-a[0])[0]||[];
    if (!columns) continue;
    const consistent = frequency / counts.length;
    const score = consistent * 10 + Math.min(columns, 20) * 0.1;
    if (score > bestScore) { bestScore = score; best = delimiter; }
  }
  return best;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const isBlank = (row) => row.every((cell) => String(cell ?? '').trim() === '');

/**
 * Finds the header row and trims what surrounds it.
 *
 * Files often open with a title, a date, a blank line, and only then the real
 * header. The header is the first row that looks like labels: several non-empty
 * cells, mostly non-numeric, and followed by a row of the same width.
 */
/**
 * Whether a row reads as labels rather than data.
 *
 * Pasted data often has no header at all, and treating its first line as one
 * silently swallows a real record. A row containing a bare number is data.
 */
function looksLikeHeader(row) {
  if (!row) return false;
  const filled = row.map((c) => String(c ?? '').trim()).filter(Boolean);
  if (filled.length < 2) return false;
  return !filled.some((cell) => /^-?[\d.,]+$/.test(cell));
}

function locateHeader(rows) {
  const limit = Math.min(rows.length, 25);
  let best = { index: -1, score: -1 };

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    if (!row || isBlank(row)) continue;
    const filled = row.filter((c) => String(c ?? '').trim() !== '');
    if (filled.length < 2) continue;

    const numeric = filled.filter((c) => /^-?[\d.,]+$/.test(String(c).trim())).length;
    const next = rows.slice(i + 1).find((r) => r && !isBlank(r));
    const widthAgrees = next ? Math.abs(next.length - row.length) <= 1 : false;

    const score =
      filled.length * 2 -
      numeric * 3 +                 // headers are words, not figures
      (widthAgrees ? 6 : 0) +
      (next ? 4 : 0) -
      i * 0.5;                      // earlier is likelier, all else equal
    if (score > best.score) best = { index: i, score };
  }
  return best.index === -1 ? 0 : best.index;
}

/** Gives every column a usable name, keeping the original for display. */
function nameColumns(header, width) {
  const names = [];
  const seen = new Map();
  for (let i = 0; i < width; i += 1) {
    const raw = String(header[i] ?? '').trim();
    let name = raw || `Column ${i + 1}`;
    if (seen.has(name.toLowerCase())) {
      const count = seen.get(name.toLowerCase()) + 1;
      seen.set(name.toLowerCase(), count);
      name = `${name} (${count})`;
    } else {
      seen.set(name.toLowerCase(), 1);
    }
    names.push({ index: i, name, original: raw });
  }
  return names;
}

/**
 * @returns {{ columns, rows, headerRowIndex, droppedBlankRows, repeatedHeaderRows }}
 */
function tabulate(grid) {
  const rows = grid.filter((row) => Array.isArray(row));
  const candidate = locateHeader(rows);
  // No header at all is a normal shape for pasted data. Inventing one out of
  // the first record would quietly lose that record.
  const headerless = !looksLikeHeader(rows[candidate]);
  const headerRowIndex = headerless ? -1 : candidate;
  const header = headerless ? [] : rows[headerRowIndex] || [];

  const width = rows.slice(Math.max(headerRowIndex, 0)).reduce((max, row) => Math.max(max, row.length), header.length);
  if(width>LIMITS.maxColumns)throw new SpreadsheetError('This file exceeds the import column capacity. No columns were silently dropped.');
  const columns = nameColumns(header, width);

  // A column that is empty everywhere is noise from a spreadsheet's used-range.
  const used = new Set();
  const body = [];
  let droppedBlankRows = 0;
  let repeatedHeaderRows = 0;

  const headerSignature = header.map((c) => String(c ?? '').trim().toLowerCase()).join('\0');

  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || isBlank(row)) { droppedBlankRows += 1; continue; }

    // The same header again, part-way down: two exports stacked in one file.
    const signature = row.map((c) => String(c ?? '').trim().toLowerCase()).join('\0');
    if (signature === headerSignature) { repeatedHeaderRows += 1; continue; }

    const cells = [];
    for (let c = 0; c < width; c += 1) {
      const value = String(row[c] ?? '').trim();
      cells.push(value);
      if (value !== '') used.add(c);
    }
    body.push({ sourceRow: i + 1, cells });
    if (body.length > LIMITS.maxRows) throw new SpreadsheetError('This file exceeds the import row capacity. No rows were truncated or imported.');
  }

  // Spreadsheets carry empty trailing columns from their used range. Dropping
  // them from the header but not the rows would misalign every value, so the
  // rows are re-indexed onto exactly the columns that survive.
  const kept = columns.filter((column) => used.has(column.index) || column.original !== '');
  const keptIndexes = kept.map((column) => column.index);
  const aligned = body.map((row) => ({
    sourceRow: row.sourceRow,
    cells: keptIndexes.map((index) => row.cells[index] ?? ''),
  }));

  return {
    columns: kept.map((column, position) => ({ ...column, index: position, sourceIndex: column.index })),
    rows: aligned,
    // The title rows above the header. Dropped from the data, kept here because
    // they are often the only place a file says when it was true — "Exported 12
    // August 2026" decides which of two files is the newer one.
    preamble: rows.slice(0, Math.max(headerRowIndex, 0)).map((row) => row.map((cell) => String(cell ?? '').trim())),
    headerRowIndex,
    headerless,
    droppedBlankRows,
    repeatedHeaderRows,
  };
}

/** CSV, TSV or anything pasted out of a spreadsheet. */
function parseText(text) {
  const clean = stripBom(String(text || ''));
  if (!clean.trim()) throw new SpreadsheetError('There was nothing in that.');
  const delimiter = detectDelimiter(clean);
  return { sheets: [{ name: 'Pasted data', grid: parseDelimited(clean, delimiter), delimiter }] };
}

function parseWorkbook(buffer) {
  // Normalize a worksheet before reading the next one, rather than retaining
  // all raw grids alongside another complete copy of the normalized workbook.
  return readWorkbook(buffer, { transformSheet: (sheet) => ({ name: sheet.name, ...tabulate(sheet.rows) }) });
}

function decodeText(buffer){
  const encoding=buffer[0]===0xff&&buffer[1]===0xfe?'utf-16le':buffer[0]===0xfe&&buffer[1]===0xff?'utf-16be':'utf-8';
  try{return new TextDecoder(encoding,{fatal:true}).decode(buffer);}
  catch{throw new SpreadsheetError('This text file’s character encoding could not be read safely. Save it as UTF-8 or UTF-16 and upload it again. No inventory changed.');}
}

/**
 * Reads an upload or a paste into named sheets of tabulated rows.
 *
 * @param {{ buffer?: Buffer, text?: string, filename?: string }} input
 */
function parse(input) {
  if (input.buffer && input.buffer.length > LIMITS.maxBytes) {
    throw new SpreadsheetError('That file is larger than StockChief can read.');
  }

  // The bytes decide, not the name. A workbook always starts with the ZIP
  // magic number, and a CSV somebody renamed to .xlsx is still a CSV — reading
  // it by its extension would fail on a file StockChief can perfectly well read.
  const looksXlsx =
    Boolean(input.buffer) && input.buffer.length > 4 && input.buffer.readUInt32LE(0) === 0x04034b50;

  const extension=String(input.filename||'').split('.').at(-1).toLowerCase();
  if(['heic','heif','tif','tiff'].includes(extension))throw new SpreadsheetError('This '+extension.toUpperCase()+' file could not be opened as a readable image. Upload a fresh copy. No inventory changed.');
  // Decode text only. Binary archives retain their bytes and do not allocate a
  // second, lossy UTF-8 copy before the bounded workbook reader opens them.
  const sourceText=input.text ?? (looksXlsx?'':decodeText(input.buffer||Buffer.alloc(0)));
  if(extension==='xml'||/^\s*<\?xml|^\s*<[a-zA-Z][^>]*>/.test(sourceText)&&!looksXlsx)throw new SpreadsheetError('XML product imports are not supported yet. Export the product list as JSON, CSV or XLSX; no inventory changed.');
  const parsed = looksXlsx
    ? require('./structured-files').archive(input.buffer)||parseWorkbook(input.buffer)
    : extension==='json'||/^\s*[\[{]/.test(sourceText)?require('./structured-files').json(Buffer.from(sourceText))
    : parseText(sourceText);

  // Named like a workbook but not one. A CSV somebody renamed reads perfectly
  // well and should just work; a corrupt or wrong file parses into a single
  // meaningless column, and reading that as inventory would be worse than
  // saying so.
  if (!looksXlsx && /\.xlsx$/i.test(String(input.filename || ''))) {
    const widest = parsed.sheets.reduce((max, sheet) => Math.max(max, sheet.grid.reduce((w, row) => Math.max(w, row.length), 0)), 0);
    if (widest < 2) {
      throw new SpreadsheetError('That file is not a readable spreadsheet.');
    }
  }

  const sheets = parsed.sheets.map((sheet) => sheet.columns ? sheet : ({ name: sheet.name, ...tabulate(sheet.grid) }));
  // The sheet with the most rows is nearly always the data; the rest are notes.
  const primary = sheets.reduce(
    (best, sheet, index) => (sheet.rows.length > sheets[best].rows.length ? index : best),
    0
  );
  return { sheets, primarySheet: primary, format: looksXlsx ? 'xlsx' : 'delimited' };
}

module.exports = {
  parse,
  parseText,
  parseDelimited,
  detectDelimiter,
  tabulate,
  locateHeader,
  looksLikeHeader,
  nameColumns,
  LIMITS,
  SpreadsheetError,
};
