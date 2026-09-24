'use strict';

/**
 * Getting a business's inventory into StockChief.
 *
 * The first question is no longer "describe your business" — that is the right
 * question for one kind of customer and the wrong one for everybody who already
 * has their inventory written down somewhere. So the first screen asks how they
 * manage it today, and each answer leads somewhere that suits it.
 */

const express = require('express');
const path = require('node:path');
const paths = require('../../onboarding/paths');
const sourceService = require('../../onboarding/source-service');
const migration = require('../../onboarding/migration-service');
const canonicalMigration = require('../../onboarding/canonical-migration');
const canonicalMapping = require('../../onboarding/canonical-mapping');
const ownerMigration = require('../../onboarding/owner-migration');
const cutoverRunner = require('../../onboarding/cutover-runner');
const preparationRunner = require('../../onboarding/preparation-runner');
const providerRegistry = require('../../connections/providers/registry');
const connections = require('../../connections/service');
const permissions = require('../../actions/permissions');
const config = require('../../config');
const exploration = require('../../onboarding/exploration');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
const databasePathFor = (db) => path.resolve(String(db && db.name || config.databasePath));
router.use('/onboarding', requireAuth);
router.use('/onboarding/migrations', requirePermission(permissions.ADMIN, 'manage a verified migration'));
router.use('/onboarding/migration-mappings', requirePermission(permissions.ADMIN, 'approve source meanings'));
router.use('/onboarding/migration-datasets', requirePermission(permissions.ADMIN, 'classify source datasets'));

router.post('/onboarding/name', requirePermission(permissions.ADMIN, 'rename this inventory'), asyncRoute(async (req, res) => {
  require('../../domain/auth-service').renameWorkspace(req.db, req.ctx, req.user, req.body.name);
  return res.redirect(303, '/onboarding');
}));

router.post('/onboarding/skip', asyncRoute(async (req, res) => {
  exploration.skip(req.db, req.ctx.workspaceId);
  return res.redirect(303, '/');
}));

router.post('/onboarding/sample/dismiss', requirePermission(permissions.ADMIN, 'dismiss sample exploration'), asyncRoute(async (req, res) => {
  exploration.dismiss(req.db, req.ctx.workspaceId);
  const destination = String(req.body.returnTo || '/');
  return res.redirect(303, /^\/(?!\/)[^\\\u0000-\u0020\u007f]*$/.test(destination) ? destination : '/');
}));

router.post('/onboarding/sample/load', requirePermission(permissions.ADMIN, 'load isolated sample data'), asyncRoute(async (req, res) => {
  try {
    req.session.workspaceId = exploration.load(req.db, req.ctx, req.user, req.account.id);
    return req.session.save(() => res.redirect(303, '/inventory'));
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error', error.message);
    return res.redirect(303, '/onboarding');
  }
}));

router.post('/onboarding/sample/clear', requirePermission(permissions.ADMIN, 'clear disposable sample data'), asyncRoute(async (req, res) => {
  const originId = exploration.clear(req.db, req.ctx, req.user, req.account.id);
  if (originId) req.session.workspaceId = originId;
  else delete req.session.workspaceId;
  req.flash('success', 'Sample inventory cleared. Your real inventory is unchanged.');
  return req.session.save(() => res.redirect(303, originId ? '/' : '/inventories'));
}));

router.get(
  '/onboarding',
  asyncRoute(async (req, res) => {
    const state = paths.ensure(req.db, req.ctx.workspaceId);
    const hasProducts = Boolean(req.db.prepare(
      'SELECT 1 FROM items WHERE workspace_id = ? AND is_active = 1 LIMIT 1'
    ).get(req.ctx.workspaceId));
    // A model can understand the kind of business without receiving a single
    // real product record. Do not call that onboarding complete and trap the
    // owner on a Home page that points only to manual item entry.
    if (state.isComplete && hasProducts && req.query.add !== '1') return res.redirect(303, '/');

    return res.page('onboarding/start', {
      title: 'Get your inventory into StockChief',
      nav: 'foundry',
      state,
      paths: paths.PATHS,
      sourceOptions: paths.SOURCE_OPTIONS,
      recommendation: null,
      recommendedOption: null,
      sourcePrompt: null,
      description: '',
      canOperate: permissions.can(req.user, permissions.OPERATE),
      suppressBack: true,
    });
  })
);

