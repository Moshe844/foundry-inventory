'use strict';

const { ValidationError,InvariantError,NotFoundError }=require('./errors');
const { LOCATION_KIND_IDS }=require('./constants');
const { newId,nowIso,requireText,requireOneOf,trimOrNull }=require('../lib/util');

function pickSequence(value){
  if(value===undefined || value===null || value==='')return 0;
  const number=Number(value);
  if(!Number.isInteger(number)||number<0||number>999999)throw new ValidationError('Pick sequence must be a whole number from 0 to 999999.');
  return number;
}

async function requireLocation(client,workspaceId,id,label='location'){
  const result=await client.query('SELECT * FROM locations WHERE workspace_id=$1 AND id=$2',[workspaceId,id]);
  if(!result.rows.length)throw new NotFoundError(`That ${label} could not be found.`);
  return result.rows[0];
}

async function listHierarchy(database,workspaceId,{includeInactive=false}={}){
  const result=await database.query(`WITH RECURSIVE tree AS (
    SELECT l.*,0 AS depth,LPAD(l.pick_sequence::text,8,'0') || ':' || l.name AS sort_path,l.name AS display_path
      FROM locations l WHERE l.workspace_id=$1 AND l.parent_location_id IS NULL
    UNION ALL
    SELECT child.*,tree.depth+1,tree.sort_path || '/' || LPAD(child.pick_sequence::text,8,'0') || ':' || child.name,
      tree.display_path || ' / ' || child.name
      FROM locations child JOIN tree ON child.parent_location_id=tree.id WHERE child.workspace_id=$1)
    SELECT tree.*,COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.workspace_id=tree.workspace_id
      AND b.location_id=tree.id),0) AS on_hand,COALESCE((SELECT COUNT(DISTINCT b.sku_id) FROM balances b
      WHERE b.workspace_id=tree.workspace_id AND b.location_id=tree.id AND b.on_hand<>0),0) AS sku_count
    FROM tree WHERE ($2::boolean OR is_active=1) ORDER BY sort_path`,[workspaceId,includeInactive]);
  return result.rows;
}

async function createLocationInTransaction(client,ctx,input){
  const name=requireText(input.name,'Location name',{max:120});
  const kind=requireOneOf(input.kind,LOCATION_KIND_IDS,'Location type');
    const parent=input.parentLocationId?await requireLocation(client,ctx.workspaceId,input.parentLocationId,'parent location'):null;
    if(parent && !Number(parent.is_active))throw new ValidationError(`${parent.name} is archived and cannot contain another location.`);
    const barcode=trimOrNull(input.barcode);
    const clash=await client.query(`SELECT name FROM locations WHERE workspace_id=$1
      AND (name=$2 OR ($3::text IS NOT NULL AND barcode=$3)) LIMIT 1`,[ctx.workspaceId,name,barcode]);
    if(clash.rows.length)throw new ValidationError(`A location called "${name}" or using that scan code already exists.`);
    const id=newId('loc');
    await client.query(`INSERT INTO locations(id,workspace_id,name,kind,parent_location_id,barcode,pick_sequence,
      note,address,phone,is_active,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)`,
    [id,ctx.workspaceId,name,kind,parent?.id || null,barcode,pickSequence(input.pickSequence),trimOrNull(input.note),
      trimOrNull(input.address),trimOrNull(input.phone),nowIso()]);
    return requireLocation(client,ctx.workspaceId,id);
}

async function createLocation(database,ctx,input){
  return database.transaction((client)=>createLocationInTransaction(client,ctx,input),{isolation:'SERIALIZABLE'});
}

async function updateLocation(database,ctx,id,input){
  return database.transaction(async(client)=>{
    const current=await requireLocation(client,ctx.workspaceId,id);
    const name=requireText(input.name,'Location name',{max:120});
    const kind=requireOneOf(input.kind,LOCATION_KIND_IDS,'Location type');
    const parentId=trimOrNull(input.parentLocationId);
    if(parentId===id)throw new ValidationError('A location cannot contain itself.');
    if(parentId){
      const parent=await requireLocation(client,ctx.workspaceId,parentId,'parent location');
      if(!Number(parent.is_active))throw new ValidationError(`${parent.name} is archived and cannot contain another location.`);
      const descendants=await client.query(`WITH RECURSIVE d(id) AS (SELECT id FROM locations WHERE workspace_id=$1
        AND parent_location_id=$2 UNION ALL SELECT l.id FROM locations l JOIN d ON l.parent_location_id=d.id
        WHERE l.workspace_id=$1) SELECT id FROM d WHERE id=$3`,[ctx.workspaceId,id,parentId]);
      if(descendants.rows.length)throw new ValidationError('That would create a loop in the warehouse layout.');
    }
    const barcode=input.barcode===undefined?current.barcode:trimOrNull(input.barcode);
    const clash=await client.query(`SELECT 1 FROM locations WHERE workspace_id=$1 AND id<>$2
      AND (name=$3 OR ($4::text IS NOT NULL AND barcode=$4)) LIMIT 1`,[ctx.workspaceId,id,name,barcode]);
    if(clash.rows.length)throw new ValidationError('Another location already uses that name or scan code.');
    await client.query(`UPDATE locations SET name=$3,kind=$4,parent_location_id=$5,barcode=$6,pick_sequence=$7,
      note=$8,address=$9,phone=$10 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,name,kind,parentId,barcode,
      input.pickSequence===undefined?Number(current.pick_sequence||0):pickSequence(input.pickSequence),
      input.note===undefined?current.note:trimOrNull(input.note),input.address===undefined?current.address:trimOrNull(input.address),
      input.phone===undefined?current.phone:trimOrNull(input.phone)]);
    return requireLocation(client,ctx.workspaceId,id);
  },{isolation:'SERIALIZABLE'});
}

async function setLocationActive(database,ctx,id,isActive){
  return database.transaction(async(client)=>{
    const location=await requireLocation(client,ctx.workspaceId,id);
    if(!isActive){
      const children=await client.query('SELECT name FROM locations WHERE workspace_id=$1 AND parent_location_id=$2 AND is_active=1 LIMIT 1',[ctx.workspaceId,id]);
      if(children.rows.length)throw new InvariantError(`${location.name} still contains ${children.rows[0].name}. Move or archive its sublocations first.`,'location_has_children');
      const stock=await client.query('SELECT COALESCE(SUM(on_hand),0) AS total FROM balances WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,id]);
      if(Number(stock.rows[0].total)!==0)throw new InvariantError(`${location.name} still holds ${stock.rows[0].total} units. Move the stock elsewhere before archiving it.`,'location_has_stock');
    }
    await client.query('UPDATE locations SET is_active=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,isActive?1:0]);
    return requireLocation(client,ctx.workspaceId,id);
  },{isolation:'SERIALIZABLE'});
}

module.exports={listHierarchy,createLocation,createLocationInTransaction,updateLocation,setLocationActive,requireLocation};
