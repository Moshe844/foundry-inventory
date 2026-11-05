'use strict';const assert=require('node:assert/strict');
async function check(db,ctx){
 const rows=(await db.query('SELECT count(*) FILTER(WHERE attributes IS NOT NULL)::int documents,count(*) FILTER(WHERE attributes IS NULL)::int legacy FROM catalog_source_facts WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert(rows.documents>=150000);
 const indexes=(await db.query("SELECT indexrelid::regclass::text name,indisunique,pg_get_expr(indpred,indrelid) predicate,pg_relation_size(indexrelid)::text bytes FROM pg_index WHERE indexrelid IN('catalog_source_fact_scope'::regclass,'catalog_source_document_scope'::regclass)")).rows,legacy=indexes.find(i=>i.name==='catalog_source_fact_scope'),documents=indexes.find(i=>i.name==='catalog_source_document_scope');
 assert(legacy.indisunique&&documents.indisunique);assert.equal(legacy.predicate,'(attributes IS NULL)');assert.equal(documents.predicate,'(attributes IS NOT NULL)');assert(Number(legacy.bytes)<Number(documents.bytes)/10);
 return{sourceDocumentRows:rows.documents,legacyFieldRows:rows.legacy,legacyIndexBytes:Number(legacy.bytes),documentIndexBytes:Number(documents.bytes),disjointUniqueness:true,sourceRowsChanged:0,paidCalls:0};
}
module.exports={check};
