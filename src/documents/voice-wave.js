'use strict';

const {ValidationError}=require('../domain/errors');
const maxSeconds=120;
const maxBytes=48000*2*maxSeconds+44;

function validate(buffer){
  const invalid=()=>new ValidationError('Record or upload an uncompressed mono WAV voice note up to two minutes.');
  if(!Buffer.isBuffer(buffer)||buffer.length<44||buffer.length>maxBytes||
    buffer.toString('ascii',0,4)!=='RIFF'||buffer.readUInt32LE(4)!==buffer.length-8||
    buffer.toString('ascii',8,12)!=='WAVE')throw invalid();
  let format,data;
  for(let offset=12;offset<buffer.length;){
    if(offset+8>buffer.length)throw invalid();
    const name=buffer.toString('ascii',offset,offset+4),size=buffer.readUInt32LE(offset+4);
    const start=offset+8,end=start+size;
    offset=end+(size%2);
    if(offset>buffer.length)throw invalid();
    if(name==='fmt '){
      if(format||size<16||size>40)throw invalid();
      format=buffer.subarray(start,start+16);
    }
    if(name==='data'){
      if(data||!size||size%2)throw invalid();
      data=buffer.subarray(start,end);
    }
  }
  if(!format||!data)throw invalid();
  const sampleRate=format.readUInt32LE(4);
  if(format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||sampleRate<8000||sampleRate>48000||
    format.readUInt32LE(8)!==sampleRate*2||format.readUInt16LE(12)!==2||format.readUInt16LE(14)!==16)throw invalid();
  const seconds=data.length/(sampleRate*2);
  if(seconds<0.15||seconds>maxSeconds)throw invalid();
  // Rebuild the two validated chunks so no unrelated metadata or embedded data is sent.
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(data.length+36,4);
  header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);format.copy(header,20);
  header.write('data',36);header.writeUInt32LE(data.length,40);
  return {wave:Buffer.concat([header,data]),seconds};
}

module.exports={validate,maxSeconds,maxBytes};
