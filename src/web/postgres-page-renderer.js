'use strict';

const {sections:moreSections}=require('./routes/postgres-settings');

function postgresPageRenderer(req,res,next){
  const render=res.render.bind(res);
  // Both shell pages and standalone business documents use server templates.
  // Mark only successful authenticated renders; raw endpoints, failed renders
  // and unauthenticated pages cannot manufacture application evidence.
  res.render=(view,data,callback)=>{
    if(typeof data==='function'){callback=data;data=undefined;}
    return render(view,data,(error,body)=>{
      if(!error&&res.statusCode===200&&req.ctx?.workspaceId)res.set('X-StockChief-Page','1');
      if(!error&&typeof body==='string')body=require('./presentation/link-destinations').declare(body);
      if(!error&&view.startsWith('auth/')&&req.session)
        req.session.flash=(req.session.flash||[]).filter(m=>m.scope&&m.scope!==req.path);
      if(callback)return callback(error,body);
      if(error)return next(error);
      return res.send(body);
    });
  };
  res.page=(view,data={})=>{const onboardingEntry=['inventory/new','imports/start','imports/postgres-preview','imports/supplier-preview','imports/source-upload'].includes(view)?null:
    data.onboardingEntry || data.layoutOnboardingEntry || res.locals.globalOnboardingEntry || null;
    return res.render(view,{...data,onboardingEntry,pageSection:require('./presentation/navigation').sectionFor(req.path)},(error,body)=>{
    if(error)return next(error);
    if(data.layout===false)return res.send(body);
    const flashMessages=(req.session?.flash||res.locals.flash||[]).filter(m=>!m.scope||m.scope===req.path);
    if(req.session)req.session.flash=(req.session.flash||[]).filter(m=>m.scope&&m.scope!==req.path);
    const currentHref=(()=>{try{const parsed=new URL(req.originalUrl||req.path||'/',`http://${req.get('host')}`);
      return `${parsed.pathname}${parsed.search}`;}catch{return req.path||'/';}})();
    // Only successful authenticated application pages can acknowledge delivery.
    // Errors, auth redirects, raw endpoints and the private agent session cannot.
    // Track actual rendered application pages, not API polls or a manually
    // enumerated route catalogue. Ask itself must not erase its source screen.
    if(req.method==='GET'&&req.ctx?.workspaceId&&req.session&&!data.postgresAsk&&res.statusCode<400){
      const path=require('../assistant/agent-navigation-path').localPath(currentHref);
      if(path)req.session.postgresAskPageContext={workspaceId:req.ctx.workspaceId,path};
    }
    const pending=req.session?.agentNavigation;
    const agentArrival=res.statusCode===200&&pending&&pending.href===currentHref&&
      pending.workspaceId===req.ctx?.workspaceId&&pending.actorId===req.ctx?.actorId?pending:null;
    if(req.session&&data.title){const labels=req.session.renderedPageLabels||{};
      labels[currentHref]=String(data.title).replace(/\s+·\s+StockChief$/,'').slice(0,100);
      for(const key of Object.keys(labels).slice(0,Math.max(0,Object.keys(labels).length-40)))delete labels[key];
      req.session.renderedPageLabels=labels;}
    let arrivedFrom=null;
    if(!data.suppressBack&&!data.backTo&&!data.backToFallback){try{const referer=new URL(req.get('referer'));
      if(referer.host===req.get('host')){const href=`${referer.pathname}${referer.search}`;
        if(href!==currentHref)arrivedFrom=require('./presentation/return-navigation').resolve(currentHref,href,req.session?.renderedPageLabels);}}
    catch{arrivedFrom=null;}}
    // A page's own way back keeps the list page, filter and sort you came from.
    let setBack=data.backTo||null;
    if(setBack?.href)try{const referer=new URL(req.get('referer')),own=new URL(setBack.href,'http://stockchief.invalid');
      if(referer.host===req.get('host')&&referer.pathname===own.pathname&&referer.search)setBack={...setBack,href:`${referer.pathname}${referer.search}`};}
    catch{/* no usable referer: keep the page's own link */}
    // Menu pages are always one click away in the menu, so they get no "Back to" link.
    const menuPage=(()=>{const nav=require('./presentation/navigation'),path=currentHref.split('?')[0];return [...nav.sections,...nav.footer].some(entry=>entry.href===path);})();
    return res.render('layout',{...data,body,title:data.title || 'StockChief',nav:data.nav || null,
      moreSections,panelMode:req.path==='/ask'&&req.query.panel==='1',navigation:require('./presentation/navigation'),pageSection:require('./presentation/navigation').sectionFor(req.path),
      assetVersion:res.locals.assetVersion,
      flash:flashMessages,csrfToken:res.locals.csrfToken,
      backTo:data.suppressBack||menuPage?null:(setBack || arrivedFrom || data.backToFallback || null),
      onboardingEntry,
      navigationArrival:null,agentArrival,workspaceGuidance:null,assistantQueue:req.session?.assistantQueue||null,
      currentHref,screenGuide:data.screenGuide || null,
      origin:data.origin || `${req.protocol}://${req.get('host')}`});
    });
  };
  next();
}

module.exports={postgresPageRenderer};
