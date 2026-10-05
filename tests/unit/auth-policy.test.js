'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../src/domain/auth-service');

test('account email validation accepts normal work addresses and rejects malformed addresses', () => {
  assert.equal(auth.normaliseEmail(' Owner+Ops@Example.Test '), 'owner+ops@example.test');
  for (const email of ['not-an-email', 'name@', '@example.com', 'name@example', 'name..two@example.com',
    '.name@example.com', 'name@-example.com', 'name@example..com', 'name example@example.com']) {
    assert.throws(() => auth.normaliseEmail(email), /valid email/i, email);
  }
});

test('password policy accepts passphrases and rejects short, numeric, repeated and common passwords', () => {
  assert.equal(auth.checkPasswordStrength('correct horse battery staple'), 'correct horse battery staple');
  assert.equal(auth.checkPasswordStrength('Inventory!2026'), 'Inventory!2026');
  for (const password of ['12345677', '123456789012', 'aaaaaaaaaaaa', 'Password1234', 'abcdefghijkl']) {
    assert.throws(() => auth.checkPasswordStrength(password), /password|characters|predictable|combine/i, password);
  }
});
