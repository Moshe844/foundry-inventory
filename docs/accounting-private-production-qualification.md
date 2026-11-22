# Private production accounting qualification

Xero and QuickBooks remain excluded from public self-service activation. Saving OAuth credentials alone does not enable either provider.

The production operator can list exact inventory IDs in `STOCKCHIEF_PRODUCTION_XERO_WORKSPACES` or `STOCKCHIEF_PRODUCTION_QUICKBOOKS_WORKSPACES`. QuickBooks additionally requires `QUICKBOOKS_ENVIRONMENT=production`; sandbox credentials must not silently activate a production connection. Empty or malformed lists fail closed. These grants do not expand inventory membership, account capacity, paid-plan capabilities, or posting authority.

Consent and callbacks enforce the current inventory grant. The credential commit rechecks the grant after external provider traffic, confirms the current owner, and binds the verified company identity to the credential, app and inventory. Subscription checkout recognizes only this recorded private qualification evidence under the current configuration. An allowlist alone, stale app identity, mismatched company, or removed evidence does not certify a connection. Existing global cost and checkout controls remain in force.

Before activation, capture billing/connection preservation evidence and review provider cost exposure. Record any provisional operating budget explicitly as an estimate; it is not verified provider pricing. Do not purchase a provider plan or claim public certification from a successful fixture test. Xero's currently observed free Starter developer plan permits five organization connections. Intuit production credentials require its completed assessment and approval.

Qualify actual organization/company consent, snapshot currency and chart identity, token refresh, disconnect and reconnect separately from controlled provider fixtures. Xero initial consent remains read-only; posting needs explicit broader consent and the existing accounting reconciliation/approval workflow. QuickBooks' broader Accounting OAuth scope does not authorize a StockChief accounting posting by itself. Keep public activation closed until those checks and provider requirements are complete.
