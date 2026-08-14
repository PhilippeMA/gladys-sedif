// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor which defaults the code
// assumes — these tests keep the two in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DEVICE_BLUEPRINTS } from '../src/devices/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('every manifest action has a registered handler', () => {
  const handled = new Set(DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {})));
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('every handler is declared in the manifest, or its button never appears', () => {
  const declared = new Set((manifest.actions ?? []).map((a) => a.key));
  for (const blueprint of DEVICE_BLUEPRINTS) {
    for (const key of Object.keys(blueprint.actions ?? {})) {
      assert.ok(declared.has(key), `handler "${key}" is missing from the manifest`);
    }
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every value field of the manifest is known to the code', () => {
  for (const field of manifest.config_schema) {
    if (field.type === 'section') {
      continue;
    }
    assert.ok(field.key in DEFAULT_CONFIG, `config field "${field.key}" is unknown to config.js`);
  }
});

test('the password is a secret field, never a plain string', () => {
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.equal(password.type, 'secret');
  // NOT required: the dropped-file source needs no account, and a required
  // field would keep those users from ever saving the form. `isConfigured()`
  // is what decides, per source.
  assert.notEqual(password.required, true);
  // `secret` fields are never sent back to the frontend, so they cannot carry
  // a default — the manifest is rejected otherwise.
  assert.equal(password.default, undefined);
});

test('the source select offers exactly the two the code implements', () => {
  const source = manifest.config_schema.find((f) => f.key === 'source');
  assert.deepEqual(
    source.options.map((o) => o.value),
    ['portal', 'file'],
  );
  assert.equal(source.default, DEFAULT_CONFIG.source);
});

test('the numeric bounds of the manifest match the clamping done in config.js', () => {
  const bounds = Object.fromEntries(
    manifest.config_schema.filter((f) => f.type === 'number').map((f) => [f.key, f]),
  );
  assert.deepEqual(
    { min: bounds.poll_frequency.min, max: bounds.poll_frequency.max },
    { min: 3600, max: 86400 },
  );
  assert.deepEqual(
    { min: bounds.history_days.min, max: bounds.history_days.max },
    { min: 1, max: 1095 },
  );
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(!(section.key in DEFAULT_CONFIG), `section "${section.key}" stores no value`);
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest respects the store constraints checked by the indexer', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, 'name is 3-30 characters');
  assert.ok(manifest.description.en, 'the English description is mandatory');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `the ${lang} description must be 10-100 characters, got ${text.length}`,
    );
  }
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version must be strict semver');
  assert.match(manifest.docker_image, /:[\w.-]+$/, 'the image needs an explicit tag');
  assert.match(manifest.cover_image, /^https:\/\//);
  for (const field of manifest.config_schema) {
    assert.match(field.key, /^[a-z0-9_]+$/, `invalid config key "${field.key}"`);
  }
  for (const action of manifest.actions ?? []) {
    assert.match(action.key, /^[a-z0-9_]+$/, `invalid action key "${action.key}"`);
    assert.ok(
      action.timeout_seconds >= 5 && action.timeout_seconds <= 120,
      `action "${action.key}": timeout_seconds must be 5-120`,
    );
  }
});

test('the declared image version matches the manifest version', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, manifest.version, 'package.json and the manifest must agree');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'docker_image must be tagged with the manifest version',
  );
});

test('the cover image ships in the repo and respects the store limits', async () => {
  // The indexer only WARNS on a bad cover and silently swaps in a placeholder,
  // so nothing downstream would tell us the catalog card is broken.
  const name = path.basename(new URL(manifest.cover_image).pathname);
  const cover = await readFile(new URL(`../${name}`, import.meta.url));

  assert.ok(
    manifest.cover_image.endsWith(`/main/${name}`),
    'the cover must be served from the default branch, where the indexer looks',
  );
  assert.ok(cover.length <= 150 * 1024, `cover is ${Math.round(cover.length / 1024)} KB, max 150`);

  // JPEG: walk the segments to the frame header carrying the dimensions.
  assert.equal(cover.readUInt16BE(0), 0xffd8, 'expected a JPEG cover');
  let offset = 2;
  let size = null;
  while (offset < cover.length - 8 && size === null) {
    if (cover[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = cover[offset + 1];
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrameHeader) {
      size = { height: cover.readUInt16BE(offset + 5), width: cover.readUInt16BE(offset + 7) };
    } else {
      offset += 2 + cover.readUInt16BE(offset + 2);
    }
  }
  assert.deepEqual(size, { width: 800, height: 534 }, 'the cover must be exactly 800x534');
});

test('a browser action gets the long ack the portal needs', () => {
  // Signing in and rendering a Lightning page takes far more than the 5 s of a
  // regular command: an action that forgets its timeout always fails.
  for (const action of manifest.actions) {
    assert.ok(
      action.timeout_seconds >= 60,
      `action "${action.key}" drives a browser session and needs at least 60 s`,
    );
  }
});
