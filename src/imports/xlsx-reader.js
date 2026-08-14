'use strict';

/**
 * A small, read-only XLSX reader.
 *
 * Customers upload these files, which makes the parser an attack surface: the
 * widely used library for this has unfixed prototype-pollution and ReDoS
 * advisories, and pointing it at untrusted uploads would be a poor trade for
 * saving a day's work. An .xlsx is a ZIP of XML, and reading cell values out of
 * one is a bounded problem, so Foundry does it itself.
 *
 * Deliberately narrow: it reads sheets, rows and cell values. It does not
 * evaluate formulas (it reads their cached results), does not follow external
 * references, and never constructs objects from file-supplied keys.
 *
 * The tests check it against files written by a different implementation, so
 * this is not marking its own homework.
 */

const zlib = require('node:zlib');

const LIMITS = {
  maxEntries: 512,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRows: 200000,
  maxColumns: 512,
};

class SpreadsheetError extends Error {
  constructor(message) {
    super(message);
    this.code = 'spreadsheet_unreadable';
  }
}

// --- the ZIP container -------------------------------------------------------

/** Locates the end-of-central-directory record, which is at the tail. */
function findEndOfCentralDirectory(buffer) {
  const minimum = 22;
  const from = Math.max(0, buffer.length - (minimum + 0xffff));
  for (let i = buffer.length - minimum; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new SpreadsheetError('That file is not a readable spreadsheet.');
}

/**
 * Reads every entry into a map of name → Buffer.
 *
 * Bounded on entry count and decompressed size: a zip bomb is a file anybody
 * can upload, and "the server fell over" is not an acceptable answer to it.
 */
function readZip(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  if (entryCount > LIMITS.maxEntries) throw new SpreadsheetError('That spreadsheet has too many parts.');

  const files = new Map();
  let total = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (uncompressedSize > LIMITS.maxEntryBytes) throw new SpreadsheetError('That spreadsheet is too large to read.');
    total += uncompressedSize;
    if (total > LIMITS.maxTotalBytes) throw new SpreadsheetError('That spreadsheet is too large to read.');

    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      try {
        files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: LIMITS.maxEntryBytes }));
      } catch {
        throw new SpreadsheetError('Part of that spreadsheet could not be read.');
      }
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// --- the XML inside ----------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] !== undefined ? ENTITIES[entity] : whole;
  });
}

/** All the text inside one element, runs included. */
function textOf(fragment) {
  const parts = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
  let match;
  while ((match = re.exec(fragment)) !== null) parts.push(decodeXml(match[1] || ''));
  return parts.join('');
}

function readSharedStrings(files) {
  const xml = files.get('xl/sharedStrings.xml');
  if (!xml) return [];
  const text = xml.toString('utf8');
  const strings = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let match;
  while ((match = re.exec(text)) !== null) strings.push(textOf(match[1] || ''));
  return strings;
}

