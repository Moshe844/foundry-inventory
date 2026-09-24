'use strict';

if (process.env.NODE_ENV !== 'test') throw new Error('The business clock is test-only.');

const RealDate = Date;
let current = RealDate.parse(process.env.STOCKCHIEF_TEST_DATE || '2026-09-11T12:00:00.000Z');

function advance(at) {
  const next = RealDate.parse(at);
  if (!Number.isFinite(next)) throw new Error('Invalid business test date.');
  current = next;
}

class BusinessDate extends RealDate {
  constructor(...values) {
    super(...(values.length ? values : [current]));
  }

  static now() { return current; }
}

global.Date = BusinessDate;

process.on('message', (message) => {
  if (message.type !== 'stockchief.test.advance') return;
  advance(message.at);
  if (process.send) process.send({ type: 'stockchief.test.advanced', at: new Date().toISOString() });
});

module.exports = { advance };
