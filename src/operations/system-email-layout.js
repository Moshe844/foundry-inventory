'use strict';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(message){
 if(String(message.html||'').includes('data-stockchief-email="1"'))return message;
 const support=require('../config').supportEmail||'support@stockchiefhq.com',signature='StockChief\n'+support;
 const content=message.html||'<p style="white-space:pre-wrap">'+escape(message.text||'')+'</p>';
 return {...message,replyTo:message.replyTo||support,text:String(message.text||'')+'\n\n'+signature,
  html:'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>'+escape(message.subject||'StockChief')+'</title></head><body style="margin:0;background:#f6f7fb;color:#172033;font:16px/1.6 Arial,sans-serif"><div data-stockchief-email="1" style="max-width:600px;margin:24px auto;padding:28px;background:white;border:1px solid #e2e6ee;border-radius:12px"><div style="color:#5b4be8;font-size:21px;font-weight:bold;margin-bottom:24px">StockChief</div><h1 style="font-size:23px;line-height:1.3">'+escape(message.subject||'StockChief')+'</h1>'+content+'<hr style="border:0;border-top:1px solid #e2e6ee;margin:28px 0"><p style="font-size:13px;color:#657086">StockChief<br><a href="mailto:'+escape(support)+'">'+escape(support)+'</a></p></div></body></html>'};
}
module.exports={render,escape};
