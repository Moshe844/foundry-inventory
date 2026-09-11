'use strict';

function nextStep(db, workspaceId, options = {}) {
  const mode = options.workspaceMode === 'synthetic' ? 'synthetic' : 'production';
  const itemCount = db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspaceId).n;
  const movementCount = db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspaceId).n;
  const ownerInput = options.understanding?.ownerProvidedInventory;
  const ownerLines = ownerInput?.lines || [];
  // A provider's hasRecords flag is descriptive, never authoritative. The
  // record path is available only when there is an actual grounded line to
  // review; otherwise the highest-value next step is finding the real source.
  const ownerHasRecords = ownerLines.length > 0;
  const ownerNeedsClarification = ownerHasRecords && (
    (ownerInput?.ambiguities || []).length > 0
    || ownerLines.length === 0
    || ownerLines.some((line) => !line.productName || !line.quantityKnown || !line.locationName)
  );

  const candidates = [];
  if (mode === 'production' && !options.hasDocument && ownerHasRecords) {
    candidates.push({
      kind: ownerNeedsClarification ? 'clarify_owner_records' : 'confirm_owner_records',
      informationValue: 120,
      irreversibility: 100,
      operationalRisk: 100,
      question: ownerNeedsClarification
        ? 'Confirm only the inventory details that are still unclear.'
        : 'Review the exact inventory records you gave Foundry.',
      reason: ownerNeedsClarification
        ? 'What you typed is valid business evidence. Foundry will not ask you to upload it elsewhere or guess the unclear parts.'
        : 'What you typed is enough to create these products and opening quantities after your approval.',
      deferConfigurationQuestions: true,
    });
  }
  if (mode === 'production' && !options.hasDocument && !ownerHasRecords && itemCount === 0 && movementCount === 0) {
    candidates.push({
      kind: 'source_business_records',
      informationValue: 100,
      irreversibility: 90,
      operationalRisk: 90,
      question: 'Where are your real product and stock records today?',
      reason: 'Those records can establish products, variants, locations and opening stock without Foundry inventing business facts.',
      deferConfigurationQuestions: true,
    });
  }
  candidates.push({
    kind: 'structural_configuration',
    informationValue: 30,
    irreversibility: 20,
    operationalRisk: 20,
    question: 'Which reversible structural defaults should Foundry use?',
    reason: 'These choices can usually wait until real records reveal the answer.',
    deferConfigurationQuestions: false,
  });

  return candidates.sort((a, b) => (
    b.informationValue + b.irreversibility + b.operationalRisk
    - a.informationValue - a.irreversibility - a.operationalRisk
  ))[0];
}

module.exports = { nextStep };
