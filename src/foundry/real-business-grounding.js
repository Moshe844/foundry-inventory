'use strict';

/*
 * A model may propose structure, but in a real-business workspace only words
 * grounded in the owner's description may become named business data. This is
 * deliberately deterministic and runs after model interpretation.
 */

const GENERIC_LOCATION_WORDS = new Set([
  'location', 'locations', 'store', 'stores', 'shop', 'shops', 'warehouse',
  'warehouses', 'office', 'offices', 'site', 'sites', 'branch', 'branches',
  'storage', 'main', 'primary', 'central', 'current',
]);

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function containsPhrase(source, value) {
  const haystack = ` ${normalise(source)} `;
  const needle = normalise(value);
  return Boolean(needle) && haystack.includes(` ${needle} `);
}

function locationIsGrounded(description, name) {
  const nameTokens = normalise(name).split(' ').filter(Boolean);
  // A phrase such as "kept in a storage location" proves that location
  // tracking is needed; it does not prove that a place is literally named
  // "Storage Location". Generic descriptors may shape the structure but may
  // never become production business records.
  if (nameTokens.length && nameTokens.every((token) => GENERIC_LOCATION_WORDS.has(token))) {
    const phrase = nameTokens.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = normalise(description);
    // "at Main Warehouse" in a stock statement identifies the place the
    // owner used. "a main warehouse" or "a storage location" only describes
    // a type of place. Articles are the deterministic boundary between those
    // two claims.
    return new RegExp(`\\b(?:at|in|from|to|into)\\s+(?!a\\s|an\\s|the\\s)${phrase}\\b`, 'i').test(source);
  }
  if (containsPhrase(description, name)) return true;
  const sourceTokens = new Set(normalise(description).split(' ').filter(Boolean));
  const distinctive = normalise(name).split(' ')
    .filter((token) => token && !GENERIC_LOCATION_WORDS.has(token));
  return distinctive.length > 0 && distinctive.every((token) => sourceTokens.has(token));
}

function axisIsGrounded(description, name) {
  const root = normalise(name).replace(/s$/, '');
  const words = new Set(normalise(description).split(' ').map((word) => word.replace(/s$/, '')));
  return Boolean(root) && words.has(root);
}

function unique(lines) {
  return [...new Set(lines.filter(Boolean))];
}

function tokensAreGrounded(description, value) {
  if (!value) return true;
  if (containsPhrase(description, value)) return true;
  const sourceTokens = new Set(normalise(description).split(' ').filter(Boolean));
  return normalise(value).split(' ').filter(Boolean).every((token) => sourceTokens.has(token));
}

