'use strict';
function status(connection){
  if(!connection||connection.status==='disconnected')return 'Not connected';
  if(['AUTHORIZATION_FAILED','REAUTHORIZATION_REQUIRED'].includes(connection.setup_status))return 'Error';
  const health=connection.publicStatus||require('../../connections/postgres-service').publicStatus(connection);
  return health==='Needs attention'?'Error':health==='Disconnected'?'Not connected':health;
}
const names={shopify:'Shopify',woocommerce:'WooCommerce',bigcommerce:'BigCommerce',square:'Square',clover:'Clover',gmail:'Gmail',microsoft365:'Microsoft 365',quickbooks:'QuickBooks',xero:'Xero',stripe:'Stripe',cardknox:'Sola / Cardknox',shipstation:'ShipStation',shipstation_custom_store:'ShipStation Custom Store',shipengine:'ShipEngine',easypost:'EasyPost',shippo:'Shippo'};
const descriptions={shopify:'Import orders and keep products and stock in sync.',woocommerce:'Connect your store and keep stock and orders in sync.',bigcommerce:'Import products and orders, and keep stock in sync.',square:'Import sales and keep product stock in sync.',clover:'Connect your register, sales and product stock.',gmail:'Read business emails and prepare replies for review.',microsoft365:'Read business emails and prepare replies for review.',quickbooks:'Connect invoices, payments and your accounting records.',xero:'Connect invoices, payments and your accounting records.',reference_webhook:'Connect your own software using the business API.',erp_future:'Discuss connecting another business system.'};
function name(connection){return names[connection.provider_type]||connection.provider_type.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());}
function historyLabel(connection){return name(connection)+' · '+status(connection);}
function description(provider){return descriptions[provider.type]||'Connect your business account.';}
function logo(type){return type==='shipstation_custom_store'?'shipstation':['shopify','woocommerce','bigcommerce','square','clover','gmail','microsoft365','quickbooks','xero','stripe','cardknox','shipstation'].includes(type)?type:null;}
function issue(connection){if(status(connection)!=='Error')return null;if(['AUTHORIZATION_FAILED','REAUTHORIZATION_REQUIRED'].includes(connection.setup_status))return 'Sign in again to restore access.';if(connection.itemsNeedingMapping||connection.locationsNeedingMapping)return 'Match your products and locations to finish setup.';if(connection.openIssues)return 'Review the unresolved connection issues.';if(connection.last_error)return 'The last update failed. Review the connection to continue.';return 'Updates are behind. Check and resume the connection.';}
function availableForCustomer(provider,runtime){return runtime!=='production'||!provider.sandboxMode;}
function cards(catalog,connections){
  return catalog.map(provider=>{
    const records=connections.filter(c=>c.provider_type===provider.type&&c.status!=='disconnected');
    const connection=records.find(c=>status(c)==='Connected')||records[0]||null;
    const state=status(connection);
    return {provider,connection,records,state,lastSync:connection?.last_synced_at||null,
      action:connection?'Manage':'Connect',href:connection?'/settings/connections/'+encodeURIComponent(connection.id):null,
      needsMatching:Number(connection?.itemsNeedingMapping||0)+Number(connection?.locationsNeedingMapping||0)};
  });
}
module.exports={status,cards,name,historyLabel,description,logo,issue,availableForCustomer};
