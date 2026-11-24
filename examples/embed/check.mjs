/**
 * Package-consumer check.
 *
 * Imports only the public entry point, resolves it through the package's
 * `exports` map, and exercises the parts of the API that do not need a DOM
 * (configuration, camera, presets, seed helpers). Run it after `npm install`:
 *
 *   npm run check
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const nebula = await import('nebula');

assert.equal(typeof nebula.Nebula, 'function', 'Nebula class is exported');
assert.equal(typeof nebula.NebulaError, 'function', 'NebulaError is exported');
assert.equal(nebula.CONFIG_VERSION, 1, 'configuration version is exported');
assert.equal(typeof nebula.defaultConfig, 'function');

const config = nebula.defaultConfig();
assert.equal(config.format, 'nebula-config');
assert.equal(config.seed, nebula.DEFAULT_PARAMETERS.seed);
assert.ok(config.camera);
assert.equal(config.camera.position, null, 'default camera uses the built-in orbit');

const roundTrip = nebula.parseConfig(nebula.serializeConfig(config));
assert.deepEqual(roundTrip, config, 'configuration round-trips through JSON');

const legacy = nebula.parseConfig(nebula.serializeParameters({ ...nebula.DEFAULT_PARAMETERS, seed: 4242 }));
assert.equal(legacy.seed, 4242, 'legacy parameter exports still import');

const wide = nebula.cameraPreset('wide');
assert.ok(wide?.position, 'wide camera preset resolves');
assert.notDeepEqual(wide.position, nebula.CAMERA_PRESETS.default.position);

assert.equal(nebula.normalizeSeed(-4), 4, 'seed normalization is exported');
assert.ok(nebula.PRESETS.length >= 6, 'presets are exported');

// The CJS bundle must resolve through the same package entry.
const require = createRequire(import.meta.url);
const cjs = require('nebula');
assert.equal(typeof cjs.Nebula, 'function', 'CJS require works');
assert.equal(cjs.Nebula.name, 'Nebula');
assert.equal(cjs.CONFIG_VERSION, 1);

console.log('nebula package check: PASS');
console.log(`  ESM module: ${config.format} v${config.version}`);
console.log(`  CJS export: ${typeof cjs.Nebula}`);
console.log(`  presets: ${nebula.PRESETS.length}`);
