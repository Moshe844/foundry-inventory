# Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, and can also
be dispatched manually. Both independent jobs install the locked dependencies
with `npm ci` on Ubuntu 24.04 and Node.js 22:

- **Unit and integration (Node 22)** runs the existing `npm test`, including
  product-brain validation.
- **PostgreSQL core (Node 22)** runs the 18 explicitly listed non-browser test
  files covering authentication, accounting, inventory, concurrency, migration,
  backup/restore, HTTP workflows, mail, scheduling, startup and runtime behavior.

The PostgreSQL job installs version 16 binaries from Ubuntu 24.04 packages. `tests/helpers/postgres-cluster.js` initializes a
fresh cluster with a random password and loopback port for each fixture and
removes it afterward. Tests apply their own migrations. No service database,
shared database URL, repository secret, production account or production
credential is needed. GitHub-hosted jobs run as a non-root user, as required
by `initdb`; running these fixtures as root locally is unsupported.

Actions have read-only repository permissions and do not retain checkout
credentials. Action versions are pinned to commit SHAs. New pushes cancel
superseded runs for the same branch or pull request. Job timeouts limit hangs.
There are no path filters or tolerated failures on the automatic gate.

## Broader suites

`.github/workflows/extended-tests.yml` is manual only. Once the workflow is on
the default branch, open Actions → Extended tests (manual) → Run workflow and
choose `postgres` (the complete existing `npm run test:postgres`) or `e2e`
(`npm run test:e2e`). It installs Chromium and PostgreSQL 16. The full
PostgreSQL suite includes browser cases and local release/soak checks that
are deliberately absent from the automatic core job.

These manual runs also receive no provider secrets. Tests requiring configured
models or opt-in live flags may skip; a successful run does not certify live
provider behavior. `test:live`, `test:all`, paid model probes and `certify:*`
commands are deliberately not wired into either workflow. Run those separately
in an explicitly configured test environment after reviewing their credentials,
costs and side effects. Never point fixture or certification commands at a
production database merely to enable CI.

When adding a deterministic PostgreSQL regression test, add its path to the
core job if it needs no browser, external provider or certification setup.
Validate workflow edits with `actionlint .github/workflows/*.yml`.

## Merge enforcement

Workflows report failures but do not themselves prevent merging. After the
first successful run, configure a main-branch ruleset or branch protection to
require **Unit and integration (Node 22)** and **PostgreSQL core (Node 22)**.
The manual extended workflow should not be a required merge check. Repository
Actions settings must permit the pinned checkout/setup-node actions.
