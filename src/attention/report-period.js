'use strict';

const { ValidationError } = require('../domain/errors');
const { dateOnly } = require('../accounting/ledger');

function reportPeriod(question, windowDays, now = new Date()) {
  const text = String(question || '');
  const iso = (date) => date.toISOString().slice(0, 10);
  const explicit = text.match(/\b(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through|and)\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (explicit) {
    const from = dateOnly(explicit[1], 'Report start date');
    const to = dateOnly(explicit[2], 'Report end date');
    if (iso(new Date(`${from}T00:00:00.000Z`)) !== from || iso(new Date(`${to}T00:00:00.000Z`)) !== to) throw new ValidationError('Report dates must be real calendar dates.');
    if (from > to) throw new ValidationError('Report start date must be on or before its end date.');
    return { from, to, label: `${from} through ${to}` };
  }
  const calendar = text.match(/\b(last|previous|this|current)\s+(calendar\s+)?(quarter|month|year)\b/i);
  if (calendar) {
    const prior = /last|previous/i.test(calendar[1]);
    const unit = calendar[3].toLowerCase();
    const months = unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1;
    const startMonth = Math.floor(now.getUTCMonth() / months) * months;
    const from = iso(new Date(Date.UTC(now.getUTCFullYear(), startMonth - (prior ? months : 0), 1)));
    const to = prior ? iso(new Date(Date.UTC(now.getUTCFullYear(), startMonth, 0))) : iso(now);
    return { from, to, label: `${from} through ${to}` };
  }
  const rolling = text.match(/\b(?:last|past)\s+(\d+|three|six|twelve)\s+(days?|weeks?|months?)\b/i);
  if (rolling) {
    const count = Number(rolling[1]) || ({three:3,six:6,twelve:12})[rolling[1].toLowerCase()];
    if (count < 1 || count > 365) throw new ValidationError('Specify a report interval between 1 and 365 days, weeks or months.');
    let start;
    if (/month/i.test(rolling[2])) {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-count,1));
      const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(),monthStart.getUTCMonth()+1,0)).getUTCDate();
      start = new Date(Date.UTC(monthStart.getUTCFullYear(),monthStart.getUTCMonth(),Math.min(now.getUTCDate(),lastDay)));
    } else start = new Date(now.getTime()-((/week/i.test(rolling[2]) ? count*7 : count)-1)*86400000);
    return {from:iso(start),to:iso(now),label:`${iso(start)} through ${iso(now)}`};
  }
  if (/\b(?:quarter|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(text)) {
    throw new ValidationError('Specify the report period as last/this calendar quarter, month or year, or from YYYY-MM-DD to YYYY-MM-DD. I did not substitute a rolling period.');
  }
  const to = iso(now);
  const from = iso(new Date(now.getTime() - (windowDays - 1) * 86400000));
  return { from, to, label: `the last ${windowDays} days (${from} through ${to})` };
}

module.exports = { reportPeriod };
