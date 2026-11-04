'use strict';
// Deployment tooling calls this only after web and worker have rolled forward.
// Never drop a table, cascade to other objects, or change source records here.
async function retire(database){return database.transaction(async client=>{
 const row=(await client.query("SELECT c.relkind,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c WHERE c.oid=to_regclass('stockchief_runtime.read_model_changes')")).rows[0];
 if(!row)return {retired:false,alreadyRemoved:true};
 if(row.relkind!=='v'||!/read_model_versions/.test(row.definition)||!/WHERE\s+false/i.test(row.definition))throw Error('Only the empty read-model compatibility view can be retired.');
 await client.query('DROP VIEW stockchief_runtime.read_model_changes');return {retired:true};
},{isolation:'READ COMMITTED',lockTimeoutMs:1000});}
module.exports={retire};
