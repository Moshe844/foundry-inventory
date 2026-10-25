'use strict';
const {ValidationError}=require('../domain/errors'),{newId}=require('../lib/util'),clock=require('../lib/business-time');
function window(input){
 const instant=(value,label)=>{if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new ValidationError(label+' must include its time zone.');return new Date(value).toISOString();};
 const startsAt=instant(input.startsAt,'Booking start'),endsAt=instant(input.endsAt,'Booking end'),timeZone=clock.zone(input.timeZone),bufferMinutes=Number(input.bufferMinutes||0);
 if(!timeZone||endsAt<=startsAt)throw new ValidationError('Choose a time zone and an end after the booking start.');
 if(!Number.isSafeInteger(bufferMinutes)||bufferMinutes<0||bufferMinutes>43200)throw new ValidationError('Turnaround time must be 0 to 43,200 minutes.');
 return {startsAt,endsAt,timeZone,bufferMinutes,occupiedUntil:new Date(Date.parse(endsAt)+bufferMinutes*60000).toISOString()};
}
async function held(c,workspaceId,skuId,locationId,{excludeAgreementId=null,rentalWindow=null,at=new Date().toISOString()}={}){
 return (await heldMany(c,workspaceId,[{skuId,locationId}],{excludeAgreementId,rentalWindow,at})).get(JSON.stringify([skuId,locationId]))||0;
}
async function heldMany(c,workspaceId,positions,{excludeAgreementId=null,rentalWindow=null,at=new Date().toISOString()}={}){
 if(positions&&!positions.length)return new Map();const result=await c.query(`WITH requested AS (SELECT DISTINCT sku_id,location_id FROM jsonb_to_recordset($2::jsonb) AS p(sku_id text,location_id text) UNION SELECT DISTINCT sku_id,location_id FROM custody_booking_lines WHERE workspace_id=$1 AND $2::jsonb IS NULL), slots AS (
  SELECT bl.sku_id,bl.location_id,
   greatest(b.starts_at,$4::timestamptz,coalesce($5::timestamptz,b.starts_at)) starts,
   least(b.ends_at+make_interval(mins=>b.buffer_minutes),coalesce($6::timestamptz,b.ends_at+make_interval(mins=>b.buffer_minutes))) ends,
   greatest(bl.quantity-l.dispatched_quantity,0)::bigint quantity
  FROM custody_booking_lines bl JOIN custody_bookings b ON b.workspace_id=bl.workspace_id AND b.id=bl.booking_id
  JOIN custody_lines l ON l.workspace_id=bl.workspace_id AND l.id=bl.custody_line_id
  JOIN custody_agreements a ON a.workspace_id=b.workspace_id AND a.id=b.agreement_id
  JOIN requested p ON p.sku_id=bl.sku_id AND p.location_id=bl.location_id
  WHERE bl.workspace_id=$1 AND b.status='CONFIRMED' AND a.status='OPEN'
   AND ($3::text IS NULL OR b.agreement_id<>$3) AND b.ends_at+make_interval(mins=>b.buffer_minutes)>$4::timestamptz
 ), events AS (SELECT sku_id,location_id,starts at,sum(quantity) delta FROM slots WHERE ends>starts GROUP BY sku_id,location_id,starts
 UNION ALL SELECT sku_id,location_id,ends at,-sum(quantity) delta FROM slots WHERE ends>starts GROUP BY sku_id,location_id,ends), grouped AS (
 SELECT sku_id,location_id,at,sum(delta) delta FROM events GROUP BY sku_id,location_id,at), running AS (SELECT sku_id,location_id,sum(delta) OVER(PARTITION BY sku_id,location_id ORDER BY at) n FROM grouped)
 SELECT sku_id,location_id,coalesce(max(n),0)::text quantity FROM running GROUP BY sku_id,location_id`,[workspaceId,positions?JSON.stringify(positions.map(p=>({sku_id:p.skuId,location_id:p.locationId}))):null,excludeAgreementId,at,rentalWindow?.startsAt||null,rentalWindow?.occupiedUntil||rentalWindow?.endsAt||null]);
 const map=new Map();for(const row of result.rows){const value=Number(row.quantity);if(!Number.isSafeInteger(value)||value<0)throw new ValidationError('Rental reservations need an exact quantity review.');map.set(JSON.stringify([row.sku_id,row.location_id]),value);}return map;
}
async function current(c,workspaceId,agreementId){
 const b=(await c.query('SELECT * FROM custody_bookings WHERE workspace_id=$1 AND agreement_id=$2',[workspaceId,agreementId])).rows[0];if(!b)return null;
 for(const key of ['starts_at','ends_at','created_at','updated_at'])b[key]=new Date(b[key]).toISOString();
 b.lines=(await c.query('SELECT bl.*,l.name location_name,s.code FROM custody_booking_lines bl JOIN locations l ON l.workspace_id=bl.workspace_id AND l.id=bl.location_id JOIN skus s ON s.workspace_id=bl.workspace_id AND s.id=bl.sku_id WHERE bl.workspace_id=$1 AND bl.booking_id=$2 ORDER BY bl.custody_line_id',[workspaceId,b.id])).rows;return b;
}
async function availability(c,workspaceId,skuId,locationId,input){
 const w=window({...input,timeZone:input.timeZone||'UTC'}),ordinary=(await c.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[workspaceId,locationId])).rows[0];if(!ordinary)throw new ValidationError('Choose an active ordinary location in this inventory.');
 const physical=await require('../transfers/postgres-transfer-service').sourceAvailable(c,workspaceId,skuId,locationId,{excludeRentalAgreementId:input.excludeAgreementId||null,rentalWindow:w});
 const returns=(await c.query(`SELECT coalesce(sum(CASE WHEN a.id=$5 THEN least(l.external_quantity,bl.quantity) ELSE 0 END),0)::text own_external,
  coalesce(sum(CASE WHEN a.id<>coalesce($5,'') AND b.ends_at+make_interval(mins=>b.buffer_minutes)<=$4::timestamptz THEN least(l.external_quantity,bl.quantity) ELSE 0 END),0)::text expected
  FROM custody_agreements a JOIN custody_lines l ON l.workspace_id=a.workspace_id AND l.agreement_id=a.id
  JOIN custody_bookings b ON b.workspace_id=a.workspace_id AND b.agreement_id=a.id AND b.status='CONFIRMED'
  JOIN custody_booking_lines bl ON bl.workspace_id=b.workspace_id AND bl.booking_id=b.id AND bl.custody_line_id=l.id
  WHERE a.workspace_id=$1 AND l.sku_id=$2 AND bl.location_id=$3 AND a.kind='RENTAL' AND a.status='OPEN'
   AND (a.id=$5 OR b.ends_at>=$6::timestamptz)`,[workspaceId,skuId,locationId,w.startsAt,input.excludeAgreementId||null,new Date().toISOString()])).rows[0];
 const expectedReturnUnits=Number(returns.expected),ownExternalUnits=Number(returns.own_external),calendarAvailable=Math.max(0,physical.onHand-physical.committed-physical.reserved+expectedReturnUnits+ownExternalUnits);return {physicalReady:physical.available,expectedReturnUnits,ownExternalUnits,calendarAvailable,notice:'Calendar capacity may depend on the stated return of another rental. Dispatch always requires actual uncommitted goods, and returns stay unavailable until inspected.'};
}
async function save(c,ctx,agreement,input){
 if(agreement.kind!=='RENTAL'||agreement.status!=='OPEN')throw new ValidationError('Scheduling requires an open rental agreement.');const w=window(input);if(Date.parse(w.endsAt)<=Date.now())throw new ValidationError('A new or revised reservation must have a return time in the future.');const old=await current(c,ctx.workspaceId,agreement.id),expected=Number(input.expectedRevision);
 if(!Number.isSafeInteger(expected)||expected!==(Number(old?.revision)||0))throw new ValidationError('This booking changed. Reload its current revision before editing.');
 if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>500||new Set(input.lines.map(l=>l.lineId)).size!==input.lines.length)throw new ValidationError('Choose one to 500 distinct agreement lines for this booking.');
 const lines=input.lines.map(value=>{const source=agreement.lines.find(l=>l.id===value.lineId),q=Number(value.quantity);if(!source||!Number.isSafeInteger(q)||q<1||q>Number(source.quantity)||q<Number(source.dispatched_quantity))throw new ValidationError('Booking quantity must cover the agreement line and any units already dispatched.');return {lineId:source.id,skuId:source.sku_id,locationId:value.locationId,quantity:q};});
 await c.query('SELECT b.sku_id,b.location_id FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=ANY($2::text[]) ORDER BY b.sku_id,b.location_id FOR UPDATE',[ctx.workspaceId,lines.map(l=>l.skuId)]);
 for(const line of lines){const physical=agreement.lines.find(l=>l.id===line.lineId);if(Number(physical.dispatched_quantity)>0){const before=old?.lines.find(l=>l.custody_line_id===line.lineId);if(!before||Number(before.quantity)!==line.quantity||before.location_id!==line.locationId||new Date(old.starts_at).toISOString()!==w.startsAt)throw new ValidationError('After dispatch, keep the original start, products and quantities; only revise the return window.');}
  const a=await availability(c,ctx.workspaceId,line.skuId,line.locationId,{...w,excludeAgreementId:agreement.id});if(line.quantity>a.calendarAvailable)throw new ValidationError('Only '+a.calendarAvailable+' units have calendar capacity at the chosen location after overlapping bookings and commitments.');line.returnDependent=line.quantity>a.physicalReady+a.ownExternalUnits;if(line.returnDependent&&input.acknowledgeExpectedReturns!=='yes')throw new ValidationError('This booking relies on a planned return. Confirm that dependency; it does not guarantee physical readiness.');
 }
 const id=old?.id||newId('rentalbooking');if(old){await c.query('DELETE FROM custody_booking_lines WHERE workspace_id=$1 AND booking_id=$2',[ctx.workspaceId,id]);await c.query("UPDATE custody_bookings SET starts_at=$3,ends_at=$4,time_zone=$5,buffer_minutes=$6,status='CONFIRMED',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,w.startsAt,w.endsAt,w.timeZone,w.bufferMinutes]);}else await c.query('INSERT INTO custody_bookings(id,workspace_id,agreement_id,starts_at,ends_at,time_zone,buffer_minutes,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,ctx.workspaceId,agreement.id,w.startsAt,w.endsAt,w.timeZone,w.bufferMinutes,ctx.actorId]);
 for(const l of lines)await c.query('INSERT INTO custody_booking_lines(id,workspace_id,booking_id,custody_line_id,sku_id,location_id,quantity,return_dependent) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId('rentalbookingline'),ctx.workspaceId,id,l.lineId,l.skuId,l.locationId,l.quantity,l.returnDependent]);
 await c.query('UPDATE custody_agreements SET start_date=$3,due_date=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,agreement.id,clock.context(w.timeZone,new Date(w.startsAt)).calendarDate,clock.context(w.timeZone,new Date(w.endsAt)).calendarDate]);return {bookingId:id,revision:Number(old?.revision||0)+1,returnDependent:lines.some(l=>l.returnDependent)};
}
async function cancel(c,ctx,agreement,input){const b=await current(c,ctx.workspaceId,agreement.id);if(!b||b.status!=='CONFIRMED'||Number(input.expectedRevision)!==Number(b.revision))throw new ValidationError('This booking changed. Reload its current revision.');if(agreement.lines.some(l=>Number(l.external_quantity)||Number(l.inspection_quantity)))throw new ValidationError('Record and inspect outstanding physical returns before cancelling this booking.');require('../lib/util').requireText(input.reason,'Booking cancellation reason',{max:500});await c.query("UPDATE custody_bookings SET status='CANCELLED',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,b.id]);return {bookingId:b.id,revision:Number(b.revision)+1};}
async function dispatchWindow(c,ctx,agreement,line,locationId,q){const b=await current(c,ctx.workspaceId,agreement.id);if(!b)return {};const now=Date.now(),slot=b.lines.find(l=>l.custody_line_id===line.id);if(b.status!=='CONFIRMED'||now<new Date(b.starts_at).getTime()||now>=new Date(b.ends_at).getTime())throw new ValidationError('Dispatch must be within the confirmed booking window. Review its scheduled dates.');if(!slot||slot.location_id!==locationId||q>Number(slot.quantity)-Number(line.dispatched_quantity))throw new ValidationError('Use the product, location and remaining quantity on the confirmed booking.');return {excludeRentalAgreementId:agreement.id,rentalWindow:window({startsAt:new Date(b.starts_at).toISOString(),endsAt:new Date(b.ends_at).toISOString(),timeZone:b.time_zone,bufferMinutes:b.buffer_minutes})};}
module.exports={window,held,heldMany,current,availability,save,cancel,dispatchWindow};
