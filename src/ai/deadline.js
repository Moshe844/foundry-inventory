'use strict';

const { ProviderError } = require('./provider');

async function completeWithin(provider,request,timeoutMs=75000) {
  const controller=new AbortController();
  const duration=Number(timeoutMs);
  if(!Number.isFinite(duration)||duration<=0)throw new Error('A model deadline must be a positive finite duration.');
  let timer;
  let cancel;
  const stopped=new Promise((resolve,reject)=>{
    cancel=()=>{
      const reason=request.signal?.aborted ? request.signal.reason : new Error('read_timeout');
      const error=request.signal?.aborted && reason instanceof Error ? reason
        : new ProviderError('StockChief could not finish reading in time. Nothing changed. Please try again.',
          {code:'ai_timeout',status:503,retryable:true,cause:reason});
      reject(error);
      controller.abort(reason);
    };
    timer=setTimeout(cancel,duration);
    if(request.signal)request.signal.addEventListener('abort',cancel,{once:true});
  });
  try {
    if(request.signal?.aborted)cancel();
    return await Promise.race([stopped,Promise.resolve().then(()=>{
      if(controller.signal.aborted)throw controller.signal.reason;
      return provider.complete({...request,signal:controller.signal});
    })]);
  } finally {
    clearTimeout(timer);
    if(request.signal)request.signal.removeEventListener('abort',cancel);
  }
}

module.exports={completeWithin};
