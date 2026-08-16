'use strict';

/**
 * What the paid test suites are allowed to spend.
 *
 * Preloaded with `node -r` so it runs before any test file reads config. This
 * is the only place the tests' model choice lives.
 *
 * The `deep` tier is the whole cost of a test run. It reads a paragraph about a
 * business and returns an entire inventory configuration, and on the frontier
 * model at full reasoning effort it is roughly an order of magnitude dearer
 * than anything else in the suite. A test run that re-derives four businesses
 * every time is the most expensive thing in this repository by a wide margin.
 *
 * So the suites run on Sonnet. That is not a lowering of the bar: the live
 * tests assert the *quality* of the configuration — that a rental business gets
 * serialised assets, that a bakery gets lots and expiry, that nothing
 * unavailable is promised as configured — so if Sonnet were not good enough,
 * those tests would fail rather than quietly pass on worse output. Cheap
 * defaults that hide a regression would be worse than the cost.
 *
 * Production is untouched: `src/config.js` still defaults to Opus for real
 * onboarding, which happens once per customer rather than once per test run.
 *
 * Override to check a specific model:
 *   FOUNDRY_AI_MODEL_DEEP=claude-opus-5 npm run test:live
 */

const CHEAPER_DEFAULTS = {
  FOUNDRY_AI_MODEL_DEEP: 'claude-sonnet-5',
  FOUNDRY_AI_EFFORT_DEEP: 'medium',
};

for (const [key, value] of Object.entries(CHEAPER_DEFAULTS)) {
  // Never override something the operator set on purpose.
  if (process.env[key] === undefined) process.env[key] = value;
}

module.exports = { CHEAPER_DEFAULTS };
