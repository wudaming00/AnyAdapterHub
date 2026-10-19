import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../hub/config.mjs';

const fail = () => { const error = new Error('ECOVACS requires an owner configured Python executable, encrypted credential file and selected device fingerprint.'); error.code = 'INVALID_CONFIG'; throw error; };
const own = value => value && Object.getPrototypeOf(value) === Object.prototype;
export async function validateECOVACSConfig(value) {
  if (!own(value) || Object.keys(value).some(key => !['pythonPath', 'credentialFile', 'selectedDeviceSha256'].includes(key)) ||
    !/^[a-f0-9]{64}$/.test(value.selectedDeviceSha256 ?? '')) fail();
  const result = { selectedDeviceSha256: value.selectedDeviceSha256 };
  for (const key of ['pythonPath', 'credentialFile']) {
    const target = value[key];
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || /^(?:\\\\|\/\/)/.test(target)) fail();
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || (key === 'credentialFile' && (info.nlink !== 1 || info.size > 1024 * 1024))) fail();
      result[key] = await realpath(target);
    } catch { fail(); }
  }
  return Object.freeze(result);
}
export async function loadECOVACSConfig(file) { return validateECOVACSConfig(await readJson(file)); }
