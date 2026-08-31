# Foundry pre-checkout decision API

`POST /api/v1/precheckout`

Authenticate with `Authorization: Bearer <connection key>`.

```json
{
  "externalLocationId": "store-1",
  "locationName": "Main Store",
  "lines": [
    { "externalSku": "provider-variant-1", "skuCode": "ABC-123", "quantity": 2 }
  ]
}
```

The response has an overall `decision` and one result per aggregated SKU:

- `ALLOW`: no current warning or blocking rule.
- `WARN`: shortage, reorder-point crossing, or an unmapped record. The checkout may continue.
- `BLOCK`: an owner-set Foundry stock-protection rule would be violated. The checkout must stop.

This endpoint is read-only. It does not reserve, commit, issue, or otherwise mutate stock. Completed sales and orders must still be sent through the normalized event API or provider webhook.

Square's standard POS and Clover's standard New Sale screen do not provide a web-connector hook for injecting this response. Use this endpoint from a custom Square checkout/Terminal app, Clover Android companion app, or another custom POS/ERP.
