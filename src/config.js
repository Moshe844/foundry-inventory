'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const rootDir = path.resolve(__dirname, '..');

// Local development keeps provider credentials in a gitignored .env file.
// Anything already in the real environment wins, so deployments do not need one.
try {
  const envFile = path.join(rootDir, '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  }
} catch {
  /* A malformed .env must not stop the server from booting. */
}
const dataDir = process.env.FOUNDRY_DATA_DIR
  ? path.resolve(process.env.FOUNDRY_DATA_DIR)
  : path.join(rootDir, 'data');

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * The session secret is generated once and persisted so that restarting the
 * server does not sign every existing user out.
 */
function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  ensureDataDir();
  const secretPath = path.join(dataDir, 'session-secret');
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function resolveConnectionEncryptionKey() {
  if (process.env.FOUNDRY_CONNECTION_ENCRYPTION_KEY) {
    return crypto.createHash('sha256').update(process.env.FOUNDRY_CONNECTION_ENCRYPTION_KEY).digest();
  }
  ensureDataDir();
  const secretPath = path.join(dataDir, 'connection-encryption-key');
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath);
    if (existing.length === 32) return existing;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, key, { mode: 0o600 });
  return key;
}

const config = {
  rootDir,
  dataDir,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  get supportEmail() { return process.env.FOUNDRY_SUPPORT_EMAIL || null; },
  databasePath: process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(dataDir, 'foundry-inventory.db'),
  get sessionSecret() {
    return resolveSessionSecret();
  },
  ensureDataDir,
  get connectionEncryptionKey() {
    return resolveConnectionEncryptionKey();
  },

  connections: {
    get publicOrigin() { return process.env.FOUNDRY_PUBLIC_URL || null; },
    shopify: {
      get clientId() { return process.env.SHOPIFY_CLIENT_ID || null; },
      get clientSecret() { return process.env.SHOPIFY_CLIENT_SECRET || null; },
      get configured() { return Boolean(this.clientId && this.clientSecret); },
    },
    square: {
      get applicationId() { return process.env.SQUARE_APPLICATION_ID || null; },
      get applicationSecret() { return process.env.SQUARE_APPLICATION_SECRET || null; },
      get sandboxAccessToken() { return process.env.SQUARE_SANDBOX_ACCESS_TOKEN || null; },
      get environment() { return process.env.SQUARE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'; },
      get webhookSignatureKey() { return process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || null; },
      get configured() {
        return Boolean(this.applicationId && (this.applicationSecret
          || (this.environment === 'sandbox' && this.sandboxAccessToken)));
      },
    },
    clover: {
      get clientId() { return process.env.CLOVER_CLIENT_ID || null; },
      get clientSecret() { return process.env.CLOVER_CLIENT_SECRET || null; },
      get webhookAuthCode() { return process.env.CLOVER_WEBHOOK_AUTH_CODE || null; },
      get environment() { return process.env.CLOVER_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'; },
      get configured() { return Boolean(this.clientId && this.clientSecret && this.webhookAuthCode); },
    },
    gmail: {
      get clientId() { return process.env.GMAIL_CLIENT_ID || null; },
      get clientSecret() { return process.env.GMAIL_CLIENT_SECRET || null; },
      get pubsubTopic() { return process.env.GMAIL_PUBSUB_TOPIC || null; },
      get pubsubVerificationToken() { return process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN || null; },
      get configured() { return Boolean(this.clientId && this.clientSecret); },
    },
    microsoft365: {
      get clientId() { return process.env.MICROSOFT365_CLIENT_ID || null; },
      get clientSecret() { return process.env.MICROSOFT365_CLIENT_SECRET || null; },
      get tenant() { return process.env.MICROSOFT365_TENANT || 'common'; },
      get configured() { return Boolean(this.clientId && this.clientSecret); },
    },
  },

  /**
   * When Foundry looks at the inventory by itself.
   *
   * Off under test, always: a suite that starts a real server and then asserts
   * "nothing happened yet" cannot be trusted if a timer might act in between.
   * The loop it runs is the same one the Check now button runs, so turning this
   * off costs timing and nothing else.
   */
  autopilot: {
    get enabled() {
      if (process.env.FOUNDRY_AUTOPILOT_SCHEDULER !== undefined) {
        return process.env.FOUNDRY_AUTOPILOT_SCHEDULER === 'true';
      }
      return (process.env.NODE_ENV || 'development') !== 'test';
    },
    get intervalMs() {
      const configured = Number(process.env.FOUNDRY_AUTOPILOT_INTERVAL_MS);
      // A minute is the floor. Below that the per-minute plan key would collapse
      // consecutive ticks into one and the extra runs would be silently wasted.
      return Number.isFinite(configured) && configured >= 60000 ? configured : 15 * 60 * 1000;
    },
  },

  backups: {
    get enabled() {
      if (process.env.FOUNDRY_BACKUPS_ENABLED !== undefined) {
        return process.env.FOUNDRY_BACKUPS_ENABLED === 'true';
      }
      return (process.env.NODE_ENV || 'development') === 'production';
    },
    get directory() {
      return process.env.FOUNDRY_BACKUP_DIR
        ? path.resolve(process.env.FOUNDRY_BACKUP_DIR)
        : path.join(dataDir, 'backups');
    },
    get retentionDays() {
      const value = Number(process.env.FOUNDRY_BACKUP_RETENTION_DAYS || 30);
      return Number.isFinite(value) && value >= 1 ? value : 30;
    },
    get intervalMs() {
      const value = Number(process.env.FOUNDRY_BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);
      return Number.isFinite(value) && value >= 60_000 ? value : 24 * 60 * 60 * 1000;
    },
  },

  /**
   * The intelligence layer. Provider and model are environment driven so the
   * engine is never tied to one vendor, and no secret ever reaches the browser.
   */
  ai: {
    get provider() {
      return process.env.FOUNDRY_AI_PROVIDER || 'anthropic';
    },
    get model() {
      return process.env.FOUNDRY_AI_MODEL || 'claude-opus-5';
    },
    get apiKey() {
      return process.env.ANTHROPIC_API_KEY || null;
    },
    get effort() {
      return process.env.FOUNDRY_AI_EFFORT || 'high';
    },
    get maxTokens() {
      return Number(process.env.FOUNDRY_AI_MAX_TOKENS || 16000);
    },
    get configured() {
      return Boolean(process.env.ANTHROPIC_API_KEY);
    },

    /**
     * What each kind of thinking costs.
     *
     * Foundry asks a model eight different questions, and they are not the same
     * size of question. Reading a paragraph about a business and designing an
     * inventory model for it is genuinely hard. Deciding whether a spreadsheet
     * column headed "LABST" holds quantities is not, and paying frontier-model
     * reasoning rates for it is simply waste.
     *
     * Each call site names the tier it needs rather than a model, so the tiers
     * can be retuned — or pointed at another vendor entirely — from the
     * environment without touching a single service.
     */
    tiers: {
      // One paragraph in, an entire inventory configuration out.
      //
      // Measured on the same description: Opus at high effort took 87 seconds,
      // Sonnet at medium took 35, and both returned the identical configuration
      // — quantity tracking, two variant axes, the same values. The whole live
      // suite asserts the *quality* of this output (a rental business gets
      // serialised assets, a food distributor gets lots and expiry, an
      // ambiguous description gets an honest question rather than an invented
      // structure) and passes on Sonnet, so the cheaper model is not a
      // concession — it is the same answer, sooner.
      //
      // Somebody is watching a progress screen while this runs. A minute of
      // extra thinking that changes nothing is not free, whatever it costs.
      get deep() {
        return {
          model: process.env.FOUNDRY_AI_MODEL_DEEP || process.env.FOUNDRY_AI_MODEL || 'claude-sonnet-5',
          effort: process.env.FOUNDRY_AI_EFFORT_DEEP || 'medium',
        };
      },
      // Conversation and judgement where a wrong answer is visible but cheap.
      get standard() {
        return {
          model: process.env.FOUNDRY_AI_MODEL_STANDARD || 'claude-sonnet-5',
          effort: process.env.FOUNDRY_AI_EFFORT_STANDARD || 'medium',
        };
      },
      // Bounded extraction and classification, every one of which is verified
      // deterministically afterwards. Small model, little reasoning.
      get fast() {
        return {
          model: process.env.FOUNDRY_AI_MODEL_FAST || 'claude-haiku-4-5-20251001',
          // 'none' turns extended thinking off entirely. These calls are
          // pattern recognition against a fixed schema, and every answer is
          // checked deterministically afterwards, so reasoning tokens buy
          // nothing here.
          effort: process.env.FOUNDRY_AI_EFFORT_FAST || 'none',
        };
      },
    },

    /** The settings for a named tier, falling back to the global defaults. */
    tier(name) {
      const chosen = this.tiers[name];
      if (!chosen) return { model: this.model, effort: this.effort };
      return chosen;
    },
  },
};

module.exports = config;
