'use strict';const test=require('node:test'),assert=require('node:assert/strict'),input=require('../../src/domain/physical-stock-input');
test('stock dates accept real offset timestamps that cross a UTC date boundary',()=>{
 for(const at of ['2026-11-01T00:01:00+05:45','2026-10-31T23:59:00-04:00','2026-11-01T05:59:00Z','2026-10-31'])assert.equal(input.date(at,'Stock date'),at);
});
test('offset dates retain invalid-calendar and future-movement guards',()=>{
 for(const at of ['2026-02-30T00:01:00+05:45','2026-13-01T00:00:00Z','2026-11-01T25:00:00Z','abc'])assert.throws(()=>input.date(at,'Stock date'),/real calendar date/);
 assert.throws(()=>input.validate({occurredAt:'2026-11-01T00:01:00+05:45'},{now:Date.parse('2026-10-31T17:00:00Z')}),/cannot be in the future/);
});
