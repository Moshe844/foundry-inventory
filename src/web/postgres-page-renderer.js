'use strict';

function postgresPageRenderer(req,res,next){
  res.page=(view,data={})=>res.render(view,{...data,onboardingEntry:data.onboardingEntry || null},(error,body)=>{
    if(error)return next(error);
    if(data.layout===false)return res.send(body);
    return res.render('layout',{...data,body,title:data.title || 'StockChief',nav:data.nav || null,
      backTo:data.suppressBack?null:(data.backTo || data.backToFallback || null),
      onboardingEntry:data.layoutOnboardingEntry || res.locals.globalOnboardingEntry || null,
      navigationArrival:null,workspaceGuidance:null,assistantQueue:null,
      currentHref:req.originalUrl || req.path || '/',screenGuide:data.screenGuide || null,
      origin:data.origin || `${req.protocol}://${req.get('host')}`});
  });
  next();
}

module.exports={postgresPageRenderer};
