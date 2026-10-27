# Connection consent lifecycle

Authorization is a temporary server-owned intent, scoped to the initiating owner
and inventory, with a hashed single-use state and a thirty-minute expiry. It is
not a connection, history entry, or capacity reservation. Closing or rejecting
replacement consent leaves the established grant untouched.

The verified callback checks the current owner, capabilities and account-wide
capacity inside the activation transaction. Only then does it insert a connector
and persist its encrypted credentials. Consent for an already-connected provider
account reuses that connector. Stripe and WooCommerce follow the same lifecycle;
WooCommerce also verifies callback fingerprints and handles its asynchronous
browser return independently of its server-to-server credential delivery.

Migration 116 makes the authorization-state connector reference optional and
records the first established connection time. Existing relationships, provider
account evidence, credentials and history are preserved. Deployment does not
delete existing connectors. Empty historical consent cleanup is a separately
authorized and audited operation.

The migration is additive and compatible with the previous application during
deployment. Application rollback can leave its nullable reference and history
column in place. To remove the migration later, first stop new consent admission,
allow pending intents to expire and remove only expired unused intents without
connector references. Then restore NOT NULL on the reference, drop the
connection_established_history trigger and stockchief_keep_connection_history
function, and drop first_connected_at after preserving its audit export. Never
remove established connectors or used authorization records to roll back.

Connection UI regressions run against actual Chromium and isolated PostgreSQL.
Provider consent is simulated; this does not certify live merchant authorization.
The tests also cover capacity races, callback replay, encrypted credentials,
preserved disconnected history, responsive layouts and mailbox preparation
settings. They make no paid model calls and send no emails.
