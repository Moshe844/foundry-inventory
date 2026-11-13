'use strict';
// Which mailbox StockChief uses when it writes to a customer on its own
// (jobs 72 and 73). The owner's choice for customer messages on the Fulfilment
// page wins. With no choice, a business with exactly one mailbox that can send
// uses it. With two or more and no choice, sending is ambiguous: StockChief
// never picks one, and says so.
async function resolve(db,workspaceId){
  const notices=require('../shipping/agent-shipping-notices');
  const chosen=(await db.query('SELECT connector_id FROM customer_communication_policy WHERE workspace_id=$1',[workspaceId])).rows[0]?.connector_id||null;
  if(chosen){
    const box=await notices.mailbox(db,workspaceId,chosen);
    return box?{box}:{reason:'The mailbox chosen for customer messages on the Fulfilment page cannot send right now. Reconnect it or choose another, then StockChief can write to customers.'};
  }
  const usable=[];
  for(const row of await require('../connections/postgres-outbound-mail').mailboxes(db,workspaceId)){
    const box=await notices.mailbox(db,workspaceId,row.id);
    if(box)usable.push(box);
  }
  if(usable.length===1)return {box:usable[0]};
  if(!usable.length)return {reason:'No connected mailbox can send email. Connect one so StockChief can write to customers.'};
  return {reason:'You have more than one mailbox. Choose the one for customer messages on the Fulfilment page so StockChief does not pick one for you.'};
}
module.exports={resolve};
