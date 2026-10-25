'use strict';
const express=require('express'),store=require('../../shipping/shipstation-custom-store'),{asyncRoute}=require('../middleware');
function createShipStationCustomRouter(database){const router=express.Router(),path='/api/v1/shipping/shipstation-custom/:id';
 router.use('/api/v1/shipping/shipstation-custom',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const auth=asyncRoute(async(req,res,next)=>{try{req.store=await store.authenticate(database,req.params.id,req.get('authorization'));return next();}catch(error){if(error.status===401){res.set('WWW-Authenticate','Basic realm="StockChief shipping"');return res.status(401).type('text/plain').send('StockChief could not verify this store connection.');}throw error;}});
 router.get(path,auth,asyncRoute(async(req,res)=>{if(req.query.action!=='export')return res.status(400).type('text/plain').send('Choose export.');return res.type('application/xml').send(await store.exportParcels(database,req.store,req.query));}));
 router.post(path,auth,express.text({type:'*/*',limit:'256kb'}),asyncRoute(async(req,res)=>{if(req.query.action!=='shipnotify')return res.status(400).type('text/plain').send('Choose shipnotify.');await store.notify(database,req.store,req.query,req.body);return res.type('application/xml').send('<Success>true</Success>');}));
 return router;
}
module.exports={createShipStationCustomRouter};
