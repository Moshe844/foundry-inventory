'use strict';

const repo = require('../domain/repository');
const { NotFoundError, ValidationError } = require('../domain/errors');

// Code 128 patterns are widths of alternating bars and spaces. Set B covers
// every printable ASCII character used by StockChief codes without a font,
// browser plug-in or remote image service.
const CODE128 = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212',
  '112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131',
  '311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321',
  '112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121',
  '313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114',
  '122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212',
  '124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113',
  '114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112',
];

function code128Values(value) {
  const text = String(value || '');
  if (!text || [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)) {
    throw new ValidationError('Labels require printable ASCII characters.');
  }
  const data = [...text].map((char) => char.charCodeAt(0) - 32);
  let checksum = 104;
  data.forEach((code, index) => { checksum += code * (index + 1); });
  return [104, ...data, checksum % 103, 106];
}

function code128Svg(value, { height = 72, moduleWidth = 2 } = {}) {
  const patterns = code128Values(value).map((code) => CODE128[code]);
  const quiet = 10;
  const modules = patterns.reduce((sum, pattern) => sum + [...pattern].reduce((n, digit) => n + Number(digit), 0), 0);
  const width = (modules + quiet * 2) * moduleWidth;
  let x = quiet * moduleWidth;
  const bars = [];
  for (const pattern of patterns) {
    let bar = true;
    for (const digit of pattern) {
      const segment = Number(digit) * moduleWidth;
      if (bar) bars.push(`<rect x="${x}" y="0" width="${segment}" height="${height}"/>`);
      x += segment;
      bar = !bar;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Barcode ${escapeXml(value)}" data-barcode="${escapeXml(value)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${bars.join('')}</svg>`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}

function labelFor(db, workspaceId, kind, id) {
  if (kind === 'sku') {
    const sku = repo.requireSku(db, workspaceId, id);
    return { kind, id, title: sku.variant_label ? `${sku.item_name} — ${sku.variant_label}` : sku.item_name,
      subtitle: `SKU ${sku.code}`, barcode: sku.barcode || sku.code };
  }
  if (kind === 'location') {
    const location = repo.requireLocation(db, workspaceId, id);
    if (!location.barcode) throw new ValidationError(`${location.name} needs a barcode before its label can be printed.`);
    return { kind, id, title: location.name, subtitle: location.kind, barcode: location.barcode };
  }
  if (kind === 'lot') {
    const lot = repo.requireLot(db, workspaceId, id);
    const sku = repo.requireSku(db, workspaceId, lot.sku_id);
    return { kind, id, title: `Lot ${lot.code}`, subtitle: sku.variant_label ? `${sku.item_name} — ${sku.variant_label}` : sku.item_name,
      barcode: lot.code };
  }
  if (kind === 'serial') {
    const unit = repo.requireSerialUnit(db, workspaceId, id);
    const sku = repo.requireSku(db, workspaceId, unit.sku_id);
    return { kind, id, title: unit.serial, subtitle: sku.variant_label ? `${sku.item_name} — ${sku.variant_label}` : sku.item_name,
      barcode: unit.serial };
  }
  if (kind === 'container') {
    const row = db.prepare('SELECT * FROM warehouse_containers WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
    if (!row) throw new NotFoundError('That container could not be found.');
    return { kind, id, title: row.code, subtitle: row.kind, barcode: row.barcode };
  }
  throw new NotFoundError('That printable label could not be found.');
}

function verifyRoundTrip(label) {
  const values = code128Values(label.barcode);
  return values.length >= 4 && values[0] === 104 && values.at(-1) === 106;
}

module.exports = { code128Values, code128Svg, labelFor, verifyRoundTrip };
