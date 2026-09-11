# ShipEngine shipping in Foundry

Foundry uses ShipEngine as a platform, not as one shared shipping account.

Each Foundry workspace receives a separate ShipEngine seller account. The business owner uses
ShipEngine Elements once to confirm the ship-from address, activate a carrier, and add the payment
method that funds that seller's labels. Foundry stores the returned seller API credential in the
encrypted workspace credential store. Rate requests and label purchases use that seller credential;
the platform credential is never used to buy postage.

## Platform configuration

ShipEngine supplies these values during partner and Elements onboarding:

```text
SHIPENGINE_PLATFORM_API_KEY=
SHIPENGINE_PARTNER_ID=
SHIPENGINE_PLATFORM_PRIVATE_KEY_PATH=
SHIPENGINE_PLATFORM_TOKEN_ISSUER=
SHIPENGINE_PLATFORM_TOKEN_KEY_ID=
SHIPENGINE_PLATFORM_SCOPE=
```

`SHIPENGINE_PLATFORM_PRIVATE_KEY` may be used instead of the path. Keep the private key and platform
API key in the production secret manager, never in source control.

A normal `TEST_...` sandbox API key is useful for testing one account, but it is not a replacement
for a ShipEngine Partner account. It cannot provide isolated seller onboarding for Foundry customers.

As confirmed by ShipStation API in September 2026, Partner API access and Shipping Elements are
Enterprise-plan capabilities with custom pricing. Do not treat a self-service Free or Advanced key
as permission to create seller accounts. Until Foundry has an Enterprise/Partner agreement, each
business may instead connect its own self-service shipping account and API key; that keeps postage
and subscription charges with that business but does not provide Foundry's embedded one-click
seller onboarding.

## Owner flow

1. The owner selects **Set up shipping** in Foundry.
2. Foundry creates an isolated ShipEngine seller and opens ShipEngine Elements in Foundry.
3. The business address is prefilled from the first active Foundry location.
4. The owner activates a carrier and adds their payment method once.
5. Foundry verifies that the seller has an active carrier before marking shipping ready.
6. Sales Orders can compare rates and purchase labels with that workspace's seller credential.

Disconnecting removes Foundry's encrypted credential and leaves the external seller, labels, and
tracking history intact. A production webhook should target
`/webhooks/shipping/shipengine/<workspace-id>` so tracking updates can be signature-verified and
routed to the correct workspace.
