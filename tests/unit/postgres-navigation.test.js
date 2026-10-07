'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {destinationFor,connectionDestination}=require('../../src/web/postgres-navigation');

test('Ask opens a unique connected provider setting without guessing another workspace account',()=>{
  const destination=destinationFor('Open my Gmail connection settings.');
  assert.equal(destination.providerType,'gmail');
  const rows=[{id:'gmail-owner',provider_type:'gmail',status:'connected'},
    {id:'outlook-owner',provider_type:'microsoft365',status:'connected'}];
  assert.deepEqual(connectionDestination(destination,rows),
    {href:'/settings/connections/gmail-owner',label:'Gmail settings'});
  assert.deepEqual(connectionDestination(destination,[]),
    {href:'/settings/connections',label:'Connections'});
  assert.deepEqual(connectionDestination(destination,rows.concat({id:'gmail-second',provider_type:'gmail',status:'connected'})),
    {href:'/settings/connections',label:'Connections'});
});

test('Ask retains existing page navigation and does not mistake mailbox access for settings',()=>{
  assert.equal(destinationFor('Open the inventory page').href,'/inventory');
  assert.equal(destinationFor('Open my email inbox').href,'/mail');
  assert.equal(destinationFor('Open Gmail settings').providerType,'gmail');
  assert.equal(destinationFor('Open Microsoft 365 connection settings').providerType,'microsoft365');
  assert.equal(destinationFor('Please send an email to our supplier'),null);
});
