'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('current and selected plan buttons stay gray under every plan theme, including hover',async t=>{
 const browser=await require('playwright').chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
 await page.setContent('<html><body class="public-page" data-public-page="pricing"><main>'+['starter','growth','pro','enterprise'].map(plan=>'<article class="plan-card" data-plan="'+plan+'"><div class="plan-card__action">'+['current','selected'].map(state=>'<button class="pub-btn" disabled data-plan-state="'+state+'">'+state+'</button>').join('')+'<a class="pub-btn" href="#review">Review plan</a></div></article>').join('')+'</main></body></html>');
 for(const file of ['commercial.css','professional-system.css','public-experience.css'])await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../../src/web/public',file),'utf8')});
 for(const plan of ['starter','growth','pro','enterprise']){
  for(const state of ['current','selected']){const button=page.locator('[data-plan="'+plan+'"] [data-plan-state="'+state+'"]');await button.hover();assert.equal(await button.isDisabled(),true);const style=await button.evaluate(el=>{const s=getComputedStyle(el);return {image:s.backgroundImage,background:s.backgroundColor,color:s.color,shadow:s.boxShadow};});assert.deepEqual(style,{image:'none',background:'rgb(232, 235, 238)',color:'rgb(89, 99, 109)',shadow:'none'},plan+' '+state);}
  assert.equal(await page.locator('[data-plan="'+plan+'"] a').isEnabled(),true);assert.notEqual(await page.locator('[data-plan="'+plan+'"] a').evaluate(el=>getComputedStyle(el).backgroundImage),'none',plan+' review links keep their theme');
 }
});