router.post(
  '/onboarding/choose',
  asyncRoute(async (req, res) => {
    const chosen = trimOrNull(req.body.path);
    const state = paths.choose(req.db, req.ctx.workspaceId, chosen, {
      chosenBy: req.body.chosenBy === 'foundry' ? 'foundry' : 'customer',
      reason: req.body.reason,
      describedAs: req.body.describedAs,
    });
    return res.redirect(303, state.step);
  })
);

// ---------------------------------------------------------------------------
// Verified provider-neutral cutovers
// ---------------------------------------------------------------------------

router.get('/onboarding/migrations', asyncRoute(async (req, res) => {
  return res.page('onboarding/migrations', {
    title: 'Migration control', nav: 'foundry',
    packages: canonicalMigration.listPackages(req.db, req.ctx.workspaceId),
  });
}));

router.get('/onboarding/migrations/new', asyncRoute(async (req,res) => {
  return res.page('onboarding/migration-new',{
    title:'Move to StockChief',nav:'foundry',types:ownerMigration.OWNER_TYPES,
  });
}));

router.post('/onboarding/migrations/new', asyncRoute(async (req,res) => {
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  const files = (req.files || []).filter((entry) => entry.field === 'files' && entry.size > 0);
  try {
    const result = ownerMigration.createFromFiles(req.db,req.ctx,req.user,{
      sourceLabel:req.body.sourceLabel,
      files,
      pasted:req.body.pasted,
    });
    preparationRunner.queue(req.db,databasePathFor(req.db),req.ctx,req.user,result.package.id);
    const location = `/onboarding/migrations/${result.package.id}/sources`;
    if (wantsJson) return res.status(201).json({ ok:true,location });
    req.flash('success','Your exports are stored as an immutable source snapshot. Confirm only the meanings StockChief cannot prove.');
    return res.redirect(303,location);
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    if (wantsJson) {
      return res.status(error.status || 400).json({
        ok:false,
        message:error.message,
        files:files.map((file) => ({ name:file.filename,size:file.size })),
      });
    }
    req.flash('error',error.message);
    return res.redirect(303,'/onboarding/migrations/new');
  }
}));

router.get('/onboarding/migrations/:id/sources', asyncRoute(async (req,res) => {
  const pkg = canonicalMigration.getPackage(req.db,req.ctx.workspaceId,req.params.id);
  if (['READY','NEEDS_ATTENTION','APPROVED','APPLYING','RECONCILING','VERIFIED','CUTOVER_ACTIVE','FAILED'].includes(pkg.status)) {
    return res.redirect(303,`/onboarding/migrations/${req.params.id}`);
  }
  const datasets = ownerMigration.listDatasets(req.db,req.ctx.workspaceId,req.params.id).map((dataset) => {
    const profile = dataset.profileId
      ? canonicalMapping.getProfile(req.db,req.ctx.workspaceId,dataset.profileId) : null;
    const unresolved = profile ? profile.mappings.filter((mapping) => mapping.disposition === 'UNRESOLVED') : [];
    const custom = profile ? profile.mappings.filter((mapping) => String(mapping.targetField || '').startsWith('attribute:')) : [];
    return { ...dataset,profile,unresolved,custom };
  });
  return res.page('onboarding/migration-sources',{
    title:'Review migration sources',nav:'foundry',
    pkg,
    datasets,
    sourceReview:ownerMigration.sourceReview(req.db,req.ctx.workspaceId,req.params.id),
    types:ownerMigration.OWNER_TYPES,
  });
}));

