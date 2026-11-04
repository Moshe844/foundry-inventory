'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{classify}=require('../../src/assistant/direct-business-reads');
test('a plain profit question is answered directly, for the period it names',()=>{
 for(const [question,period] of [['What is my profit this month?','this_month'],["What's my gross profit?",'this_month'],['how much profit did I make','this_month'],['Net profit last month','last_month'],['profit today','today'],['Show me profit year to date','year_to_date'],['What was my profit yesterday?','yesterday']])
  assert.deepEqual(classify(question),{kind:'sales',profit:true,period},question);
 assert.deepEqual(classify('profit from October 1, 2026 to November 1, 2026'),{kind:'sales',profit:true,range:{from:'October 1, 2026',to:'November 1, 2026'}});
});
test('a question that slices, explains or names an unknown period is left for the planner',()=>{
 for(const question of ['Why did my profit change?','Profit by product this month','Which customer brings the most profit?','Profit last week','Profit in October','Compare profit to last month'])assert.equal(classify(question),null,question);
});
