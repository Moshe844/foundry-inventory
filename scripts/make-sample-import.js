'use strict';

/**
 * Writes the sample files used to try the import by hand.
 *
 * They are deliberately untidy in the ways real exports are — a title row, a
 * blank line, a price column Foundry does not track, an abbreviated heading, a
 * misspelled location, a missing quantity and a quantity that is not a number.
 * A clean file proves very little.
 *
 *   node scripts/make-sample-import.js
 *
 * Uses the `xlsx` dev dependency to *write* the workbook, so the file Foundry
 * reads was produced by a different implementation than the one reading it.
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', 'samples');

const STOCK = [
  ['Northwind Supply Co. — stock on hand', '', '', '', '', '', ''],
  ['Exported 14 August 2026', '', '', '', '', '', ''],
  ['', '', '', '', '', '', ''],
  ['Item Description', 'Item Code', 'Colour', 'Size', 'Whse', 'OH Qty', 'Unit Cost'],
  // A product Northwind already has: its stock is added to, never replaced.
  ['Copper Elbow 1/2 in.', 'CE-100', '', '', 'Main Warehouse', 60, 2.4],
  // Written another way, with no code: a resemblance, reported and not merged.
  ['1/2in Copper Elbow', '', '', '', 'Main Warehouse', 15, 2.4],
  // New, with two axes — one product with six versions, not six products.
  ['Harbour Work Glove', 'HG-400', 'Tan', 'M', 'Main Warehouse', 48, 7.5],
  ['Harbour Work Glove', 'HG-400', 'Tan', 'L', 'Main Warehouse', 36, 7.5],
  ['Harbour Work Glove', 'HG-400', 'Tan', 'XL', 'Downtown Store', 12, 7.5],
  ['Harbour Work Glove', 'HG-400', 'Black', 'M', 'Main Warehouse', 24, 7.9],
  ['Harbour Work Glove', 'HG-400', 'Black', 'L', 'Downtown Store', 18, 7.9],
  ['Harbour Work Glove', 'HG-400', 'Black', 'XL', 'Downtown Stroe', 6, 7.9],   // misspelled
  ['Brass Compression Nut 15mm', 'BN-015', '', '', 'Service Van 3', 90, 0.85],
  ['PTFE Tape 12m', 'PT-012', '', '', 'Main Warehouse', '', 0.4],              // no quantity
  ['Pipe Cutter 22mm', 'PC-022', '', '', 'Main Warehouse', 'call', 24],        // not a number
  ['', '', '', '', '', '', ''],
  ['Item Description', 'Item Code', 'Colour', 'Size', 'Whse', 'OH Qty', 'Unit Cost'],  // stacked export
  ['Solder Wire 500g', 'SW-500', '', '', 'Main Warehouse', 20, 11.2],
];

/** A lot-tracked delivery, for an inventory that counts by batch. */
const RECEIVING = [
  'Product,Batch,Qty,Where,Best Before',
  'Trail Ration Pack,B-260901,120,Main Warehouse,25/12/2026',
  'Trail Ration Pack,B-260915,80,Main Warehouse,08/01/2027',
  'Emergency Water Pouch,B-260820,240,Main Warehouse,30/06/2027',
].join('\n');

function main() {
  const XLSX = require('xlsx');
  fs.mkdirSync(OUT, { recursive: true });

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(STOCK), 'Stock On Hand');
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([['Notes'], ['Prices exclude tax'], ['Contact: ops@harbourclothing.test']]),
    'Notes'
  );
  const workbook = path.join(OUT, 'stock-on-hand.xlsx');
  fs.writeFileSync(workbook, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));

  const lots = path.join(OUT, 'lot-receiving.csv');
  fs.writeFileSync(lots, `${RECEIVING}\n`, 'utf8');

  console.log(`Wrote:\n  ${workbook}\n  ${lots}`);
  console.log('\nUpload either one at /imports. Nothing is created until you approve it.');
}

main();
