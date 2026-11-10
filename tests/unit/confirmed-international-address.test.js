'use strict';const test=require('node:test'),assert=require('node:assert/strict'),address=require('../../src/shipping/address');
test('International addresses use exact saved fields and retain an explicit country without guessing missing facts',()=>{
 const fields={line1:'100 King Street West',line2:'Suite 200',city:'Toronto',state:'ON',postalCode:'M5X 1A9',country:'CA'},text=require('../../src/sales/customer-address').fromInput({addressLine1:fields.line1,addressLine2:fields.line2,...fields}).text;
 const parsed=address.parse(text,fields);assert.equal(parsed.complete,true);assert.equal(parsed.country,'CA');assert.equal(parsed.city,'Toronto');assert.equal(parsed.state,'ON');assert.match(address.oneLine(parsed),/CA$/);
 assert.equal(address.parse(text,{...fields,state:''}).complete,false);assert.equal(address.parse(text,{...fields,country:'US'}).complete,false);assert.equal(address.parse(text.replace('100 King','200 King'),fields).complete,false);
 assert.equal(address.parse('100 King Street West, Toronto, ON, Canada').complete,false);
});
test('The original US grammar and exact owner-entered US fields remain usable',()=>{
 assert.equal(address.parse('10 Jobsite Rd, Albany, NY 12207').complete,true);const f={line1:'10 Jobsite Rd',line2:'',city:'Albany',state:'NY',postalCode:'12207',country:'US'},text=require('../../src/sales/customer-address').fromInput({addressLine1:f.line1,...f}).text;assert.equal(address.parse(text,f).complete,true);assert.equal(address.parse(text,{...f,country:'ZZ'}).complete,false);
});
