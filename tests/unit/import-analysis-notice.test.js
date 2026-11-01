'use strict';const test=require('node:test'),assert=require('node:assert/strict'),notice=require('../../src/imports/analysis-notice');
test('known admission pauses allow manual mapping and uncertain paid attempts remain visible',()=>{
 assert(notice.admissionPause(Error('CERTIFICATION_WINDOW_CLOSED')));assert(notice.admissionPause({code:'rate_limited',modelStarted:false}));assert(!notice.admissionPause({code:'CERTIFICATION_WINDOW_CLOSED',modelStarted:true}));assert(!notice.admissionPause({code:'validation_error',message:'Invalid workbook relationship'}));assert(!notice.admissionPause({code:'provider_timeout',modelStarted:true}));assert.doesNotMatch(notice.fromError(Error('CERTIFICATION_WINDOW_CLOSED')).message,/CERTIFICATION/);
});
