'use strict';

(() => {
  const form=document.querySelector('[data-receiving-voice-form]');
  if(!form||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder||!window.AudioContext||!window.OfflineAudioContext||!window.DataTransfer)return;
  const start=form.querySelector('[data-record-voice]');
  const stop=form.querySelector('[data-stop-voice]');
  const status=form.querySelector('[data-voice-status]');
  const file=form.querySelector('input[type=file]');
  let recorder,stream,timer,chunks;
  const rate=16000,maximumSeconds=120;
  start.hidden=false;

  function reset(){
    clearTimeout(timer);
    stream?.getTracks().forEach(track=>track.stop());
    start.disabled=false;
    stop.hidden=true;
  }

  async function wav(recording){
    const context=new AudioContext();
    try{
      const decoded=await context.decodeAudioData(await recording.arrayBuffer());
      if(decoded.duration>maximumSeconds+0.25)throw new Error("Voice note too long");
      const frames=Math.min(rate*maximumSeconds,Math.floor(decoded.duration*rate));
      if(frames<rate/4)throw new Error('Voice note too short');
      const offline=new OfflineAudioContext(1,frames,rate);
      const source=offline.createBufferSource();
      source.buffer=decoded;
      source.connect(offline.destination);
      source.start();
      const samples=(await offline.startRendering()).getChannelData(0);
      const bytes=new ArrayBuffer(44+samples.length*2);
      const view=new DataView(bytes);
      function label(at,value){for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));}
      label(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);
      label(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
      view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
      label(36,'data');view.setUint32(40,samples.length*2,true);
      for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
      return new File([bytes],'Receiving voice note.wav',{type:'audio/wav'});
    }finally{await context.close();}
  }

  start.addEventListener('click',async()=>{
    start.disabled=true;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      recorder=new MediaRecorder(stream);
      chunks=[];
      recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data);});
      recorder.addEventListener('error',()=>{reset();status.textContent='The recording stopped. Try again or upload a WAV.';});
      recorder.addEventListener('stop',async()=>{
        reset();
        start.disabled=true;
        try{
          const note=await wav(new Blob(chunks,{type:recorder.mimeType}));
          const selection=new DataTransfer();
          selection.items.add(note);
          file.files=selection.files;
          status.textContent='Recording attached. Check the purchase order number and prepare the receipt.';
        }catch{status.textContent='The recording could not be prepared. Try again or upload a WAV.';}
        finally{chunks=[];start.disabled=false;}
      });
      recorder.start();
      timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},maximumSeconds*1000);
      stop.hidden=false;
      status.textContent='Recording. Say the product, quantity and unit.';
    }catch{reset();status.textContent='Microphone access is unavailable. You can still upload a WAV.';}
  });
  stop.addEventListener('click',()=>{if(recorder?.state==='recording')recorder.stop();});
  form.addEventListener('submit',event=>{if(recorder?.state==='recording'){event.preventDefault();status.textContent='Stop the recording before submitting.';}});
})();
