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

const config = {
  rootDir,
  dataDir,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  databasePath: process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(dataDir, 'foundry-inventory.db'),
  get sessionSecret() {
    return resolveSessionSecret();
  },
  ensureDataDir,

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
      get deep() {
        return {
          model: process.env.FOUNDRY_AI_MODEL_DEEP || process.env.FOUNDRY_AI_MODEL || 'claude-opus-5',
          effort: process.env.FOUNDRY_AI_EFFORT_DEEP || 'high',
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
