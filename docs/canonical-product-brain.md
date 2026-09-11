# Canonical website and capability brain

Mission 1 makes product existence, access, location and navigation deterministic.
Language models may explain this contract, but they do not decide it.

## Source of truth

- `src/product-brain/catalog.js` declares stable capabilities, destinations,
  user-facing entity types and compact route families.
- `src/product-brain/registry.js` registers the concrete Express route graph at
  application boot, derives each route's capability and permission contract,
  validates all references and fails startup on uncovered routes.
- `src/product-brain/navigation.js` resolves exact capability/page/record requests
  locally. Natural wording may be interpreted by a fast bounded model call, but
  the model can return only a canonical destination id. The live product brain
  then validates route existence and permission before exposing it.
- `src/product-brain/destinations.js` validates generated links and filters them
  against the current membership.

The catalogue is intentionally not a list of every URL. Express owns concrete
routes. New routes inside an existing product family inherit its contract;
introducing a new product area requires one compact family/capability
declaration. This avoids a second hand-maintained routing system.

## Registration and CI

`src/app.js` registers every mounted router with a per-application ProductBrain
and runs validation before the 404 and error handlers are installed. The
`validate:product-brain` package script provides a dedicated CI gate, and the
same validation is part of the default test script.

Validation currently covers:

- concrete user-facing and internal routes;
- capability, permission, prerequisite, authority, destination and side-effect metadata;
- destination-to-route validity;
- entity-to-capability and entity-to-route validity;
- all deterministic inventory action types.

## Access and authority

Page access is evaluated from the actual route permission when available, with
the capability permission as the declared fallback. Autonomous capability
answers additionally consult the existing autopilot mode and per-job grants.
The product brain does not replace server-side permission or authority checks;
it reads and exposes their deterministic contracts.

## Navigation contract

Foundry conversation links pass through `/foundry/navigate`. The gateway checks
that the destination is a registered local GET route, checks the current
membership, remembers the expected page and return context, redirects, and the
page renderer verifies that the requested destination was actually reached.

The natural-language interpretation step is limited to eight seconds and is
abortable. A provider timeout or failure produces no guessed route. Clear page
names stay on the local fast path, while full-sentence context prevents a stray
word such as “people” from incorrectly opening People/Settings.

Needs You items use the same destination validation. An item with an unknown
or non-actionable route fails loudly in development/tests rather than sending a
customer to an irrelevant page. Items inaccessible to the current role are not
exposed.

## Migrated consumers

- The manager capability planner now reads the product brain through a small
  compatibility adapter.
- Foundry onboarding and Ask prompts receive generated availability truth;
  stale prompt prose no longer decides whether forecasting exists.
- Guidance screen descriptions and core destination links derive from the
  canonical capability/destination contract.
- Needs You, Ask handoffs and manager navigation use the shared destination
  contract.
- Page arrival and return navigation use one verified flow.

## Intentional boundaries

The existing action, permission and autopilot services remain the execution
authorities. The product brain references them instead of duplicating their
rules. Replacing those domain services would expand this mission into later
work and weaken, rather than improve, the current safety boundaries.
