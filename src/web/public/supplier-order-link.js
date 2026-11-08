'use strict';
const form=document.querySelector('#supplier-document');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  const message=document.querySelector('#upload-status'),submit=form.querySelector('button');
  const file=form.elements.document.files[0];
  if(!file || file.size>4*1024*1024){message.textContent='Choose a PDF up to 4 MB.';return;}
  submit.disabled=true;
  try{
    const response=await fetch(form.dataset.url+form.elements.kind.value,{method:'POST',
      headers:{'Content-Type':'application/pdf','X-CSRF-Token':form.dataset.csrf},body:file});
    message.textContent=response.ok?'Your document was received.':'The file could not be saved. Check the file and try again.';
    if(response.ok) form.reset();
  }catch{message.textContent='The upload was interrupted. You can retry the same document.';}
  finally{submit.disabled=false;}
});
