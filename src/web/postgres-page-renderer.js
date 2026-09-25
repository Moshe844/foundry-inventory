'use strict';

function postgresPageRenderer(req,res,next){
  res.page=(view,data={})=>{const onboardingEntry=data.onboardingEntry || data.layoutOnboardingEntry || res.locals.globalOnboardingEntry || null;
    return res.render(view,{...data,onboardingEntry},(error,body)=>{
    if(error)return next(error);
    if(data.layout===false)return res.send(body);
    const currentHref=(()=>{try{const parsed=new URL(req.originalUrl||req.path||'/',`http://${req.get('host')}`);
      return `${parsed.pathname}${parsed.search}`;}catch{return req.path||'/';}})();
    if(req.session&&data.title){const labels=req.session.renderedPageLabels||{};
      labels[currentHref]=String(data.title).replace(/\s+·\s+StockChief$/,'').slice(0,100);
      for(const key of Object.keys(labels).slice(0,Math.max(0,Object.keys(labels).length-40)))delete labels[key];
      req.session.renderedPageLabels=labels;}
    let arrivedFrom=null;
    if(!data.suppressBack&&!data.backTo&&!data.backToFallback){try{const referer=new URL(req.get('referer'));
      if(referer.host===req.get('host')){const href=`${referer.pathname}${referer.search}`;
        if(href!==currentHref)arrivedFrom={href,label:req.session?.renderedPageLabels?.[href]||'previous page'};}}
    catch{arrivedFrom=null;}}
    return res.render('layout',{...data,body,title:data.title || 'StockChief',nav:data.nav || null,
      assetVersion:res.locals.assetVersion,
      backTo:data.suppressBack?null:(data.backTo || arrivedFrom || data.backToFallback || null),
      onboardingEntry,
      navigationArrival:null,workspaceGuidance:null,assistantQueue:req.session?.assistantQueue||null,
      currentHref,screenGuide:data.screenGuide || null,
      origin:data.origin || `${req.protocol}://${req.get('host')}`});
    });
  };
  next();
}

module.exports={postgresPageRenderer};
