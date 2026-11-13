'use strict';
// The connected mailbox a scheduled report goes out from (jobs 164 and 165):
// the owner's saved choice, else the only mailbox connected. No mailbox, a
// saved one that is no longer connected, or several with no choice made are
// facts StockChief asks about; it never picks one.
async function resolve(db,workspaceId,savedConnectorId,what){
  const boxes=await require('./postgres-outbound-mail').mailboxes(db,workspaceId);
  if(savedConnectorId){
    const box=boxes.find(b=>b.id===savedConnectorId);
    return box?{box,boxes}:{boxes,problem:'mailbox',reason:'The mailbox you chose for '+what+' is not connected now. Reconnect it or choose another.'};
  }
  if(boxes.length===1)return {box:boxes[0],boxes};
  if(!boxes.length)return {boxes,problem:'mailbox',reason:'Connect a mailbox so StockChief can send '+what+' from it.'};
  return {boxes,problem:'mailbox_choice',reason:'You have '+boxes.length+' mailboxes connected. Choose the one '+what+' '+(/s$/.test(what)?'are':'is')+' sent from.'};
}
module.exports={resolve};
