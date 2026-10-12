'use strict';
// Free interactive architecture demonstration. Decisions arrive from the current
// Codex operator, never a navigation script or a paid embedded provider. This
// does not certify the pinned OpenAI SDK worker's reasoning or cost performance.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
async function run(){
 const directory=path.resolve(process.argv[2]||'data/environment-agent-demo/discovery-review');
 if(fs.existsSync(path.join(directory,'trace.jsonl')))throw new Error('ONE_SHOT_DEMO_DIRECTORY_REQUIRED');
 fs.mkdirSync(directory,{recursive:true});const cleanup=[];
 const audit=event=>fs.appendFileSync(path.join(directory,'trace.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
 try{
  const cluster=await require('../../tests/helpers/postgres-cluster').startCluster();cleanup.push(()=>cluster.stop());
  const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);cleanup.push(()=>db.close());
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const f=await require('../../tests/fixtures/environment-agent-unfamiliar-screen').createFixture(db);cleanup.push(()=>f.close());
  const inspection=await require('./inspection').createInspectionServer({cluster,database:db,ctx:f.ctx});cleanup.push(()=>inspection.close());
  const origin=await f.start(inspection),browser=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>browser.close());
  const ui=await require('./browser').createBrowserTools(browser,{origin,audit});cleanup.push(()=>ui.close());
  const cert=JSON.parse(fs.readFileSync(path.join(__dirname,'../../data/environment-agent-demo/sandbox-certificate.json'),'utf8'));
  const sandbox=await require('./sandbox').createSandbox({image:cert.image});cleanup.push(()=>sandbox.close());await sandbox.certify();
  let blockedProviderCalls=0;
  const provider={name:'offline-review',model:'none',async complete(){blockedProviderCalls++;throw new Error('Provider calls are prohibited in this architecture review.');}};
  const store=require('../../src/assistant/postgres-goal-store'),goal=await store.claim(db,f.ctx,(await store.create(db,f.ctx,f.goal,{budgetMinor:75})).id);
  const gateway=require('./gateway').createGateway({database:db,ctx:f.ctx,goal:f.goal,goalId:goal.id,runToken:goal.run_token,provider,audit});
  const session=require('./session').createSession({database:db,ctx:f.ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex-interactive-review',authorize:gateway.authorize});
  let count=0;
  const observed={...ui,act:async input=>{const result=await ui.act(input);audit({kind:'browser_observation',screen:result.screen||result});
   await ui.page.screenshot({path:path.join(directory,`screen-${count}.png`)});return result;}};
  const tools=require('./candidates').sharedTools({browser:observed,gateway,sandbox,session,audit});
  fs.writeFileSync(path.join(directory,'goal.json'),JSON.stringify({goal:f.goal,source:require('./certification').sourceHash(),operator:'Codex interactive; no native SDK model calls'},null,2));
  console.log(JSON.stringify({event:'ready',goal:f.goal,tools:tools.map(t=>({name:t.name,description:t.description})),startingPoint:'Browser is at StockChief Home. Inspect to discover controls.'}));
  const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  for await(const line of lines){if(!line.trim())continue;
   try{const request=JSON.parse(line);
    if(request.finish!==undefined){
     const verdict=await f.verify(request.finish);
     Object.assign(verdict,{toolCalls:count,blockedProviderCalls,paidCalls:0,liveBrowserDecisions:'Codex operator through sharedTools; no scripted navigation',
      sourceHash:require('./certification').sourceHash()});
     fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(verdict,null,2));
     console.log(JSON.stringify({event:'evaluation',...verdict,independentDatabaseEvidence:'Saved privately in result.json'}));
     lines.close();break;
    }
    const tool=tools.find(t=>t.name===request.name);if(!tool)throw new Error('Unknown shared tool.');
    const input=tool.schema.parse(request.input);count++;
    const result=await require('./network-guard').restricted({databaseUrl:cluster.connectionString},()=>tool.execute(input,{operatorCallId:`codex-${count}`,toolSource:'codex_interactive'}));
    console.log(JSON.stringify({event:'tool_result',call:count,result}));
   }catch(error){audit({kind:'operator_tool_error',message:error.message});console.log(JSON.stringify({event:'tool_error',message:error.message}));}
  }
 }finally{for(const close of cleanup.reverse())try{await close();}catch(error){console.error('Cleanup: '+error.message);}}
}
if(require.main===module)run().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={run};
