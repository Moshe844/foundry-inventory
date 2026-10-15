'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const conversation=require('../../src/assistant/agent-conversation'),recorded=require('../fixtures/codex-provider-timeout.json');
test('real chat component explains a pending AI receipt, hides impossible resume and keeps expanded user messages readable at desktop and mobile widths',async t=>{
 const browser=await require('playwright').chromium.launch({headless:true});t.after(()=>browser.close());
 const goal={id:'offline-pending',status:'BLOCKED',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),answer:'The investigation stopped before final verification.',checkpoint:{runtime:'codex-staging',harness:{interruption:recorded.interruption,codexDelivery:recorded.codexDelivery},observations:[]}};goal.conversation=conversation.state(goal);
 const filename=path.resolve('src/web/views/partials/adaptive-goal.ejs'),panel=ejs.render(fs.readFileSync(filename,'utf8'),{goal,csrfToken:'OFFLINE',isLatest:true,codexApprovals:[],renderAgentAnswer:require('../../src/web/public/agent-answer').render},{filename});
 const styles=['app','product-clarity','foundry','room','design','owner-workspaces','ask'].map(name=>fs.readFileSync('src/web/public/'+name+'.css','utf8')).join('\n');
 const prompt='Please inspect the relevant records and prepare the complete proposed changes without executing them. '.repeat(6),html='<html><head><style>'+styles+'</style></head><body class="rm page-ask"><main class="rm-chat"><div class="rm-turn rm-turn--you"><details class="rm-turn__said"><summary>'+prompt.slice(0,160)+'…</summary><p>'+prompt+'</p></details></div>'+panel+'</main></body></html>';
 const context=await browser.newContext(),page=await context.newPage();await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:html}));await page.goto('https://offline.example.test/ask');
 for(const width of [1365,390]){await page.setViewportSize({width,height:900});const details=page.locator('.rm-turn__said'),summary=details.locator('summary');
  const before=await summary.evaluate(node=>({color:getComputedStyle(node).color,display:getComputedStyle(node).display,overflow:node.scrollWidth>node.clientWidth,pseudo:getComputedStyle(node,'::after').whiteSpace}));assert.equal(before.color,'rgb(255, 255, 255)');assert.equal(before.display,'block');assert.equal(before.overflow,false);assert.equal(before.pseudo,'nowrap');
  assert.equal(await page.locator('[data-goal-resume]').isVisible(),false);assert.match(await page.locator('[data-goal-answer]').innerText(),/usage is checked/);assert.match(await page.locator('[data-goal-answer]').innerText(),/no automatic retry/);assert(!await page.locator('[data-goal-answer]').innerText().then(s=>s.includes('23')));
  await summary.click();assert.equal(await details.getAttribute('open'),'');assert.equal(await details.locator('p').isVisible(),true);await summary.click();assert.equal(await details.getAttribute('open'),null);
 }
 await context.close();
});
