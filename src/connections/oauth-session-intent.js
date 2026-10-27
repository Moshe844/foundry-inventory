'use strict';
const {AuthenticationError}=require('../domain/errors');
// Some providers implement an installation grant without echoing OAuth state.
// A session-bound, short-lived intent still selects the exact original tenant;
// the adapter independently verifies the expected provider account afterwards.
function assertCanStart(session,provider){const pending=session?.providerInstallIntents?.[provider];if(pending?.expiresAt>Date.now())throw new AuthenticationError('A connection window for this provider is already open. Finish it before starting another connection. Unfinished requests expire after 30 minutes.');}
function remember(session,provider,state){assertCanStart(session,provider);if(typeof state!=='string'||state.length<32)throw new AuthenticationError('Start this connection again.');
 session.providerInstallIntents={...(session.providerInstallIntents||{}),[provider]:{state,expiresAt:Date.now()+require('./authorization-intent').TTL_MS}};}
function resolve(session,provider){const saved=session?.providerInstallIntents?.[provider];if(!saved||typeof saved.state!=='string'||saved.expiresAt<=Date.now())throw new AuthenticationError('Start the connection in StockChief in this browser before approving provider access.');return saved.state;}
function forget(session,provider){if(session?.providerInstallIntents)delete session.providerInstallIntents[provider];}
module.exports={remember,resolve,forget,assertCanStart};
