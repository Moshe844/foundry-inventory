# StockChief database migration — proposed, not provisioned

The user requested the database move to AWS on November 23, 2026. The website remains on Render. No live application connection, billing configuration, customer record or AWS paid-plan setting has been changed by this preparation.

## Verified source and recovery point

- Render workspace: StockChief (`tea-damlhs3m8hqs73dk3jcg`). Source: `stockchief-production`, `dpg-dbsuq267bikc73ci5bj0-a`, Virginia, PostgreSQL 17, 1 CPU / 2 GiB RAM / 15 GB allocated storage, no standby.
- Its external database allowlist is empty. Preserve that; the migration uses Render's managed export rather than opening the source database to the internet.
- A fresh logical export was requested through the authenticated Render API. Export `dpg-dbsuq267bikc73ci5bj0-a/2026-11-23T15:15Z` is available through `backups.render.com`; its HTTPS response is 200 and the compressed archive is 49,004,757 bytes. Compressed archive size is not the physical database size. Signed links and credentials are never committed or printed.
- Render's export is a directory-format `pg_dump` archive. Restore all application schemas, including `stockchief_runtime`; do not follow a public-schema-only example for this application.

## Reviewed target

`build-template.js` generates the empty migration target. This is a database move, so its default engine major remains 17; AWS currently lists 17.11 as available in the selected Region, us-east-2. A major upgrade is separate work.

- Proposed qualification compute: **4 non-burstable vCPUs / 16 GiB RAM** (`db.m7g.xlarge`). This is a test candidate, not a certified customer capacity claim. The bounded alternative is 2 vCPUs / 8 GiB (`db.m7g.large`).
- Start the isolated rehearsal with `DeploymentPhase=qualification`. `production` enables Multi-AZ failover. Both retain seven-day backups, deletion protection, retained snapshots/resources, KMS encryption and verified TLS.
- Allocate 50 GB initially, with a reviewed storage ceiling of 100 GB. These are shared physical resources, not per-customer allocations. Product/SKU/import entitlements stay in the existing commercial configuration.
- Master credentials are generated and managed by RDS Secrets Manager. A separate generated application secret is reserved for a database-scoped role; bootstrap and permission qualification must create it before use. Runtime services must not use the RDS owner.
- The endpoint starts private. Keeping Render services in Virginia requires an explicitly approved restricted endpoint, allowing only their verified outbound CIDRs and the AWS import-task security group. The template never allows internet-wide PostgreSQL ingress. PrivateLink is an alternative, but Render's current support requires colocating the Render services in Ohio and has additional setup/cost; it is not silently substituted.
- Colocated import tasks use the VPC/client group outputs. They need no public inbound ports. A public task IP can provide outbound HTTPS while PostgreSQL traffic remains private, avoiding the old permanently billed NAT gateway design. Wiring that option into the import stack is required before activation.
- Migration evidence is private, KMS-encrypted, versioned and retained. No automatic expiry deletes a valid migration snapshot.

## Current cost quotation — November 23, 2026

Official AWS regional price-list API responses were checked for us-east-2. Estimates use 730 hours/month, on-demand pricing, no discount/credit/tax. No reserved-term purchase is proposed.

| Database compute | Single-AZ rehearsal | Multi-AZ production |
|---|---:|---:|
| 2 CPU / 8 GiB | $122.64/month | $246.01/month |
| 4 CPU / 16 GiB | $246.01/month | $492.02/month |
| 8 CPU / 32 GiB, reference only | $492.02/month | $984.04/month |

gp3 storage costs $0.115/GB-month for Single-AZ and $0.23/GB-month for Multi-AZ. At 50 GB, those are $5.75 and $11.50. At the 100 GB ceiling, production storage is $23/month.

One existing-design 1-vCPU / 2-GiB Fargate import task is approximately $36.04/month plus $3.65/month for its public IPv4. Allow up to two tasks. The database public-IP allowance is conservatively up to two IPv4 addresses ($7.30/month) when restricted Render connectivity is enabled. A KMS key is about $1/month; conservatively allow three managed secrets at $1.20/month combined. S3 storage/requests, logs, database backup overages and network transfer are additional metered usage. Existing Render web/worker fees continue; the old database remains through the verified recovery window.

For the 4-CPU option, two warm import tasks and 100 GB production storage, the modeled fixed AWS subtotal is **about $603.90/month before variable usage/tax**. It is shared across customers. The isolated Single-AZ rehearsal starts more cheaply and workers remain off until ready. The AWS project is currently FREE with $100 credit; a paid-plan upgrade and this recurring resource budget need explicit approval before creation. Budget alerts are not a hard cap.

Sources: [regional RDS catalogue](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-2/index.json), [regional Fargate catalogue](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-2/index.json), [VPC pricing](https://aws.amazon.com/vpc/pricing/), [Render exports](https://render.com/docs/postgresql-backups), [Render private links](https://render.com/docs/private-link).

Aurora Serverless is an alternative under review. Its peak and idle cost cannot be responsibly sized from row count alone; actual database CPU, connection, memory and I/O measurements are required. No Aurora capacity or cost advantage has been claimed or provisioned.

## Migration and acceptance sequence

1. Complete infrastructure syntax/security checks and obtain approval for the exact AWS service, size, paid-plan change and recurring cost. Inspect the CloudFormation change set before execution.
2. Create an empty private target, with import workers at zero. Copy the approved Render export into the private migration bucket; record its checksum, byte count and immutable object version. Keep signed source links out of logs.
3. Verify the destination identity and that it is empty. Bootstrap the scoped application role and restore the archive without destructive `--clean` options. Validate schemas, constraints, sequences, table counts, migration names, stock/cost/journal invariants and source evidence.
4. Keep restored business jobs dormant during rehearsal. Performance fixtures and their workers use an isolated qualification database containing synthetic accounts, never the copied live queue. Run the exact 150,000-row pipeline, million-row background dataset, cross-customer isolation and 50-user / 500-request-per-minute tests. Verify Render-to-AWS page latency and zero 502s.
5. Qualify the application role, TLS/CA verification, reconnect/failover behavior, leases, import interruption and replay, costing and tenant isolation. Publish results per immutable combined commit. Preserve the other chat's later release changes.
6. After acceptance, coordinate a short write pause and drain existing workers, take a fresh final export, restore and reconcile again, then switch the existing services to the verified target. Preserve session/encryption keys and all existing provider/billing settings. Do not permit old and new databases to accept independent business writes.
7. Monitor after cutover. Keep the Render source and verified backups through the agreed recovery window. Once AWS accepts new writes, never switch back to the stale source and discard those transactions; recovery must preserve new writes.

The move is **not complete** until restore, role/network qualification, hosted performance and the final cutover are verified. The prepared template does not itself move records or make the website faster.
