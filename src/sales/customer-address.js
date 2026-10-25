'use strict';const {ValidationError}=require('../domain/errors');
function fromInput(input){const fields={line1:input.addressLine1,line2:input.addressLine2,city:input.city,state:input.state,postalCode:input.postalCode,country:input.country||'US'};
 for(const key of Object.keys(fields)){fields[key]=String(fields[key]||'').trim();if(fields[key].length>200)throw new ValidationError('Address fields must be at most 200 characters.');}
 if(![fields.line1,fields.line2,fields.city,fields.state,fields.postalCode].some(Boolean))return {fields:null,text:String(input.shippingAddress||'').trim()||null};
 fields.country=fields.country.toUpperCase();if(!fields.line1||!fields.city||!/^[A-Z]{2}$/.test(fields.country))throw new ValidationError('Enter the street, city and two-letter country code for this address.');
 if(['US','CA','GB'].includes(fields.country)&&!fields.postalCode)throw new ValidationError('Enter the postal code for this address.');
 if(fields.country==='US'&&!fields.state)throw new ValidationError('Enter the state for this US address.');
 return {fields,text:[fields.line1,fields.line2,fields.city+(fields.state?', '+fields.state:'')+(fields.postalCode?' '+fields.postalCode:''),fields.country].filter(Boolean).join('\n')};
}
module.exports={fromInput};
