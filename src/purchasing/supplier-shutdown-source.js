'use strict';
const calc=require('./supplier-shutdown-calculation'),{hash}=require('../pricing/postgres-promotions'),{ValidationError}=require('../domain/errors'),{owner,inventoryFacts}=require('./planning-stock-source');
async function readFacts(db,ctx,raw){
 const scope=calc.input(raw),base=await inventoryFacts(db,ctx,scope,{jobId:147,incomingBy:scope.nextArrivalDate});
 const {supplier,location,locationIds,today,historyFrom,products,rows,incoming,transfer,warnings}=base,clock={calendarDate:today},from=historyFrom;
 if(scope.nextArrivalDate<=today)throw new ValidationError('This shutdown planning window has ended. Record the next actual supplier dates.');
 const money=require('../domain/currency');
 const calculated=calc.calculate(scope,clock.calendarDate,rows);
 if(calculated.deadlinePassed)warnings.push({reason:'The supplier’s last order date has passed. Confirm a new delivery arrangement before preparing a purchase order.'});
 if(supplier.minimum_order_amount!=null&&calculated.rows.some(r=>r.quantityUnits>0)&&calculated.totalMinor<money.toMinor(String(supplier.minimum_order_amount),supplier.currency))warnings.push({reason:'The planned order is below the recorded supplier minimum value. Review the quantity or arrangement separately.'});
 const core={scope,supplier,location,locationIds,today:clock.calendarDate,historyFrom:from,products,rows,incoming,transfer,calculated,warnings};
 return {...core,sourceFingerprint:hash(core)};
}
async function facts(db,ctx,raw){return typeof db.transaction==='function'?db.transaction(c=>readFacts(c,ctx,raw),{isolation:'REPEATABLE READ',retrySafe:true}):readFacts(db,ctx,raw);}
module.exports={facts,owner};
