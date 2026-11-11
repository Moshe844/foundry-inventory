'use strict';
const {review:credit}=require('./order-credit-exposure');

module.exports=[
  {id:80,key:'order-credit-limits',label:'Check order exposure against customer credit limits',readPage:credit},
  {id:82,key:'order-price-exceptions',label:'Find below-cost orders and discount differences',readPage:require('./agent-order-price-alerts').review}
];
