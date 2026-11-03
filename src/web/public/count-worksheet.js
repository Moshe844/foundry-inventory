'use strict';
(function(){
 async function* csvRows(chunks){let field='',row=[],quoted=false,closedQuote=false,skipLf=false;
  for await(const chunk of chunks)for(const c of chunk){
   if(skipLf){skipLf=false;if(c==='\n')continue;}
   if(quoted){if(c==='"'){quoted=false;closedQuote=true;}else field+=c;}
   else if(closedQuote&&c==='"'){field+='"';quoted=true;closedQuote=false;}
   else {closedQuote=false;if(c==='"'&&field==='')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'||c==='\r'){row.push(field);if(row.some(v=>v!==''))yield row;field='';row=[];skipLf=c==='\r';}else field+=c;}
   if(field.length>16384||row.length>32)throw Error('This CSV contains an oversized field or too many columns. Use the downloaded count worksheet.');
  }
  if(quoted)throw Error('A quoted CSV field is incomplete. Save the worksheet as a complete CSV and try again.');
  if(field!==''||row.length){row.push(field);yield row;}
 }
 if(typeof module!=='undefined')module.exports={csvRows};
 if(typeof document==='undefined')return;
 const form=document.querySelector('[data-count-upload]');if(!form)return;
 form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button'),status=form.querySelector('[role=status]'),file=form.querySelector('input[type=file]').files[0];if(!file)return;
  button.disabled=true;let saved=0,total=0,batch=[],revision=Number(form.dataset.revision),columns;
  async function send(){if(!batch.length)return;const response=await fetch(form.action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':form.dataset.csrf},body:JSON.stringify({revision,lines:batch})}),data=await response.json();if(!response.ok)throw Error(data.message||data.error?.message||'The worksheet changed. Reload it before continuing; saved counts are preserved.');revision=data.revision;saved+=data.saved;batch=[];status.textContent=saved.toLocaleString()+' counts saved. Stock is unchanged until owner approval.';}
  try{
   if(file.size>256*1024*1024)throw Error('Use a count CSV no larger than 256 MB.');
   const chunks=(async function*(){const reader=file.stream().getReader(),decoder=new TextDecoder();try{for(;;){const {value,done}=await reader.read();if(done)break;yield decoder.decode(value,{stream:true});}yield decoder.decode();}finally{reader.releaseLock();}})();
   for await(const row of csvRows(chunks)){
    if(!columns){columns=new Map(row.map((v,i)=>[v.replace(/^\uFEFF/,'').trim().toLowerCase(),i]));for(const name of ['sku','location','counted quantity','stock position reference'])if(!columns.has(name))throw Error('Use the downloaded worksheet with SKU, Location, Counted quantity and Stock position reference columns.');continue;}
    if(++total>1000000)throw Error('One count upload can contain at most one million positions.');
    const get=name=>String(row[columns.get(name)]??'').trim(),quantity=get('counted quantity');if(quantity==='')continue;
    const position=get('stock position reference').split(':');if(position.length!==2||!position.every(v=>/^[a-zA-Z0-9_-]+$/.test(v)))throw Error('Keep the stock position references from the downloaded worksheet unchanged.');
    batch.push({locationId:position[0],skuId:position[1],quantity,unitCost:get('unit cost')});if(batch.length===250)await send();
   }
   await send();if(!saved)throw Error('No counted quantities were provided. Blank quantities stay uncounted.');status.textContent=saved.toLocaleString()+' counts saved. Reload this worksheet to review all variances before approval.';form.dataset.revision=String(revision);
  }catch(error){status.textContent=error.message+' '+saved.toLocaleString()+' counts were saved; stock has not been changed.';}
  finally{button.disabled=false;}
 });
})();
