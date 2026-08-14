'use strict';

/**
 * DEVELOPMENT ONLY. Creates a demo workspace that has actually been through
 * the Foundry flow: a real description, a real model call, a real approved
 * plan, and real stock built on the structure Foundry configured.
 *
 * The stock below is fixture data created through the ordinary Mission 1
 * services — Foundry itself still creates nothing but configuration.
 */

const config = require('../src/config');
const { openDatabase } = require('../src/db');
const authService = require('../src/domain/auth-service');
const itemService = require('../src/domain/item-service');
const engine = require('../src/domain/inventory-engine');
const repo = require('../src/domain/repository');
const understandingService = require('../src/foundry/understanding-service');
const planBuilder = require('../src/foundry/plan-builder');
const planApplier = require('../src/foundry/plan-applier');
const reevaluate = require('../src/attention/reevaluate');

const ACCOUNT = {
  workspaceName: 'Harbour Shoe Co.',
  name: 'Robin Vale',
  email: 'robin@harbourshoe.test',
  password: 'foundry-demo-1',
};

const DESCRIPTION =
  "We wholesale children's shoes. Every style comes in colors and sizes. " +
  'We keep stock in Brooklyn and New Jersey and transfer between them.';

if (config.env === 'production' && !process.env.FOUNDRY_ALLOW_DEMO_SEED) {
  console.error('Refusing to seed demo data into a production database.');
  process.exit(1);
}
if (!config.ai.configured) {
  console.error('This demo makes a real model call. Set ANTHROPIC_API_KEY in .env first.');
  process.exit(1);
}

(async () => {
  config.ensureDataDir();
  const db = openDatabase(config.databasePath);

  const existing = db.prepare('SELECT 1 FROM accounts WHERE email = ? COLLATE NOCASE').get(ACCOUNT.email);
  if (existing) {
    console.log(`Foundry demo already present (${ACCOUNT.email}). Nothing to do.`);
    process.exit(0);
  }

  const { workspaceId, userId } = authService.registerAccount(db, ACCOUNT);
  const ctx = { workspaceId, actorId: userId };
  authService.createTeamMember(db, ctx, { role: 'owner' }, {
    name: 'Sam Okafor',
    email: 'sam@harbourshoe.test',
    password: 'foundry-demo-1',
    role: 'staff',
  });

  console.log('Asking Foundry to read the business (this is a real model call)...');
  const started = Date.now();
  const { id: understandingId, understanding } = await understandingService.describeBusiness(
    db,
    ctx,
    DESCRIPTION
  );
  console.log(`  understood in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  tracking      : ${understanding.recommendedConfiguration.trackingMode}`
    + `${understanding.recommendedConfiguration.usesVariants ? ' + variants' : ''}`);
  console.log(`  variant axes  : ${understanding.variantDimensions.map((d) => d.name).join(' → ') || '—'}`);
  console.log(`  locations     : ${understanding.likelyLocations.map((l) => l.name).join(', ')}`);
  console.log(`  questions     : ${understanding.unresolvedDecisions.length} (all delegated to Foundry below)`);

  // Accept every configuration-scoped recommendation and let Foundry decide the
  // open questions, so the demo shows both kinds of decision on record.
  const recommendations = understandingService.listRecommendations(db, workspaceId, understandingId);
  const { planId } = planBuilder.buildPlan(db, ctx, {
    understandingId,
    answers: {},
    acceptedRecommendationIds: recommendations.filter((r) => r.scope === 'configuration').map((r) => r.id),
  });
  const applied = planApplier.applyPlan(db, ctx, planId);
  console.log(`  configured    : v${applied.configurationVersion}, `
    + `locations ${applied.locationsCreated.map((l) => l.name).join(', ')}`);

  // --- Real stock, built on the structure Foundry configured -----------------
  const locations = repo.listLocations(db, workspaceId);
  const [first, second] = locations;
  const axes = applied.variantDimensions.length
    ? applied.variantDimensions
    : ['Color', 'Size'];

  const styles = [
    { name: 'Harbour Runner', code: 'HR-100', colours: 'Navy, Cream', sizes: '10, 11, 12' },
    { name: 'Tideline Sandal', code: 'TS-200', colours: 'Sand, Coral', sizes: '10, 11' },
  ];

  for (const style of styles) {
    const created = itemService.createItem(db, ctx, {
      name: style.name,
      baseCode: style.code,
      description: `${style.name} — wholesale children's footwear.`,
      unitLabel: 'pair',
      trackingMode: 'quantity',
      hasVariants: true,
      options: [
        { name: axes[0] || 'Color', values: style.colours },
        { name: axes[1] || 'Size', values: style.sizes },
      ],
    });

    const skus = repo.listSkusForItem(db, workspaceId, created.itemId);
    skus.forEach((sku, index) => {
      const quantity = 24 + index * 6;
      engine.receive(db, ctx, {
        skuId: sku.id,
        locationId: first.id,
        quantity,
        reference: `GRN-${style.code}`,
      });
    });

    // Move some of the first two variants across, and correct one count.
    if (second) {
      engine.transfer(db, ctx, {
        skuId: skus[0].id,
        fromLocationId: first.id,
        toLocationId: second.id,
        quantity: 8,
        notes: 'Filling a size gap for a buyer.',
      });
    }
    engine.issue(db, ctx, {
      skuId: skus[1].id,
      locationId: first.id,
      quantity: 5,
      reasonCode: 'sold',
      reference: 'SO-4471',
    });
    engine.adjust(db, ctx, {
      skuId: skus[2] ? skus[2].id : skus[0].id,
      locationId: first.id,
      countedQty: 30,
      reasonCode: 'physical_count',
      notes: 'Quarterly count.',
    });
  }

  // Detection runs over whatever this workspace actually has.
  const run = reevaluate.refresh(db, workspaceId, 'demo-seed');

  const integrity = engine.verifyIntegrity(db, workspaceId);
  db.close();

  console.log('\nSeeded the Foundry demo workspace.');
  console.log(`  Database : ${config.databasePath}`);
  console.log(`  Owner    : ${ACCOUNT.email} / ${ACCOUNT.password}`);
  console.log(`  Staff    : sam@harbourshoe.test / foundry-demo-1`);
  console.log(`  Attention: ${run.opened} items detected from the movement history.`);
  console.log(`  Integrity: ${integrity.ok ? 'ok' : 'PROBLEMS: ' + JSON.stringify(integrity.problems)}`);
})().catch((err) => {
  console.error('Seeding failed:', err.code || '', err.message);
  process.exit(1);
});
