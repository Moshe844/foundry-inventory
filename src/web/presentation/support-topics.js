'use strict';
// The support form says what the link that opened it was about: a question
// about a connection is not "what went wrong". Each public link names its topic
// (/support?topic=connection&about=Shopify); without one, the form is the
// problem report it has always been.
const PRIVACY='Your request stays in StockChief. Replies go to your email. Please leave out passwords, API keys and payment-card details.';
const TOPICS=Object.freeze({
  problem:{heading:'Tell us what happened',subject:'',body:'What were you doing, and what went wrong?',button:'Send support request'},
  help:{heading:'How can we help?',subject:'',body:'What would you like help with?',button:'Send'},
  connection:{heading:'Ask about a connection',subject:about=>about?'Turn on '+about:'Question about a connection',
    body:'Which system do you use, and what should StockChief do with it?',button:'Send question',channel:'ONBOARDING'},
  security:{heading:'Ask a security question',subject:'Security question',body:'What would you like to know about how StockChief protects your data?',button:'Send question'},
  requirement:{heading:'Discuss a requirement',subject:'Requirement',body:'What do you need StockChief to do, and when do you need it?',button:'Send'},
  billing:{heading:'Change your plan',subject:'Plan change',body:'Which plan would you like, and for which business?',button:'Send'},
  migration:{heading:'Plan a complex migration',subject:'Migration',body:'Which system are you moving from, and about how many products, locations and orders?',button:'Send',channel:'MIGRATION'},
  contact:{heading:'Get in touch',subject:'',body:'What would you like to tell us?',button:'Send message'}
});

function topic(query={}){
  const key=Object.hasOwn(TOPICS,query.topic)?query.topic:'problem',t=TOPICS[key];
  // A connection name from the link, kept to letters, numbers and simple punctuation.
  const about=String(query.about||'').replace(/[^\p{L}\p{N} .&/()+-]/gu,'').trim().slice(0,80);
  return {key,heading:t.heading,intro:PRIVACY,subject:typeof t.subject==='function'?t.subject(about):t.subject,
    body:t.body,button:t.button,channel:t.channel||null};
}

module.exports={topic,TOPICS};
