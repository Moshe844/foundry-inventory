'use strict';
// Support message boxes take files: choose them, drop them on the box, or paste a
// screenshot. Each waiting file shows in a tray above the box with a way to remove
// it, and the message sends them together. Loaded before support-chat.js.
(()=>{
 const MAX_FILES=5,MAX_BYTES=10*1024*1024,MAX_TOTAL=20*1024*1024;
 const IMAGE=/^image\/(png|jpeg|gif|webp)$/;
 const size=n=>n<1024?n+' bytes':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(n<10485760?1:0)+' MB';
 const stamp=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;};
 function say(form,text){const status=document.querySelector('[data-support-live-status]');if(status)status.textContent=text;const note=form.querySelector('.sup-attach small');if(note){note.textContent=text;note.classList.add('is-warning');}}
 function setup(form){
  const input=form.querySelector('[data-support-files]'),tray=form.querySelector('[data-support-tray]'),box=form.querySelector('textarea');
  if(!input||!tray)return;
  const note=form.querySelector('.sup-attach small'),hint=note?note.textContent:'';
  const pending=[];form.supportFiles=pending;
  function render(){
   tray.replaceChildren();tray.hidden=!pending.length;if(box)box.required=!pending.length;
   if(note){note.textContent=hint;note.classList.remove('is-warning');}
   pending.forEach((file,index)=>{
    const chip=document.createElement('div');chip.className='sup-chip'+(IMAGE.test(file.type)?' sup-chip--image':'');
    if(IMAGE.test(file.type)){const img=document.createElement('img');img.alt='';const reader=new FileReader();reader.onload=()=>{img.src=reader.result;};reader.readAsDataURL(file);chip.append(img);}
    const text=document.createElement('span');text.className='sup-chip__text';const name=document.createElement('strong');name.textContent=file.name;const small=document.createElement('small');small.textContent=size(file.size);text.append(name,small);chip.append(text);
    const remove=document.createElement('button');remove.type='button';remove.className='sup-chip__remove';remove.setAttribute('aria-label','Remove '+file.name);remove.textContent='×';
    remove.addEventListener('click',()=>{pending.splice(index,1);render();box?.focus();});chip.append(remove);tray.append(chip);
   });
  }
  function add(files){
   for(const original of files){
    let file=original;
    if(!file||!file.size)continue;
    // A pasted screenshot arrives as "image.png"; name it by when it was taken.
    if(/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)||!file.name)file=new File([file],'Screenshot '+stamp()+'.'+(file.type.split('/')[1]||'png').replace('jpeg','jpg'),{type:file.type});
    if(pending.length>=MAX_FILES){render();say(form,'Attach up to '+MAX_FILES+' files to one message.');return;}
    if(file.size>MAX_BYTES){render();say(form,file.name+' is larger than 10 MB. Attach a smaller file or a screenshot of the part that matters.');return;}
    if(pending.reduce((n,f)=>n+f.size,0)+file.size>MAX_TOTAL){render();say(form,'These files are more than 20 MB together. Send them in two messages.');return;}
    pending.push(file);
   }
   render();
  }
  input.addEventListener('change',()=>{add([...input.files]);input.value='';});
  box?.addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])];if(!files.length)return;event.preventDefault();add(files);});
  for(const type of ['dragenter','dragover'])form.addEventListener(type,event=>{if(![...(event.dataTransfer?.types||[])].includes('Files'))return;event.preventDefault();form.classList.add('is-dropping');});
  for(const type of ['dragleave','drop'])form.addEventListener(type,event=>{if(type==='dragleave'&&form.contains(event.relatedTarget))return;form.classList.remove('is-dropping');});
  form.addEventListener('drop',event=>{if(!event.dataTransfer?.files?.length)return;event.preventDefault();add([...event.dataTransfer.files]);});
  form.supportFilesClear=()=>{pending.splice(0);render();};
 }
 document.querySelectorAll('[data-support-start-form],[data-support-reply]').forEach(setup);
})();
