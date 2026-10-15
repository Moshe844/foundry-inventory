'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {render}=require('../../src/web/public/agent-answer');
test('recorded inventory answer structure renders a real table and separate conclusion',()=>{
 const html=render('Your current inventory:\n\n| Item | SKU | On hand |\n|---|---|---:|\n| Sample A | A | 20 |\n| Sample B | B | 8 |\n| Sample C | C | 0 |\n\nSample C is out of stock, with 2 units on order.');
 assert.equal((html.match(/<tr>/g)||[]).length,4);assert.equal((html.match(/<td /g)||[]).length,9);
 assert.match(html,/<th scope="col" style="text-align:right">On hand<\/th>/);
 assert.match(html,/<p>Sample C is out of stock, with 2 units on order\.<\/p>$/);
 assert(!html.includes('|---'));
});
test('model HTML, executable links and malicious table cells remain inert text',()=>{
 const html=render('| Item | Value |\n|---|---|\n| <img src=x onerror=alert(1)> | **<script>alert(1)</script>** |\n\n[click](javascript:alert(1))');
 assert(!/<(?:img|script|a)\b/i.test(html));assert.match(html,/&lt;img/);assert.match(html,/<strong>&lt;script&gt;/);
 assert.match(render('• First\n• Second\n\nA **clear** result.'),/<ul><li>First<\/li><li>Second<\/li><\/ul><p>A <strong>clear<\/strong> result\.<\/p>/);
});

test('ordinary Markdown section labels render cleanly without exposing heading markers or active HTML',()=>{
 const html=render('### Posted customer invoices\n\n| Invoice | Total |\n|---|---:|\n| INV-7 | $75.00 |\n\nA conclusion.\n## Next steps\n\nReview the record.');
 assert.match(html,/^<h3 class="rm-agent__heading">Posted customer invoices<\/h3><div/);
 assert.match(html,/<p>A conclusion\.<\/p><h3 class="rm-agent__heading">Next steps<\/h3>/);
 assert(!html.includes('###'));
 assert.equal(render('## <img src=x onerror=alert(1)>'),'<h3 class="rm-agent__heading">&lt;img src=x onerror=alert(1)&gt;</h3>');
});
