'use strict';

// Job 83: the outside services that carry customer orders by text message
// (SMS) and WhatsApp.
//
// Both channels run on StockChief's own Twilio account, the text provider of
// job 173 (alert-providers.js), set by the server's environment. Each business
// has its own number on that account for each channel. Twilio sends every
// message for that number to the business's private StockChief link, signed
// with the account's auth token; StockChief replies from the same number.
// WhatsApp uses Twilio's WhatsApp sender, whose addresses carry `whatsapp:`.
//
// A provider is {channel, label, available(env), read(request, settings),
// send(message, settings)}. The worker can be given another sender (the tests
// use a fake); the live sender refuses to run under NODE_ENV=test, so a test
// can never text a real customer.

const alerts=require('./alert-providers');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');

const NUMBER=/^\+[1-9]\d{7,14}$/;

function twilioChannel(channel,label,prefix){
  const address=number=>prefix+number;
  return {channel,label,prefix,address,
    available:(env=process.env)=>Boolean(alerts.smsSettings(env)),
    // Reads one signed incoming message: {channel, from, to, reference, body, media}.
    read({url,params,signature},settings=alerts.smsSettings()){
      if(!settings)throw new NotFoundError('Text orders are not set up on this server.');
      if(!alerts.validTwilioSignature(url,params,signature,settings.token))throw new AuthorizationError('This message is not signed by the text provider.');
      const from=String(params.From||''),to=String(params.To||''),reference=String(params.MessageSid||params.SmsMessageSid||'');
      if(!from.startsWith(prefix)||!to.startsWith(prefix))return null;
      const sender=from.slice(prefix.length),line=to.slice(prefix.length);
      if(!NUMBER.test(sender)||!NUMBER.test(line)||!/^[A-Za-z0-9]{10,120}$/.test(reference))throw new ValidationError('The text provider sent an incomplete message.');
      const media=Number(params.NumMedia||0);
      return {channel,from:sender,to:line,reference,body:String(params.Body||'').slice(0,4000),media:Number.isSafeInteger(media)&&media>0?media:0};
    },
    send:({from,to,body},settings)=>alerts.sendMessage({from:address(from),to:address(to),body},settings)
  };
}

const providers={
  SMS:twilioChannel('SMS','Text message',''),
  WHATSAPP:twilioChannel('WHATSAPP','WhatsApp','whatsapp:')
};

// The channel a signed message arrived on. WhatsApp addresses carry their prefix.
function read(request,settings){
  const whatsapp=String(request.params?.From||'').startsWith('whatsapp:');
  const message=providers[whatsapp?'WHATSAPP':'SMS'].read(request,settings);
  if(!message)throw new ValidationError('The text provider sent an incomplete message.');
  return message;
}
function available(env=process.env){return Object.fromEntries(Object.entries(providers).map(([key,p])=>[key,p.available(env)]));}
async function send(message,settings){
  const provider=providers[message.channel];
  if(!provider)throw Object.assign(new Error('That text channel is not offered.'),{status:400});
  return provider.send(message,settings);
}

module.exports={NUMBER,providers,read,available,send};
