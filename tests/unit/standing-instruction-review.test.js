'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');
const render=(name,data)=>ejs.render(fs.readFileSync(path.join(__dirname,'../../src/web/views/settings',name),'utf8'),data);
test('approved instruction review offers an editable Ask handoff without claiming a review link edits settings',()=>{
 const statedAs='An unfamiliar instruction <script>alert(1)</script> & "quoted text"',proposal={id:'local-rule',status:'APPROVED',summary:'Approved instruction',statedAs,approvedAt:'2026-10-15T15:04:22.247Z',questions:[]};
 const data={proposal,nativeGoal:null,descriptions:['Previously approved effect'],helpers:{dateTime:x=>x},fromAsk:false,csrfToken:'TEST',usageKey:'TEST'},html=render('postgres-operating-instruction.ejs',data);
 assert.match(html,/Approved changes/);assert.doesNotMatch(html,/<h2>In force<\/h2>|<script>/);
 const href=/href="(\/ask\?about=[^"]+)">Request a change/.exec(html)?.[1];assert(href);assert.equal(new URL(href,'http://localhost').searchParams.get('about'),'Standing instruction: '+statedAs);
 assert.doesNotMatch(html,/<form/,'Review cannot silently submit a request, approve a change, or spend model funds');
 const pending=render('postgres-operating-instruction.ejs',{...data,proposal:{...proposal,status:'PENDING',integrityHash:'frozen'}});assert.match(pending,/Approve standing rule/);assert.doesNotMatch(pending,/Request a change/);
});
test('PostgreSQL approval history distinguishes approved, replaced and pending records from current enforced settings',()=>{
 const html=render('told.ejs',{rules:[{id:'a',summary:'Approved removal',status:'APPROVED',approvalHistory:true,linkLabel:'Review'},{id:'b',summary:'Earlier settings',status:'SUPERSEDED',approvalHistory:true,linkLabel:'Review'}],policies:[],connections:[],preferences:[],helpers:{shortDate:()=>''}});
 assert.match(html,/approved instruction/);assert.match(html,/>Review<\/a>/);assert.match(html,/replaced/);assert.doesNotMatch(html,/>Change<\/a>|· active|Each one can be changed, paused or taken away/);
 const legacy=render('told.ejs',{rules:[{id:'legacy',summary:'Legacy rule',status:'APPROVED'}],policies:[],connections:[],preferences:[],helpers:{shortDate:()=>''}});assert.match(legacy,/>Change<\/a>/,'The existing Ask settings contract stays available');
});