/** Which style indexes format their number as a date. */
function readDateStyles(files) {
  const xml = files.get('xl/styles.xml');
  const dateStyles = new Set();
  if (!xml) return dateStyles;
  const text = xml.toString('utf8');

  // Built-in formats that are dates, plus any custom one whose code has y/m/d.
  const builtinDates = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const customDates = new Set();
  const numFmtRe = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let match;
  while ((match = numFmtRe.exec(text)) !== null) {
    const code = decodeXml(match[2]).replace(/\[[^\]]*\]/g, '').toLowerCase();
    if (/[dmy]/.test(code) && !/^[#0.,%\s]*$/.test(code)) customDates.add(Number(match[1]));
  }

  const cellXfs = text.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  if (!cellXfs) return dateStyles;
  const xfRe = /<xf\b[^>]*>/g;
  let index = 0;
  while ((match = xfRe.exec(cellXfs[0])) !== null) {
    const id = /numFmtId="(\d+)"/.exec(match[0]);
    const numFmtId = id ? Number(id[1]) : 0;
    if (builtinDates.has(numFmtId) || customDates.has(numFmtId)) dateStyles.add(index);
    index += 1;
  }
  return dateStyles;
}

/** "BC12" → 54 (zero-based column index). */
function columnIndex(reference) {
  const letters = /^([A-Z]+)/.exec(String(reference).toUpperCase());
  if (!letters) return 0;
  let value = 0;
  for (const char of letters[1]) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

/** Excel's day-serial to an ISO date, using its 1900 epoch (leap-year bug and all). */
function serialToDate(serial) {
  const value = Number(serial);
  if (!Number.isFinite(value) || value <= 0 || value > 2958465) return null;
  const utc = Date.UTC(1899, 11, 30) + Math.round(value) * 86400000;
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function readSheet(xml, sharedStrings, dateStyles) {
  const text = xml.toString('utf8');
  const rows = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row\s[^>]*\/>/g;
  let rowMatch;

  while ((rowMatch = rowRe.exec(text)) !== null) {
    if (rows.length >= LIMITS.maxRows) break;
    const body = rowMatch[1] || '';
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;

    while ((cellMatch = cellRe.exec(body)) !== null) {
      const attributes = cellMatch[1] || '';
      const content = cellMatch[2] || '';
      const reference = /r="([A-Z]+\d+)"/.exec(attributes);
      const index = reference ? columnIndex(reference[1]) : cells.length;
      if (index >= LIMITS.maxColumns) continue;

      const type = /t="([^"]+)"/.exec(attributes);
      const style = /s="(\d+)"/.exec(attributes);
      const valueMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(content);
      const raw = valueMatch ? decodeXml(valueMatch[1]) : '';

      let value = '';
      const kind = type ? type[1] : 'n';
      if (kind === 's') {
        const stringIndex = Number(raw);
        value = Number.isInteger(stringIndex) ? sharedStrings[stringIndex] ?? '' : '';
      } else if (kind === 'inlineStr') {
        value = textOf(content);
      } else if (kind === 'str') {
        value = raw;
      } else if (kind === 'b') {
        value = raw === '1' ? 'TRUE' : 'FALSE';
      } else if (kind === 'e') {
        value = raw; // an error cell, kept as its text so a person can see it
      } else if (raw !== '') {
        const styleIndex = style ? Number(style[1]) : 0;
        const asDate = dateStyles.has(styleIndex) ? serialToDate(raw) : null;
        value = asDate || raw;
      }

      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Sheet names in workbook order, paired with their part inside the zip. */
function sheetParts(files) {
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) throw new SpreadsheetError('That file is not a readable spreadsheet.');
  const rels = files.get('xl/_rels/workbook.xml.rels');

  const targets = new Map();
  if (rels) {
    const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    let match;
    while ((match = relRe.exec(rels.toString('utf8'))) !== null) {
      const target = decodeXml(match[2]).replace(/^\/?xl\//, '').replace(/^\//, '');
      targets.set(match[1], target);
    }
  }

  const sheets = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let match;
  while ((match = sheetRe.exec(workbook.toString('utf8'))) !== null) {
    const name = /name="([^"]*)"/.exec(match[1]);
    const rid = /r:id="([^"]+)"/.exec(match[1]);
    const target = rid ? targets.get(rid[1]) : null;
    const path = target ? `xl/${target}` : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name: name ? decodeXml(name[1]) : `Sheet${sheets.length + 1}`, path });
  }
  return sheets;
}

/**
 * @returns {{ sheets: Array<{ name: string, rows: string[][] }> }}
 */
function readWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new SpreadsheetError('That file is empty or not a spreadsheet.');
  }
  const files = readZip(buffer);
  const sharedStrings = readSharedStrings(files);
  const dateStyles = readDateStyles(files);

  const sheets = sheetParts(files)
    .map(({ name, path }) => {
      const part = files.get(path) || files.get(path.replace('xl/', 'xl/worksheets/'));
      return part ? { name, rows: readSheet(part, sharedStrings, dateStyles) } : null;
    })
    .filter(Boolean);

  if (sheets.length === 0) throw new SpreadsheetError('That spreadsheet has no readable sheets.');
  return { sheets };
}

module.exports = { readWorkbook, SpreadsheetError, LIMITS, columnIndex, serialToDate, decodeXml };
