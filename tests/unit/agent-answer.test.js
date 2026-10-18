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

test('observed local review links work in table cells, lists and paragraphs without allowing external or session authorization links',()=>{
 const html=render('| Decision | Review |\n|---|---|\n| Check terms | [Review decision](/autopilot/work/owned-record) |\n\n- [Open saved goal](/ask?goal=owned#focused-goal)\n\n[Read **invoice**](/accounting/payables/owned/review?from=inbox&sort=newest)');
 assert.match(html,/<a href="\/autopilot\/work\/owned-record">Review decision<\/a>/);
 assert.match(html,/<a href="\/ask\?goal=owned#focused-goal">Open saved goal<\/a>/);
 assert.match(html,/<a href="\/accounting\/payables\/owned\/review\?from=inbox&amp;sort=newest">Read <strong>invoice<\/strong><\/a>/);
 for(const href of ['javascript:alert(1)','https://elsewhere.example/','//elsewhere.example/','/%2felsewhere.example','/a\\b','/a%0ab','/%252felsewhere.example','/%252e%252e/secret','/../secret','/a?ticket=private','/a?access_token=private','/a?accessToken=private','/a?csrfToken=private','/a?state=private','/a?password=private','/verify-email?token[]=private','/invite?token[0]=private','/reset-password?token%5b%5d=private'])assert(!/<a\b/.test(render('[Open]('+href+')')),href);
 assert.equal(render('`[code](/inventory)`'),'<p><code>[code](/inventory)</code></p>');
 assert.equal(render('``code ` [example](/inventory)``'),'<p><code>code ` [example](/inventory)</code></p>');
 assert.equal(render('```$75.00```'),'<p><code>$75.00</code></p>');
 assert.equal(render('```INV-123``` is the invoice number.'),'<p><code>INV-123</code> is the invoice number.</p>');
 assert(!/<a\b/.test(render('```code `` [example](/inventory)```')));
 const escaped=render('[<img onerror=x>](/record/%22onmouseover=%22x)');assert(!/<img|onmouseover="/i.test(escaped));assert.match(escaped,/&lt;img/);
 for(const text of ['```\n[example](/inventory)\n```','~~~markdown\n[example](/inventory)\n~~~','~~~markdown~\n[example](/inventory)\n~~~','~~~markdown`\n[example](/inventory)\n~~~','    [example](/inventory)','\t[example](/inventory)']){const code=render(text);assert(!/<a\b/.test(code));assert.match(code,/<pre><code>\[example\]/);}
});
