'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const rootDir = path.resolve(__dirname, '..');

// Local development keeps provider credentials in a gitignored .env file.
// Anything already in the real environment wins, so deployments do not need one.
// `process.loadEnvFile` is only present on newer Node releases. StockChief still
// runs on the Node 18 installation used by the local desktop, so keep a small
// parser here instead of silently ignoring every credential on that runtime.
function loadLocalEnvironment(envFile) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
    return;
  }
  const lines = fs.readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}
try {
  const envFile = path.join(rootDir, '.env');
  if (fs.existsSync(envFile)) loadLocalEnvironment(envFile);
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

  // Capacity is deployment policy, never a StockChief product tier. Operators
  // can size these to their reverse proxy/object-storage limits without a code
  // change; defaults comfortably cover multi-export catalogue migrations.
  uploads: {
    get maxBytes() {
      const value = Number(process.env.FOUNDRY_UPLOAD_MAX_BYTES || 512 * 1024 * 1024);
      return Number.isSafeInteger(value) && value >= 1024 * 1024 ? value : 512 * 1024 * 1024;
    },
    get maxFiles() {
      const value = Number(process.env.FOUNDRY_UPLOAD_MAX_FILES || 500);
      return Number.isSafeInteger(value) && value >= 1 ? value : 500;
    },
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
    quickbooks: {
      get clientId() { return process.env.QUICKBOOKS_CLIENT_ID || null; },
      get clientSecret() { return process.env.QUICKBOOKS_CLIENT_SECRET || null; },
      get environment() { return process.env.QUICKBOOKS_ENVIRONMENT === 'production' ? 'production' : 'sandbox'; },
      get configured() { return Boolean(this.clientId && this.clientSecret); },
    },
    xero: {
      get clientId() { return process.env.XERO_CLIENT_ID || null; },
      get clientSecret() { return process.env.XERO_CLIENT_SECRET || null; },
      get configured() { return Boolean(this.clientId && this.clientSecret); },
    },
  },

  /**
   * When StockChief looks at the inventory by itself.
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
    get storageClass() { return process.env.FOUNDRY_BACKUP_STORAGE || 'local'; },
    get retentionDays() {
      const value = Number(process.env.FOUNDRY_BACKUP_RETENTION_DAYS || 30);
      return Number.isFinite(value) && value >= 1 ? value : 30;
    },
    get intervalMs() {
      const value = Number(process.env.FOUNDRY_BACKUP_INTERVAL_MS || 24 * 60 * 60 * 1000);
      return Number.isFinite(value) && value >= 60_000 ? value : 24 * 60 * 60 * 1000;
    },
  },

  operations: {
    get processRole() {
      const role = process.env.FOUNDRY_PROCESS_ROLE || 'all';
      return ['all', 'web', 'worker'].includes(role) ? role : 'all';
    },
    get workerEnabled() { return ['all', 'worker'].includes(this.processRole); },
    get webEnabled() { return ['all', 'web'].includes(this.processRole); },
    get pollIntervalMs() {
      const value = Number(process.env.FOUNDRY_WORKER_POLL_MS || 1000);
      return Number.isFinite(value) && value >= 100 ? value : 1000;
    },
    get leaseMs() {
      const value = Number(process.env.FOUNDRY_JOB_LEASE_MS || 60_000);
      return Number.isFinite(value) && value >= 5000 ? value : 60_000;
    },
    get maxQueueLagMs() {
      const value = Number(process.env.FOUNDRY_MAX_QUEUE_LAG_MS || 5 * 60_000);
      return Number.isFinite(value) && value >= 60_000 ? value : 5 * 60_000;
    },
    get alertWebhookUrl() { return process.env.FOUNDRY_ALERT_WEBHOOK_URL || null; },
    get alertWebhookToken() { return process.env.FOUNDRY_ALERT_WEBHOOK_TOKEN || null; },
    get alertAckToken() { return process.env.FOUNDRY_ALERT_ACK_TOKEN || null; },
    get releaseRef() { return process.env.FOUNDRY_RELEASE_REF || process.env.GIT_COMMIT || 'development'; },
    get backupFreshHours() {
      const value = Number(process.env.FOUNDRY_BACKUP_FRESH_HOURS || 30);
      return Number.isFinite(value) && value > 0 ? value : 30;
    },
    get readinessCacheMs() {
      const value = Number(process.env.FOUNDRY_READINESS_CACHE_MS || 5000);
      return Number.isFinite(value) && value >= 1000 ? value : 5000;
    },
    get retentionIntervalMs() {
      const value = Number(process.env.FOUNDRY_RETENTION_INTERVAL_MS || 24 * 60 * 60 * 1000);
      return Number.isFinite(value) && value >= 60_000 ? value : 24 * 60 * 60 * 1000;
    },
    retention: {
      get deliveredMessagesDays() { return Number(process.env.FOUNDRY_RETENTION_DELIVERED_DAYS || 30); },
      get inboxDays() { return Number(process.env.FOUNDRY_RETENTION_INBOX_DAYS || 90); },
      get resolvedAlertsDays() { return Number(process.env.FOUNDRY_RETENTION_ALERT_DAYS || 365); },
      get resetTokensDays() { return Number(process.env.FOUNDRY_RETENTION_RESET_DAYS || 7); },
      get certificationDays() { return Number(process.env.FOUNDRY_RETENTION_CERTIFICATION_DAYS || 730); },
    },
  },

  sessions: {
    get anonymousMaxAgeMs() {
      const value = Number(process.env.FOUNDRY_ANONYMOUS_SESSION_MS || 60 * 60_000);
      return Number.isFinite(value) && value >= 5 * 60_000 ? value : 60 * 60_000;
    },
  },

  email: {
    get provider() { return process.env.FOUNDRY_EMAIL_PROVIDER || 'resend'; },
    get apiKey() { return process.env.RESEND_API_KEY || null; },
    get from() { return process.env.FOUNDRY_FROM_EMAIL || null; },
    get configured() { return this.provider === 'resend' && Boolean(this.apiKey && this.from); },
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
     * StockChief asks a model eight different questions, and they are not the same
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
