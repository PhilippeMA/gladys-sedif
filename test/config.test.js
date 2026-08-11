import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig } from '../src/config.js';

test('an empty configuration falls back to the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
});

test('numbers arriving as strings from the form are coerced', () => {
  const config = normalizeConfig({ poll_frequency: '7200', history_days: '90' });
  assert.equal(config.poll_frequency, 7200);
  assert.equal(config.history_days, 90);
});

test('out-of-range numbers are clamped to the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: 5 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ poll_frequency: 999999 }).poll_frequency, 86400);
  assert.equal(normalizeConfig({ history_days: 0 }).history_days, 1);
  assert.equal(normalizeConfig({ history_days: 99999 }).history_days, 1095);
});

test('a garbage number falls back to the default instead of NaN', () => {
  assert.equal(normalizeConfig({ poll_frequency: 'soon' }).poll_frequency, 21600);
});

test('credentials are trimmed, the password is left untouched', () => {
  const config = normalizeConfig({
    email: '  user@example.com  ',
    password: '  spaces matter  ',
    contract: ' 1234567 ',
  });
  assert.equal(config.email, 'user@example.com');
  assert.equal(config.password, '  spaces matter  ');
  assert.equal(config.contract, '1234567');
});

test('only an explicit true enables the estimated readings', () => {
  assert.equal(normalizeConfig({ include_estimated: true }).include_estimated, true);
  assert.equal(normalizeConfig({ include_estimated: 'true' }).include_estimated, true);
  assert.equal(normalizeConfig({ include_estimated: 'no' }).include_estimated, false);
  assert.equal(normalizeConfig({}).include_estimated, false);
});

test('isConfigured requires both an email and a password', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(isConfigured(normalizeConfig({ email: 'a@b.c', password: 'x' })), true);
});
