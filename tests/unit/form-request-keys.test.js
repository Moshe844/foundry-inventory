'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withKeys}=require('../../src/web/form-request-keys');
const keys=(html)=>[...html.matchAll(/name="idempotencyKey" value="([^"]+)"/g)].map((m)=>m[1]);

test('every same-site form that changes something gets its own one-time key',()=>{
  const html=withKeys('<form method="post" action="/a"><input name="x"></form><form action="/b" method=POST data-busy><button>Go</button></form>'
    +'<form method="post"><button>Here</button></form>');
  const given=keys(html);
  assert.equal(given.length,3);
  for(const key of given)assert.match(key,/^form-[0-9a-f-]{36}$/);
  assert.equal(new Set(given).size,3,'each form has its own key');
  assert.notDeepEqual(keys(withKeys('<form method="post" action="/a"></form>')),keys(withKeys('<form method="post" action="/a"></form>')),'each page sent gets fresh keys');
});

test('searches, own keys, other sites and scripts are left alone',()=>{
  const untouched='<form method="get" action="/search"><input name="q"></form>'
    +'<form method="post" action="/pay"><input type="hidden" name="idempotencyKey" value="mine"></form>'
    +'<form method="post" action="https://provider.example/checkout"></form><form method="post" action="//elsewhere.example/x"></form>'
    +'<script>const t=\'<form method="post" action="/later"></form>\';</script>';
  assert.equal(withKeys(untouched),untouched);
  assert.equal(withKeys('<p>No forms here</p>'),'<p>No forms here</p>');
  assert.equal(withKeys(null),null);
});
