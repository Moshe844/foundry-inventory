# Cloudflare alert responder

StockChief production alerts are delivered to the module Worker in
`infra/cloudflare/stockchief-alert-responder.mjs`. The Worker authenticates the
StockChief webhook, sends one Resend message to the monitored responder and
requires that responder to confirm a signed acknowledgment page before it calls
StockChief's protected acknowledgment API.

Configure these Worker secrets or variables:

- `ALERT_INGEST_TOKEN`
- `ALERT_LINK_SECRET`
- `STOCKCHIEF_ACK_TOKEN`
- `STOCKCHIEF_PUBLIC_URL`
- `ALERT_RESPONDER`
- `RESEND_API_KEY`
- `FROM_EMAIL`
- `ALERT_TO_EMAIL`

Configure the shared StockChief runtime with:

- `FOUNDRY_ALERT_WEBHOOK_URL=https://<worker-domain>/ingest`
- `FOUNDRY_ALERT_WEBHOOK_TOKEN=<ALERT_INGEST_TOKEN>`
- `FOUNDRY_ALERT_ACK_TOKEN=<STOCKCHIEF_ACK_TOKEN>`

Qualification requires an alert injected from Production operations, successful
external delivery, receipt by the monitored responder and a responder click on
the signed confirmation page. The final StockChief checkpoint must be
`alert.acknowledged=PASS`; webhook acceptance alone does not qualify alerting.
