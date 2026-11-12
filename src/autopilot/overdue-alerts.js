'use strict';

// Job 168: late purchase orders, late shipments and overdue invoices, alone on
// every plan.
//
// The routine check (operational-notices.refresh, run by the worker) raises a
// dated alert for each record from the review in exception-reviews.js:
//  - a placed purchase order past its expected date with goods not received;
//  - a customer order not shipped (or collected) by the date promised to the
//    customer, and a shipped parcel past the delivery date its carrier
//    tracking or the person shipping it recorded;
//  - a customer invoice or supplier bill unpaid past its due date.
// The alert's date follows the record if it changes, it is reminded once a
// business day, and it clears when goods arrive, the order ships or is
// delivered, or the invoice is paid. Alerts reach the app, Needs you and, when
// the owner chose a mailbox, email (agent-alerts.js), like job 166.

const JOB=168,key='overdue-work',path='/autopilot/reviews/'+key;
const review=()=>require('./exception-reviews').find(d=>d.id===JOB);

// One plain line per alert, for the alert email.
async function lines(db,workspaceId,keys){
  const today=await require('../lib/business-time').today(db,workspaceId);
  const rows=(await db.query(`SELECT * FROM (${review().sql}) x`,[workspaceId,'',today])).rows;
  const byKey=new Map(rows.map(r=>[r.Type+'\u0000'+r.Reference+'\u0000'+r.link,r]));
  return keys.map(k=>{const r=byKey.get(k.kind+'\u0000'+k.reference+'\u0000'+k.link);
    if(!r)return k.kind+' '+k.reference+'.';
    const late=Number(r['Days late']);
    return r.Type+' '+r.Reference+' ('+r.Contact+'). '+r.Problem+': due '+r.Due+', '+(late===1?'1 day':late+' days')+' late.';});
}

module.exports={JOB,key,path,lines};
