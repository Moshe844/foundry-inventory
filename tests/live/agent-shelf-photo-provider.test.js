'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

function shelfImage(){
  const canvas=require('@napi-rs/canvas').createCanvas(1320,680);
  const c=canvas.getContext('2d');
  const backdrop=c.createLinearGradient(0,0,0,680);
  backdrop.addColorStop(0,'#3c454a');
  backdrop.addColorStop(1,'#22292d');
  c.fillStyle=backdrop;
  c.fillRect(0,0,1320,680);
  for(const x of [145,520,895]){
    const x2=x+260;
    c.fillStyle='#b89b72';
    c.beginPath();c.moveTo(x,195);c.lineTo(x+65,145);c.lineTo(x2+65,145);c.lineTo(x2,195);c.closePath();c.fill();
    c.fillStyle='#9f794c';
    c.beginPath();c.moveTo(x2,195);c.lineTo(x2+65,145);c.lineTo(x2+65,400);c.lineTo(x2,455);c.closePath();c.fill();
    const cardboard=c.createLinearGradient(x,195,x2,455);
    cardboard.addColorStop(0,'#d7b685');cardboard.addColorStop(1,'#b79362');
    c.fillStyle=cardboard;c.fillRect(x,195,260,260);
    c.fillStyle='#ead7b0';c.fillRect(x+108,195,48,260);
    c.fillStyle='#fffef4';c.fillRect(x+22,280,216,74);
    c.fillStyle='#101010';c.font='bold 34px Arial';c.fillText('CASE-0001',x+33,330);
  }
  c.fillStyle='#52656c';c.fillRect(65,455,1190,75);
  c.fillStyle='#d6e0e0';c.fillRect(535,469,250,47);
  c.fillStyle='#172021';c.font='bold 29px Arial';c.fillText('BIN C-01',595,502);
  return canvas.toBuffer('image/png');
}

test('configured vision reads visible boxes and separates exact shelf labels from case labels',{skip:process.env.STOCKCHIEF_REAL_SHELF_TEST!=='1',timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  await f.subscribe('pro');
  const shelf=require('../../src/warehouse/agent-shelf-photos');
  const source=shelfImage();
  const queued=await shelf.enqueue(f.db,f.ctx,{filename:'synthetic-warehouse-shelf.png',buffer:source,locationId:f.location.id,requestKey:randomUUID()});
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const done=await require('../../src/operations/postgres-job-queue').processOne(f.db,{[shelf.kind]:handlers[shelf.kind]},{owner:'actual-shelf-provider'});
  assert.equal(done.status,'COMPLETED',JSON.stringify(done.lastError));
  const result=await shelf.load(f.db,f.ctx,queued.id);
  assert.equal(result.status,'REVIEW');
  assert.equal(result.reading.visibleBoxes,3);
  assert.equal(result.reading.uncertainBoxes,0);
  assert.deepEqual(result.reading.boxes.map(box=>box.label),['CASE-0001','CASE-0001','CASE-0001']);
  assert.deepEqual(result.reading.shelfLabels.map(label=>label.label),['BIN C-01']);
  assert.deepEqual(result.content,source);
  assert.equal(result.credits_used,100);
  assert.equal(await f.balance(),20);
  const expense=Number((await f.db.query("SELECT coalesce(sum(actual_minor),0)::text AS amount FROM commercial_model_cost_holds WHERE workspace_id=$1 AND status='SETTLED'",[f.ctx.workspaceId])).rows[0].amount);
  assert(expense>0);
  process.stdout.write(JSON.stringify({fixture:'synthetic warehouse shelf',boxes:3,boxLabel:'CASE-0001',shelfLabel:'BIN C-01',credits:100,expenseMinor:expense,stock:20})+'\n');
});
