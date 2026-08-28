'use strict';

const pad = (value) => String(value).padStart(2, '0');

/** Calendar date in the server/business timezone, never the UTC date. */
function localDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Add whole calendar days without letting UTC or daylight-saving shifts rename the date. */
function addLocalDays(value = Date.now(), days = 0) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + Number(days || 0));
  return localDateKey(date);
}

function ordinal(dateKey) {
  const [year, month, day] = String(dateKey).slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole calendar days from `fromDate` to `toDate`. */
function daysBetween(fromDate, toDate) {
  return Math.round((ordinal(toDate) - ordinal(fromDate)) / (24 * 60 * 60 * 1000));
}

module.exports = { localDateKey, addLocalDays, daysBetween };

