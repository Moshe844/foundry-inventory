'use strict';
const assert=require('node:assert/strict');
// Shared phone and desktop check for a signed-in page: no sideways scroll.
async function widths(f,pages,check){
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:require('node:crypto').randomUUID()}),server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;require('node:fs').mkdirSync('output',{recursive:true});
 for(const [width,height,mobile] of [[390,844,true],[1440,900,false]]){
  const page=await browser.newPage({viewport:{width,height},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const [path,name] of pages){await page.goto(origin+path);await check(page,path);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' scrolls sideways at '+width);await page.screenshot({path:'output/'+name+'-'+width+'.png',fullPage:true});}
  await page.close();
 }
}
module.exports={widths};
