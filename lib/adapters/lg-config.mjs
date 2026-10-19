import { readJson } from '../hub/config.mjs';
import { validatePrivateHost } from '../hub/adapters.mjs';
import { resolveTVKey } from '../security/credentials.mjs';

const own = value => value && Object.getPrototypeOf(value) === Object.prototype;
const FIELDS = Object.freeze(['permissions', 'port', 'secure', 'certificatePin', 'timeoutMs', 'webOSMajor',
  'registrationManifest', 'allowTemporaryObserver', 'mediaRoots', 'allowedUrlOrigins', 'mac', 'wake']);

/** Local encrypted enrollment data, never an agent supplied device profile. */
export async function loadTVConfig({ configPath, host, secretStore } = {}) {
  const saved = await readJson(configPath);
  const devices = own(saved.devices) ? saved.devices : {};
  const selectedHost = host ?? saved.host ?? (Object.keys(devices).length === 1 ? Object.keys(devices)[0] : null);
  validatePrivateHost(selectedHost);
  const device = own(devices[selectedHost]) ? devices[selectedHost] : saved;
  const clientKey = await resolveTVKey(device, selectedHost, { secretStore });
  return { host: selectedHost, clientKey, ...Object.fromEntries(FIELDS
    .filter(key => Object.hasOwn(device, key)).map(key => [key, device[key]])) };
}
