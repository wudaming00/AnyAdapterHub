import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { adapterMetadata, createAdapter, loadAdapterConfig, validateAdapterName,
  validateAdapterFeatures, validatePrivateHost } from '../lib/hub/adapters.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const loader = new URL('./fixtures/block-ws-loader.mjs', import.meta.url).href;

test('reviewed adapter catalog is immutable and cannot supply executable extensions', () => {
  const catalog = adapterMetadata();
  assert.deepEqual(catalog.map(item => item.id), ['lg-webos', 'ecovacs-x11', 'home-assistant', 'mqtt-tls']);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog[0].features));
  assert.throws(() => catalog[0].features.push('shell'));
  for (const name of ['__proto__', 'constructor', 'file:///tmp/plugin.mjs', '../adapters/lg-webos.mjs', 'https://example.test/plugin.mjs', 'npm:unreviewed', null]) {
    assert.throws(() => validateAdapterName(name), { code: 'UNKNOWN_ADAPTER' });
  }
  assert.deepEqual(validateAdapterFeatures('lg-webos'), []);
  assert.deepEqual(validateAdapterFeatures('lg-webos', ['media']), ['media']);
  for (const features of [['media', 'media'], ['root'], ['observer', 'shell'], 'observer', null]) {
    assert.throws(() => validateAdapterFeatures('lg-webos', features), { code: 'INVALID_FEATURES' });
  }
  assert.throws(() => validateAdapterFeatures('ecovacs-x11', ['observer']), { code: 'INVALID_FEATURES' });
});

test('core literal private-host validation does not need a vendor transport', () => {
  for (const host of ['10.1.2.3', '127.0.0.1', '172.16.0.3', '172.31.0.3', '192.168.1.3', '169.254.2.3', '::1', 'fd00::3', 'fe80::1']) {
    assert.equal(validatePrivateHost(host), host);
  }
  for (const host of ['8.8.8.8', '172.32.0.3', '192.169.0.3', '2001:4860:4860::8888', 'localhost', 'http://192.168.1.3', '192.168.1.3:3000', undefined]) {
    assert.throws(() => validatePrivateHost(host), { code: 'INVALID_HOST' });
  }
});

test('invalid configuration and unknown adapter fail before opening files or importing vendors', async () => {
  await assert.rejects(loadAdapterConfig('file:///unreviewed.mjs', {}), { code: 'UNKNOWN_ADAPTER' });
  await assert.rejects(loadAdapterConfig('lg-webos', { configPath: 'not-opened', module: 'other' }), { code: 'INVALID_CONFIG' });
  await assert.rejects(loadAdapterConfig('ecovacs-x11', { configPath: 'not-opened', host: '10.0.0.2' }), { code: 'INVALID_CONFIG' });
  await assert.rejects(createAdapter({ adapterName: 'lg-webos', id: 'tv', config: {}, features: ['execute-shell'] }), { code: 'INVALID_FEATURES' });
});

test('core import and CLI help work without ws; selecting LG gives an actionable optional-dependency error', async () => {
  // Both child programs are fixed trusted test source; the resolver only blocks
  // a reviewed package name. No device, profile or agent data becomes code.
  const source = `
    import assert from 'node:assert/strict';
    const { adapterMetadata, createAdapter } = await import('./lib/hub/adapters.mjs');
    assert.equal(adapterMetadata().length, 4);
    await assert.rejects(createAdapter({adapterName:'lg-webos',id:'fixture-tv',config:{}}), {
      code:'ADAPTER_DEPENDENCY_MISSING',
      message:'LG webOS is optional. Run npm run adapter:lg:install before enabling it.'
    });
    const adapter = await createAdapter({adapterName:'ecovacs-x11',id:'fixture-vacuum',config:{
      pythonPath:'/not-executed/python',credentialFile:'/not-opened/credentials',selectedDeviceSha256:'a'.repeat(64)
    }});
    assert.equal(adapter.adapterId,'ecovacs-x11');
    await adapter.close();
    console.log('OPTIONAL_BOUNDARY_OK');
  `;
  const options = { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 };
  const probe = await run(process.execPath, ['--no-warnings', '--experimental-loader', loader, '--input-type=module', '-e', source], options);
  assert.match(probe.stdout, /OPTIONAL_BOUNDARY_OK/);
  const help = await run(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'device-hub.mjs', 'help'], options);
  assert.match(help.stdout, /AnyAdapter Hub/);
});

test('root dependency metadata requires explicit LG selection', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies?.ws, undefined);
  assert.equal(manifest.optionalDependencies?.ws, undefined);
  assert.equal(manifest.peerDependencies.ws, '8.22.0');
  assert.equal(manifest.peerDependenciesMeta.ws.optional, true);
  assert.equal(lock.packages[''].dependencies?.ws, undefined);
  assert.equal(lock.packages['node_modules/ws'], undefined);
  assert.equal(manifest.scripts['adapter:lg:install'], 'npm install --save-peer --save-exact --package-lock=false --ignore-scripts ws@8.22.0');
  assert.equal(manifest.peerDependencies.mqtt, '5.16.1');
  assert.equal(manifest.peerDependenciesMeta.mqtt.optional, true);
  assert.deepEqual(lock.packages[''].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(lock.packages[''].peerDependenciesMeta, manifest.peerDependenciesMeta);
  assert.equal(lock.packages['node_modules/mqtt'], undefined);
});
