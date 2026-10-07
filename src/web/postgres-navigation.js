'use strict';

const {destinations}=require('../product-brain/catalog');

// The model selects a registered destination ID. Only this server-owned map
// can turn that ID into an actual PostgreSQL page URL.
const postgresDestinations=Object.freeze({home:'/', 'needs-you':'/needs-you',ask:'/ask',
  inventory:'/inventory',locations:'/locations',warehouse:'/warehouse',transfers:'/transfers',
  purchasing:'/purchasing',suppliers:'/suppliers',sales:'/orders',accounting:'/money',
  planning:'/planning',connections:'/settings/connections',mail:'/mail',
  shipping:'/settings/shipping',autopilot:'/autopilot',imports:'/imports',
  actions:'/actions',activity:'/activity',settings:'/settings',workspaces:'/inventories',
  onboarding:'/onboarding',migration:'/imports',support:'/support',repairs:'/repairs',
  operations:'/settings/operations'});
const postgresLabels=Object.freeze({mail:'Business mailbox',sales:'Customer orders',accounting:'Money'});
function destinationById(id){
  const href=postgresDestinations[id];
  const definition=destinations.find((entry)=>entry.id===id);
  return href&&definition?{href,label:postgresLabels[id]||definition.label}:null;
}

module.exports={destinationById,postgresDestinations};
