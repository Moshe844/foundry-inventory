'use strict';
// Describe implemented behavior in customer language. The PDF assignment stays
// in agent-plan-v3.json; a scope note never grants access or marks work complete.
const notes={
 11:{common:'Records scanned, physically confirmed moves between bins in the same warehouse.'},
 31:{common:'Handles exact delivery-date replies through the supplier’s original PO link. Quantity and price amendments remain planned.'},
 36:{common:'Prepares stock and 12-week forecast emails for approved suppliers. Growth approves each message; Pro and Custom can use an owner-authorized schedule.',
  growth:'Prepares a stock and 12-week forecast email. You approve the exact message before it is sent.',
  pro:'Can share stock and 12-week forecasts through a connected mailbox, within your approved supplier scope, schedule and limits.',
  enterprise:'Can share stock and 12-week forecasts through a connected mailbox, within your approved supplier scope, schedule and limits.'},
 38:{common:'Plans loads for selected existing POs from confirmed carton sizes, gross weights and stacking limits. Up to 20 POs, 500 lines and 2,000 cartons per planning group.'},
 96:{common:'Updates known suppliers’ lead times, minimum quantities, contact names and phone numbers from original supplier emails in the supported update format. Price and payment-term changes need separate review.'},
 97:{common:'Growth can estimate a benefit once. Pro and Custom track owner-checked rebate agreements, matched purchases, claim windows and recorded claim history.',
  growth:'Gives a one-time estimate from agreement terms you enter and matched supplier invoices. Ongoing tracking needs Pro.',
  pro:'Tracks checked rebate terms, matched invoices, claim windows and recorded external claim history. Contract extraction and sending claims remain planned.',
  enterprise:'Tracks checked rebate terms, matched invoices, claim windows and recorded external claim history. Contract extraction and sending claims remain planned.'},
 111:{common:'Prepares return authorizations from original customer emails in the supported order, item and quantity format. Physical receipt, refund and final disposition keep their separate approvals.'},
 178:{common:'Writes app procedures from completed receiving, ordinary dispatch and quantity-count workflows. Every staff publication requires the owner’s separate review.',
  growth:'Prepares app procedures from completed receiving, dispatch and count records. You approve each saved draft and every staff publication.',
  pro:'Maintains private app-procedure drafts from completed workflows without training. Staff see a version only after your separate approval.',
  enterprise:'Maintains private app-procedure drafts from completed workflows without training. Staff see a version only after your separate approval.'}
};
function current(id,tier){const note=notes[id];return note?(tier&&note[tier]||note.common):null;}
module.exports={current};
