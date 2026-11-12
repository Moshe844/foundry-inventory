'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const sentence=require('../../src/sales/repeat-order-sentence');

test('one-sentence repeat requests are read in each supported language and say which order they mean',()=>{
  for(const [text,period] of [
    ['Same as last month for Acme','previous-month'],['Acme wants the same as last month','previous-month'],
    ['Repeat Acme’s usual order','usual'],['The usual for Acme','usual'],['Repeat Acme’s last order','latest'],
    ['Lo mismo que el mes pasado para Acme','previous-month'],['El pedido habitual de Acme','usual'],
    ['La même chose que le mois dernier pour Acme','previous-month'],['Répète la commande habituelle de Acme','usual'],
    ['Dasselbe wie letzten Monat für Acme','previous-month'],['Die übliche Bestellung von Acme','usual'],
    ['Lo stesso del mese scorso per Acme','previous-month'],['Il solito per Acme','usual'],
    ['O mesmo do mês passado para Acme','previous-month'],['O pedido habitual de Acme','usual'],
    ['Hetzelfde als vorige maand voor Acme','previous-month'],['De gebruikelijke bestelling van Acme','usual']]){
    const found=sentence.read(text);
    assert.equal(found?.period,period,text);
    assert.deepEqual(sentence.leftover(text,found,['Acme']),[],text);
  }
});

test('a question or a second instruction is not a repeat request',()=>{
  assert.equal(sentence.read('How much did Acme buy same as last month?'),null);
  const text='Same as last month for Acme but add tape';
  assert.deepEqual(sentence.leftover(text,sentence.read(text),['Acme']),['but','add','tape']);
  assert.equal(sentence.read('Show sales for last month'),null);
});

test('a customer email may be only the request, with greeting, sign-off and quoted mail ignored',()=>{
  const ok=sentence.emailRequest('Order','Hi Sam,\n\nSame as last month please.\n\nThanks,\nRita\n\nOn Mon, Sam wrote:\n> your invoice');
  assert.equal(ok.period,'previous-month');assert.deepEqual(ok.extra,[]);
  assert.equal(sentence.emailRequest('Re: Same as last month','').period,'previous-month');
  assert.deepEqual(sentence.emailRequest('Order','Please send our usual order, and extra tape.').extra,['and','extra','tape']);
  assert.equal(sentence.emailRequest('Order','PO 7\nABC-1 qty 3'),null);
});
