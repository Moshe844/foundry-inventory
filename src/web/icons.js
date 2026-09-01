'use strict';

/** Small stroke icon set. Inline so the UI never waits on an icon font. */
const PATHS = {
  overview: '<path d="M3.5 10.5 12 4l8.5 6.5M6 9.5V19a1 1 0 0 0 1 1h3.5v-4.5h3V20H17a1 1 0 0 0 1-1V9.5"/>',
  inventory:
    '<path d="M3.5 7.8 12 3.5l8.5 4.3v8.4L12 20.5 3.5 16.2z"/><path d="M3.5 7.8 12 12m0 0 8.5-4.2M12 12v8.5"/>',
  locations:
    '<path d="M12 21s6.5-5.6 6.5-10.4A6.5 6.5 0 0 0 5.5 10.6C5.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.4" r="2.4"/>',
  activity: '<path d="M3.5 12h4l2.5 6 4-13 2.5 7h4"/>',
  // Sales shared Activity's icon, so two different destinations in the sidebar
  // were the same picture. A receipt reads as customer demand; a chain link
  // reads as a connection to somewhere outside Foundry.
  sales:
    '<path d="M6 3.5h12v17l-2.5-1.6-2.5 1.6-2.5-1.6L8 20.5 6 19z"/><path d="M9.5 8.5h5M9.5 12h5"/>',
  link:
    '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.54 3.54 0 0 0-5-5l-1.4 1.4"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.54 3.54 0 0 0 5 5l1.4-1.4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  receive: '<path d="M12 3.5v11m0 0 4-4m-4 4-4-4"/><path d="M4 16v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3"/>',
  issue: '<path d="M12 20.5v-11m0 0 4 4m-4-4-4 4"/><path d="M4 8V5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 5v3"/>',
  transfer: '<path d="M4 9h13m0 0-3.5-3.5M17 9l-3.5 3.5"/><path d="M20 15H7m0 0 3.5-3.5M7 15l3.5 3.5"/>',
  adjust: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  alert: '<path d="M12 8.5v5m0 3.5h.01"/><circle cx="12" cy="12" r="9"/>',
  box: '<path d="M4 8.5 12 4.5l8 4v7l-8 4-8-4z"/><path d="m4 8.5 8 4 8-4"/><path d="M12 12.5v7"/>',
  tag: '<path d="M3.5 11.2V4.5a1 1 0 0 1 1-1h6.7a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-6.7 6.7a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7z"/><circle cx="8" cy="8" r="1.4"/>',
  serial: '<rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M7 9.5v5M10 9.5v5M13 9.5v5M17 9.5v5"/>',
  lot: '<path d="M5 7.5h14M6.5 7.5 7.5 19a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-11.5"/><path d="M9.5 7.5V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  logout: '<path d="M15 8.5V6a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 6v12a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 15 18v-2.5"/><path d="M9.5 12H20m0 0-3-3m3 3-3 3"/>',
  calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3.5v4M16 3.5v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  empty: '<path d="M4 8.5 12 4.5l8 4v7l-8 4-8-4z"/><path d="M9 11.5h6"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  foundry: '<path d="M12 3.2 13.9 8l4.8 1.9-4.8 1.9L12 16.6l-1.9-4.8L5.3 9.9 10.1 8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  purchasing: '<path d="M4 5h2l2.2 9.2a1.5 1.5 0 0 0 1.5 1.2h7a1.5 1.5 0 0 0 1.45-1.1L20 8H7"/><circle cx="10" cy="19" r="1.3"/><circle cx="17" cy="19" r="1.3"/>',
  accounting: '<path d="M4 20h16M6 20v-8m4 8V8m4 12V4m4 16v-5"/><path d="m5 8 4-3 4 1 5-4"/>',
  import: '<path d="M12 15.5v-11m0 11 4-4m-4 4-4-4"/><path d="M4 16v3a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-3"/>',
  send: '<path d="M4.5 12 20 4.5l-3 7.5 3 7.5z"/><path d="M20 12H7"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.3"/><path d="M12 16.8h.01"/>',
  attention: '<path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5"/><path d="M13.7 19a2 2 0 0 1-3.4 0"/>',
};

function icon(name, { size = 20, className = '' } = {}) {
  const body = PATHS[name] || PATHS.box;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

module.exports = { icon, PATHS };
