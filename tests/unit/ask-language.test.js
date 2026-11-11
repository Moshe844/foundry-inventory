'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),language=require('../../src/assistant/ask-language');

test('a question mostly in another script is read in English first; Latin-script questions and codes are not',()=>{
 for(const question of ['וואס זענען מיינע בעסטע סעלערס דעם חודש?','וויפיל AM90-BLACK-10 האב איך?','מה המכירות החודש?','Сколько у меня товаров?','Πόσα προϊόντα έχω;'])
  assert.equal(language.needsReading(question),true,question);
 for(const question of ['What are my best sellers?','¿Cuántos productos tengo?','Wie viele Schuhe habe ich?','SKU 12345','?'])
  assert.equal(language.needsReading(question),false,question);
});

test('the English reading keeps every number of the question, or it is not used',async()=>{
 const provider=english=>({async complete(request){const data={english};request.onValidated?.(data);return {data};}});
 assert.equal(await language.toEnglish(provider('Show 25 best sellers for 2026'),'ווייז 25 בעסטע סעלערס פאר 2026'),'Show 25 best sellers for 2026');
 await assert.rejects(language.toEnglish(provider('Show 52 best sellers'),'ווייז 25 בעסטע סעלערס'),/changed a number/);
 assert.equal(await language.toEnglish(provider('x'),''),null);
});
