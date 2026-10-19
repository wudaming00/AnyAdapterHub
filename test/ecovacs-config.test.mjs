import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateECOVACSConfig, loadECOVACSConfig } from '../lib/adapters/ecovacs-config.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'anyadapter-ecovacs-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pythonPath = path.join(directory, 'python.exe'); const credentialFile = path.join(directory, 'credentials.bin');
  await writeFile(pythonPath, 'fake executable used only for file checks'); await writeFile(credentialFile, 'encrypted fixture');
  return { directory, config: { pythonPath, credentialFile, selectedDeviceSha256: 'a'.repeat(64) } };
}

test('owner ECOVACS config accepts exactly one executable, encrypted file and selected-device fingerprint', async t => {
  const { directory, config } = await fixture(t);
  const file = path.join(directory, 'config.json'); await writeFile(file, JSON.stringify(config));
  assert.deepEqual(await loadECOVACSConfig(file), { ...config, pythonPath: await realpath(config.pythonPath), credentialFile: await realpath(config.credentialFile) });
  assert.equal(Object.isFrozen(await validateECOVACSConfig(config)), true);
  for (const extra of [{ deviceId: 'other' }, { args: ['-c', 'execute'] }, { region: 'CN' }, { endpoint: 'https://attacker' }])
    await assert.rejects(validateECOVACSConfig({ ...config, ...extra }), { code: 'INVALID_CONFIG' });
});

test('ECOVACS owner config rejects missing binding, command text, URLs, directories and absent files', async t => {
  const { directory, config } = await fixture(t);
  for (const change of [{ selectedDeviceSha256: undefined }, { selectedDeviceSha256: 'A'.repeat(64) },
    { pythonPath: config.pythonPath + ' -c malicious' }, { pythonPath: 'python' }, { credentialFile: 'https://attacker/token' },
    { credentialFile: directory }, { credentialFile: path.join(directory, 'absent.bin') }])
    await assert.rejects(validateECOVACSConfig({ ...config, ...change }), { code: 'INVALID_CONFIG' });
});

test('ECOVACS encrypted credential file cannot be replaced with a symlink', { skip: process.platform === 'win32' ? 'Creating symlinks requires Windows elevation.' : false }, async t => {
  const { directory, config } = await fixture(t);
  const link = path.join(directory, 'linked.bin'); await symlink(config.credentialFile, link);
  await assert.rejects(validateECOVACSConfig({ ...config, credentialFile: link }), { code: 'INVALID_CONFIG' });
});
