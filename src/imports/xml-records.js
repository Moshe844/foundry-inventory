'use strict';

/**
 * A product list exported as XML:
 *   <products><product sku="A1"><name>…</name><stock>4</stock></product>…</products>
 *
 * The record is the repeated element that holds simple values; its attributes
 * and simple child values become the columns. Nothing in the file is fetched,
 * expanded or executed: entity declarations and DOCTYPEs are dropped, and only
 * the five standard entities and numeric references are decoded.
 */

const { SpreadsheetError, LIMITS, decodeXml } = require('./xlsx-reader');

const MAX_NODES = 2000000;
const MAX_DEPTH = 64;
const unsupported = () => new SpreadsheetError('That XML file has no readable list of records. Export it as CSV or Excel. No inventory changed.');

const local = (name) => name.split(':').at(-1);
// "unit_cost", "UnitCost" and "unit-cost" all read as "unit cost".
const label = (name) => name.replace(/[_.-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();

function tree(text) {
  const source = String(text)
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (match, value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  const root = { name: '', attributes: [], children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  for (const match of source.matchAll(tag)) {
    const top = stack.at(-1);
    if (match[6]) throw unsupported();
    if (match[5] !== undefined) { top.text += match[5]; continue; }
    if (match[1]) {
      if (stack.length < 2 || top.name !== local(match[2])) throw unsupported();
      stack.pop();
      continue;
    }
    if (++nodes > MAX_NODES || stack.length > MAX_DEPTH) {
      throw new SpreadsheetError('That XML file is too large or too deeply nested to read. Export it as CSV or Excel. No inventory changed.');
    }
    const attributes = [...match[3].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .filter((attribute) => !/^xmlns(:|$)/.test(attribute[1]))
      .map((attribute) => [label(local(attribute[1])), decodeXml(attribute[2] ?? attribute[3])]);
    const node = { name: local(match[2]), attributes, children: [], text: '' };
    top.children.push(node);
    if (!match[4]) stack.push(node);
  }
  if (stack.length !== 1) throw unsupported();
  return root;
}

const leaf = (node) => node.children.length === 0;

/** Every simple value under a record, named by its path inside the record. */
function values(node, prefix, out) {
  for (const [name, value] of node.attributes) out.push([prefix ? `${prefix} ${name}` : name, value]);
  for (const child of node.children) {
    const name = prefix ? `${prefix} ${label(child.name)}` : label(child.name);
    if (leaf(child)) {
      out.push([name, decodeXml(child.text).trim()]);
      for (const [attribute, value] of child.attributes) out.push([`${name} ${attribute}`, value]);
    } else values(child, name, out);
  }
  return out;
}

function records(text) {
  const root = tree(text);
  // The best record group: siblings sharing a name, each holding simple values.
  let best = null;
  const visit = (parent) => {
    const groups = new Map();
    for (const child of parent.children) {
      if (!groups.has(child.name)) groups.set(child.name, []);
      groups.get(child.name).push(child);
    }
    for (const group of groups.values()) {
      const simple = group.filter((node) => node.attributes.length || node.children.some(leaf));
      if (simple.length && (!best || simple.length > best.length)) best = simple;
    }
    for (const child of parent.children) if (!leaf(child)) visit(child);
  };
  visit(root);
  if (!best) throw unsupported();

  const rows = best.map((node) => {
    const row = new Map();
    for (const [name, value] of values(node, '', [])) {
      row.set(name, row.has(name) && value ? `${row.get(name)}, ${value}` : value || row.get(name) || '');
    }
    return row;
  });
  const columns = [...new Set(rows.flatMap((row) => [...row.keys()]))];
  if (columns.length > LIMITS.maxColumns) throw new SpreadsheetError('This file exceeds the import column capacity. No columns were silently dropped.');
  return { sheets: [{ name: `${label(best[0].name)} records`, grid: [columns, ...rows.map((row) => columns.map((column) => row.get(column) ?? ''))] }] };
}

module.exports = { records };