function quantityAppears(description, quantity) {
  const escaped = String(quantity).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\D)${escaped}(?=\\D|$)`).test(String(description || ''));
}

function ground(understanding, description) {
  const ownerInput = understanding.ownerProvidedInventory || { hasRecords: false, lines: [], ambiguities: [] };
  const ownerAmbiguities = [...(ownerInput.ambiguities || [])];
  const ownerLines = (ownerInput.lines || []).filter((line) => {
    if (!tokensAreGrounded(description, line.productName)) {
      ownerAmbiguities.push(`Foundry discarded an unsupported product name (${line.productName || 'blank'}) instead of inventing it.`);
      return false;
    }
    if (!tokensAreGrounded(description, line.variantLabel)) {
      ownerAmbiguities.push(`Confirm the variant for ${line.productName}; the proposed value was not in your description.`);
      line.variantLabel = '';
    }
    if (line.locationName && !locationIsGrounded(description, line.locationName)) {
      ownerAmbiguities.push(`Confirm where ${line.productName} is physically located.`);
      line.locationName = '';
    }
    if (line.quantityKnown && (!Number.isInteger(line.quantity) || line.quantity < 0 || !quantityAppears(description, line.quantity))) {
      ownerAmbiguities.push(`Confirm the quantity for ${line.productName}${line.variantLabel ? ` / ${line.variantLabel}` : ''}.`);
      line.quantity = 0;
      line.quantityKnown = false;
    }
    if (line.sourceText && !containsPhrase(description, line.sourceText)) line.sourceText = '';
    return Boolean(line.productName);
  });
  understanding.ownerProvidedInventory = {
    // The model's summary boolean is not evidence. A business description can
    // be mislabelled as "has records" while containing no product/quantity
    // line at all; ambiguities about that absence are not records either.
    // Only grounded record lines may select the owner-record confirmation path.
    hasRecords: ownerLines.length > 0,
    lines: ownerLines,
    ambiguities: unique(ownerAmbiguities),
  };

  const droppedLocations = [];
  understanding.likelyLocations = (understanding.likelyLocations || []).filter((location) => {
    const supported = locationIsGrounded(description, location.name);
    if (!supported) droppedLocations.push(location.name);
    if (supported) location.certainty = 'verified_fact';
    return supported;
  });

  const droppedAxes = [];
  understanding.variantDimensions = (understanding.variantDimensions || []).filter((dimension) => {
    const supported = axisIsGrounded(description, dimension.name);
    if (!supported) droppedAxes.push(dimension.name);
    if (!supported) return false;
    dimension.exampleValues = (dimension.exampleValues || [])
      .filter((value) => containsPhrase(description, value));
    return true;
  });

  if (!understanding.variantDimensions.length) {
    understanding.recommendedConfiguration.usesVariants = false;
  }

  understanding.productStructure.certainty = 'safe_structural_inference';
  understanding.locationModel.certainty = 'safe_structural_inference';
  for (const flag of [understanding.serializedTracking, understanding.lotTracking, understanding.expirationTracking]) {
    flag.certainty = flag.applies ? 'safe_structural_inference' : 'provisional_default';
  }

  const axes = understanding.variantDimensions.map((dimension) => dimension.name);
  understanding.recommendedConfiguration.summary = axes.length
    ? `Foundry can support ${axes.join(', ')} variants. Their actual values will come from your records.`
    : 'Foundry can safely start with quantity tracking. Real products and stock will come from your records.';
  understanding.locationModel.summary = understanding.locationModel.multipleLocations
    ? 'Your description supports multiple-location tracking. Actual location names and the exact count will come from your records.'
    : 'Foundry can track stock by location once the real location records are supplied.';
  understanding.receivingWorkflow = 'Foundry will record receiving against real products, locations and source documents.';
  understanding.transferWorkflow = 'Transfers will be available between verified locations once their real names are supplied.';
  understanding.adjustmentWorkflow = 'Count corrections will require a reason and remain traceable.';

  const suppliedExamples = (understanding.inventoryExamples || [])
    .filter((example) => containsPhrase(description, example));
  understanding.inventoryExamples = suppliedExamples;

  understanding.factClassification = {
    verifiedFacts: unique([
      suppliedExamples.length ? `Product types named by you: ${suppliedExamples.join(', ')}.` : '',
      ownerLines.length ? `${ownerLines.length} product or variant record${ownerLines.length === 1 ? '' : 's'} came directly from what you typed.` : '',
      understanding.likelyLocations.length
        ? `Locations named in your description: ${understanding.likelyLocations.map((location) => location.name).join(', ')}.`
        : '',
    ]),
    safeStructuralInferences: unique([
      axes.length ? `Products need variant support for ${axes.join(', ')}.` : '',
      understanding.locationModel.multipleLocations ? 'The business needs multiple-location inventory support.' : '',
    ]),
    provisionalDefaults: unique([
      !understanding.serializedTracking.applies ? 'Serial tracking stays off until real evidence requires it.' : '',
      !understanding.lotTracking.applies ? 'Lot tracking stays off until real evidence requires it.' : '',
      !understanding.recommendedConfiguration.allowNegativeStock ? 'Negative stock stays disabled; this can be changed later.' : '',
    ]),
    missingBusinessFacts: unique([
      !understanding.ownerProvidedInventory.hasRecords
        ? 'The real product, SKU, quantity and opening-stock records.' : '',
      ownerLines.some((line) => !line.quantityKnown) ? 'One or more typed inventory quantities still need confirmation.' : '',
      ownerLines.some((line) => !line.locationName) ? 'The physical location for one or more typed stock quantities.' : '',
      ...ownerAmbiguities,
      understanding.locationModel.multipleLocations
        ? 'The real names and exact number of stores or other locations.' : '',
      axes.length && axes.some((axis) => {
        const dimension = understanding.variantDimensions.find((entry) => entry.name === axis);
        return !dimension || !dimension.exampleValues.length;
      }) ? `The actual ${axes.join(', ')} values used by your products.` : '',
      droppedLocations.length ? 'Model-suggested location names were discarded because you did not provide them.' : '',
      droppedAxes.length ? 'Model-suggested variant axes were discarded because you did not provide them.' : '',
    ]),
    authorityDecisions: ['No authority to purchase, message suppliers, move stock or change financial records is granted by onboarding.'],
  };

  return understanding;
}

module.exports = { ground, containsPhrase, locationIsGrounded, axisIsGrounded };