router.post('/onboarding/migrations/:id/prepare-known-evidence', asyncRoute(async (req,res) => {
  try {
    preparationRunner.queue(req.db,databasePathFor(req.db),req.ctx,req.user,req.params.id);
    req.flash('success','StockChief is preparing and verifying every source meaning it can prove. The progress is shown on this page.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${req.params.id}/sources`);
}));

router.post('/onboarding/migrations/:id/choose-operational-truth', asyncRoute(async (req,res) => {
  try {
    ownerMigration.decideOperationalTruth(req.db,req.ctx,req.user,req.params.id,req.body.choice);
    preparationRunner.queue(req.db,databasePathFor(req.db),req.ctx,req.user,req.params.id);
    req.flash('success','Decision saved. StockChief is now finishing preparation and verification automatically.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${req.params.id}/sources`);
}));

router.post('/onboarding/migrations/:id/reanalyze', asyncRoute(async (req,res) => {
  try {
    ownerMigration.reanalyze(req.db,req.ctx,req.user,req.params.id);
    req.flash('success','StockChief re-read every worksheet and rebuilt the plan from their structure and relationships.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${req.params.id}/sources`);
}));

router.post('/onboarding/migrations/:id/stage-ready', asyncRoute(async (req,res) => {
  try {
    preparationRunner.queue(req.db,databasePathFor(req.db),req.ctx,req.user,req.params.id);
    req.flash('success','StockChief is preparing and verifying the understood datasets automatically.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${req.params.id}/sources`);
}));

router.post('/onboarding/migration-datasets/:id/classify', asyncRoute(async (req,res) => {
  try {
    const profile = ownerMigration.attachProfile(req.db,req.ctx,req.user,req.params.id,req.body.entityType);
    return res.redirect(303,`/onboarding/migration-mappings/${profile.id}`);
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
    const dataset = ownerMigration.getDataset(req.db,req.ctx.workspaceId,req.params.id);
    return res.redirect(303,`/onboarding/migrations/${dataset.packageId}/sources`);
  }
}));

router.post('/onboarding/migration-datasets/:id/prepare-purchase-orders', asyncRoute(async (req,res) => {
  const dataset = ownerMigration.getDataset(req.db,req.ctx.workspaceId,req.params.id);
  try {
    const result = ownerMigration.preparePurchaseOrderLifecycle(req.db,req.ctx,req.user,dataset.id);
    preparationRunner.queue(req.db,databasePathFor(req.db),req.ctx,req.user,dataset.packageId);
    req.flash('success',result.replayed
      ? 'Those purchase orders were already prepared.'
      : 'Purchase orders prepared. Only verified outstanding quantities will become incoming supply; received and closed orders remain source history.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${dataset.packageId}/sources`);
}));

router.get('/onboarding/migrations/:id', asyncRoute(async (req, res) => {
  const report = canonicalMigration.report(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('onboarding/migration-report', {
    title: 'Migration reconciliation', nav: 'foundry',
    report,
    datasets: ownerMigration.listDatasets(req.db,req.ctx.workspaceId,req.params.id),
    sourceReview: ownerMigration.sourceReview(req.db,req.ctx.workspaceId,req.params.id),
  });
}));

router.get('/onboarding/migrations/:id/progress', asyncRoute(async (req,res) => {
  const report = canonicalMigration.report(req.db,req.ctx.workspaceId,req.params.id);
  const pending = report.package.status === 'APPLYING' ? req.db.prepare(`SELECT entity_type AS entityType,COUNT(*) AS count
    FROM migration_records WHERE package_id=? AND status='VALID' GROUP BY entity_type ORDER BY MIN(ordinal),entity_type LIMIT 1`)
    .get(req.params.id) : null;
  return res.json({
    status:report.package.status,
    appliedCount:report.package.appliedCount,
    stagedCount:report.package.stagedCount,
    problemCount:report.package.problemCount,
    preparationStatus:report.package.preparationStatus,
    preparationStage:report.package.preparationStage,
    preparationCompleted:report.package.preparationCompleted,
    preparationTotal:report.package.preparationTotal,
    preparationDetail:report.package.preparationDetail,
    currentEntityType:pending ? pending.entityType : null,
  });
}));

router.get('/onboarding/migration-mappings/:id', asyncRoute(async (req,res) => {
  return res.page('onboarding/migration-mapping',{
    title:'Review source meanings',nav:'foundry',profile:canonicalMapping.getProfile(req.db,req.ctx.workspaceId,req.params.id),
    fields:canonicalMapping.FIELD_CATALOG,fieldLabels:canonicalMapping.FIELD_LABELS,
  });
}));

router.post('/onboarding/migration-mappings/:id', asyncRoute(async (req,res) => {
  const profile = canonicalMapping.getProfile(req.db,req.ctx.workspaceId,req.params.id);
  const decisions = profile.mappings.filter((mapping) => mapping.disposition === 'UNRESOLVED').map((mapping) => {
    const value = trimOrNull(req.body[`field_${Buffer.from(mapping.sourceField).toString('hex')}`]);
    return { sourceField:mapping.sourceField,targetField:value === '__ignore__' ? null : value,
      disposition:value === '__ignore__' ? 'IGNORED' : 'MAPPED' };
  });
  try {
    canonicalMapping.setMappings(req.db,req.ctx,req.user,profile.id,decisions);
    canonicalMapping.approve(req.db,req.ctx,req.user,profile.id);
    const ownerStaged = ownerMigration.stageDataset(req.db,req.ctx,req.user,profile.id);
    if (ownerStaged) preparationRunner.queue(req.db,databasePathFor(req.db),req.ctx,req.user,profile.packageId);
    req.flash('success',ownerStaged
      ? 'Source meanings approved. StockChief staged every row from the exact file you reviewed.'
      : 'Source meanings approved. The connected source can now stage rows through this locked mapping.');
    return res.redirect(303,ownerStaged
      ? `/onboarding/migrations/${profile.packageId}/sources`
      : `/onboarding/migrations/${profile.packageId}`);
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
    return res.redirect(303,`/onboarding/migration-mappings/${profile.id}`);
  }
}));

function migrationAction(name, action) {
  router.post(`/onboarding/migrations/:id/${name}`, asyncRoute(async (req, res) => {
    try {
      action(req.db, req.ctx, req.user, req.params.id, req.body || {});
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      req.flash('error', error.message);
    }
    return res.redirect(303, `/onboarding/migrations/${req.params.id}`);
  }));
}

migrationAction('validate', canonicalMigration.validate);
migrationAction('start-delta', canonicalMigration.beginDeltaCapture);
migrationAction('freeze', canonicalMigration.freezeSource);
migrationAction('approve', canonicalMigration.approve);
migrationAction('apply', canonicalMigration.apply);
migrationAction('reconcile', canonicalMigration.reconcile);
migrationAction('activate', canonicalMigration.activateCutover);

router.post('/onboarding/migrations/:id/approve-and-activate', asyncRoute(async (req,res) => {
  try {
    const pkg = canonicalMigration.getPackage(req.db,req.ctx.workspaceId,req.params.id);
    if (pkg.stagedCount >= 50000) {
      canonicalMigration.beginCutover(req.db,req.ctx,req.user,req.params.id);
      const queued = cutoverRunner.queue(databasePathFor(req.db),req.ctx,req.user,req.params.id);
      req.flash('success',queued
        ? 'The verified switch is running in the background. You can keep using StockChief; completed records are saved after every batch.'
        : 'The verified switch is already running.');
      return res.redirect(303,`/onboarding/migrations/${req.params.id}`);
    }
    const result = canonicalMigration.approveAndActivate(req.db,req.ctx,req.user,req.params.id);
    req.flash(result.activated || result.replayed ? 'success' : 'error',result.activated
      ? `Switch complete. StockChief applied ${result.totalApplied} verified records and reconciled the result.`
      : result.replayed ? 'This verified switch is already active.'
        : 'StockChief applied the source but did not activate it because reconciliation did not match.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${req.params.id}`);
}));

router.post('/onboarding/migrations/:id/resolve-missing-serials', asyncRoute(async (req,res) => {
  try {
    const resolved = canonicalMigration.resolveMissingSerialEvidence(req.db,req.ctx,req.user,req.params.id,req.body.choice);
    if (resolved.package.status === 'APPROVED') {
      canonicalMigration.beginCutover(req.db,req.ctx,req.user,req.params.id);
      cutoverRunner.queue(databasePathFor(req.db),req.ctx,req.user,req.params.id);
      req.flash('success',`Decision saved. StockChief retained ${resolved.evidence.provenQuantity.toLocaleString()} proven units and resumed the verified switch.`);
    } else {
      req.flash('success','Decision saved. StockChief retained the proven quantities and the migration is ready for final approval.');
    }
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error',error.message);
  }
  return res.redirect(303,`/onboarding/migrations/${req.params.id}`);
}));

/** "Not sure — here's what's going on." */
router.post(
  '/onboarding/describe',
  asyncRoute(async (req, res) => {
    const description = trimOrNull(req.body.description) || '';
    const inferred = paths.recommendFromDescription(description);
    const recommendationResult = inferred && ['messy', 'mailbox'].includes(inferred.path)
      ? { ...inferred, path: 'spreadsheet', reason: 'you can start with an exported file and add ongoing sources later' }
      : inferred;
    const recommendedOption = recommendationResult
      ? paths.SOURCE_OPTIONS.find((option) => option.id === recommendationResult.path) || null
      : null;
    const recommendation = recommendationResult && recommendedOption
      ? { ...recommendationResult, label: recommendedOption.label }
      : null;
    const state = paths.ensure(req.db, req.ctx.workspaceId);

    return res.page('onboarding/start', {
      title: 'Get your inventory into StockChief',
      nav: 'foundry',
      state,
      paths: paths.PATHS,
      sourceOptions: paths.SOURCE_OPTIONS,
      recommendation,
      /* The chooser offers a mailbox that PATHS does not carry, so the button
         for a recommendation has to come from the list the page renders. */
      recommendedOption,
      sourcePrompt: recommendation
        ? `StockChief recommends this because ${recommendation.reason}. You can still choose any other source below.`
        : (description
          ? 'That explains the kind of business, but it does not contain the actual product names, variants, locations, or quantities. Choose where StockChief should get those real records.'
          : null),
      description,
      canOperate: permissions.can(req.user, permissions.OPERATE),
      suppressBack: true,
    });
  })
);

// Email is one supported way of supplying inventory evidence, alongside files,
// connected systems and manual entry. It belongs in onboarding, not somewhere
// a new owner has to discover in Settings.
router.get(
  ['/onboarding/mailbox', '/settings/ingestion'],
  requireAuth,
  asyncRoute(async (req, res) => {
    const connected = connections.list(req.db, req.ctx.workspaceId)
      .filter((row) => ['gmail', 'microsoft365'].includes(row.provider_type));
    return res.page('onboarding/mailbox', {
      title: 'Use inventory files from email',
      nav: 'foundry',
      state: paths.ensure(req.db, req.ctx.workspaceId),
      connected,
      providerCatalog: providerRegistry.catalog().filter((provider) =>
        ['gmail', 'microsoft365'].includes(provider.type)),
      canManageConnections: req.user.role === 'owner',
    });
  })
);

// ---------------------------------------------------------------------------
// Paths B and D — files
// ---------------------------------------------------------------------------

router.get(
  '/onboarding/files',
  asyncRoute(async (req, res) => {
    const state = paths.ensure(req.db, req.ctx.workspaceId);
    return res.page('onboarding/files', {
      title: 'Give StockChief what you have',
      nav: 'foundry',
      state,
      messy: req.query.mode === 'messy' || state.path === 'messy',
      sources: sourceService.list(req.db, req.ctx.workspaceId),
      plan: migration.latestPlan(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
      error: null,
    });
  })
);

router.post(
  '/onboarding/files',
  asyncRoute(async (req, res) => {
    const files = (req.files || []).filter((entry) => entry.field === 'files' && entry.size > 0);
    const pasted = trimOrNull(req.body.pasted);

    if (!files.length && !pasted) {
      req.flash('error', 'Choose a file, or paste your data.');
      return res.redirect(303, '/onboarding/files');
    }

    try {
      for (const file of files) {
        sourceService.addSource(req.db, req.ctx, req.user, {
          buffer: file.buffer,
          filename: file.filename,
        });
      }
      if (pasted) {
        sourceService.addSource(req.db, req.ctx, req.user, { text: pasted, filename: 'pasted data' });
      }
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/onboarding/files');
  })
);

router.post(
  '/onboarding/files/:id/remove',
  asyncRoute(async (req, res) => {
    sourceService.remove(req.db, req.ctx, req.user, req.params.id);
    return res.redirect(303, '/onboarding/files');
  })
);

/** Read everything, work out the structure, and propose a migration. */
router.post(
  '/onboarding/understand',
  asyncRoute(async (req, res) => {
    try {
      const plan = migration.buildPlan(req.db, req.ctx, req.user);
      return res.redirect(303, `/onboarding/review/${plan.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/onboarding/files');
    }
  })
);

/** What StockChief understood, and what it needs decided. */
router.get(
  '/onboarding/review/:id',
  asyncRoute(async (req, res) => {
    const plan = migration.getPlan(req.db, req.ctx.workspaceId, req.params.id);
    const conflicts = migration.conflictsFor(req.db, req.ctx.workspaceId, plan.id);
    // What the files come to once the duplicates and any settled conflicts are
    // applied, so the figure approved here is the figure that gets created.
    const correction = migration.resolvedUnits(
      plan,
      migration.decisionsFor(req.db, req.ctx.workspaceId, plan.id)
    );
    if (correction !== null && typeof plan.expectedTotals.units === 'number') {
      plan.expectedTotals = { ...plan.expectedTotals, units: plan.expectedTotals.units + correction };
    }

    return res.page('onboarding/review', {
      title: 'How StockChief would set this up',
      nav: 'foundry',
      state: paths.ensure(req.db, req.ctx.workspaceId),
      plan,
      sources: sourceService.list(req.db, req.ctx.workspaceId),
      conflicts,
      open: conflicts.filter((conflict) => !conflict.isSettled),
      blocking: conflicts.filter((conflict) => !conflict.isSettled && conflict.severity === 'blocking'),
      run: migration.latestRun(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

router.post(
  '/onboarding/conflicts/:id',
  asyncRoute(async (req, res) => {
    const conflict = migration.decide(req.db, req.ctx, req.user, req.params.id, req.body.decision);
    return res.redirect(303, `/onboarding/review/${conflict.planId}`);
  })
);

router.post(
  '/onboarding/review/:id/accept-recommendations',
  asyncRoute(async (req, res) => {
    const result = migration.acceptRecommendations(req.db, req.ctx, req.user, req.params.id);
    req.flash(
      'success',
      result.remaining
        ? `${result.accepted} settled. ${result.remaining} still need you.`
        : `${result.accepted} settled — nothing left to decide.`
    );
    return res.redirect(303, `/onboarding/review/${req.params.id}`);
  })
);

/** The takeover itself. */
router.post(
  '/onboarding/review/:id/migrate',
  asyncRoute(async (req, res) => {
    try {
      const { run } = await migration.migrate(req.db, req.ctx, req.user, req.params.id, {
        // Keyed to the plan, so a resubmitted form finishes the first migration
        // rather than building the inventory a second time.
        idempotencyKey: `migration:${req.params.id}`,
      });
      return res.redirect(303, `/onboarding/done/${run.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/onboarding/review/${req.params.id}`);
    }
  })
);

/** The takeover report. */
router.get(
  '/onboarding/done/:id',
  asyncRoute(async (req, res) => {
    const run = migration.hydrateRun(req.db, req.ctx.workspaceId, req.params.id);
    return res.page('onboarding/done', {
      title: run.verified ? 'StockChief is ready' : 'Migration needs checking',
      nav: 'foundry',
      run,
      plan: migration.getPlan(req.db, req.ctx.workspaceId, run.planId),
      sources: sourceService.list(req.db, req.ctx.workspaceId),
    });
  })
);

// ---------------------------------------------------------------------------
// Path C — another system
// ---------------------------------------------------------------------------

router.get(
  '/onboarding/system',
  asyncRoute(async (req, res) => {
    return res.page('onboarding/system', {
      title: 'Which system are you using?',
      nav: 'foundry',
      state: paths.ensure(req.db, req.ctx.workspaceId),
      connectors: connections.list(req.db, req.ctx.workspaceId),
      providerCatalog: providerRegistry.catalog().filter((provider) =>
        provider.available && ['selling', 'business'].includes(provider.category)),
      sourceOfTruth: paths.sourceOfTruth(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
      canManageConnections: req.user.role === 'owner',
    });
  })
);

router.post(
  '/onboarding/system',
  asyncRoute(async (req, res) => {
    paths.setExternalSystem(req.db, req.ctx.workspaceId, req.body.system);
    // Without a connector there is exactly one honest next step: an export.
    return res.redirect(303, '/onboarding/migrations/new');
  })
);

module.exports = router;
