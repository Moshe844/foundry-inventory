'use strict';

/**
 * Spreadsheet formats StockChief's own readers do not open: Excel 97-2003
 * (.xls), binary workbooks (.xlsb), Excel 2003 XML and HTML
 * tables that web systems export under an .xls name.
 *
 * SheetJS reads them into plain cell grids; formulas, macros, styles and links
 * are never evaluated or kept. The same library already reads customer .xls
 * documents in document-text.js, and this pinned release carries the fixes for
 * its published prototype-pollution and ReDoS advisories.
 */

const { SpreadsheetError, LIMITS } = require('./xlsx-reader');

function cell(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  return value == null ? '' : String(value);
}

/** @returns {{ sheets: { name: string, grid: string[][] }[] }} */
function read(source, { type = 'buffer' } = {}) {
  const XLSX = require('xlsx');
  let book;
  try {
    book = XLSX.read(source, { type, dense: true, cellDates: true, cellFormula: false, cellHTML: false,
      cellStyles: false, bookVBA: false, bookFiles: false });
  } catch {
    throw new SpreadsheetError('That spreadsheet could not be opened. Save it again from Excel, or export it as CSV. No inventory changed.');
  }
  const sheets = [];
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.c - range.s.c + 1 > LIMITS.maxColumns) throw new SpreadsheetError('This file exceeds the import column capacity. No columns were silently dropped.');
    if (range.e.r - range.s.r + 1 > LIMITS.maxRows + 1) throw new SpreadsheetError('This file exceeds the import row capacity. No rows were truncated or imported. Split the source into reviewed parts.');
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false }).map((row) => row.map(cell));
    if (grid.some((row) => row.some((value) => value.trim()))) sheets.push({ name, grid });
  }
  if (!sheets.length) throw new SpreadsheetError('That spreadsheet has no readable table. No inventory changed.');
  return { sheets };
}

module.exports = { read };
