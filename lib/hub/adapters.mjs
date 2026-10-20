import { isIP } from 'node:net';

export class AdapterRegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'AdapterRegistryError'; this.code = code; }
}
const fail = (code, message) => { throw new AdapterRegistryError(code, message); };
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// Only reviewed source entries belong here. Device profiles and agent arguments
// cannot supply a module path, package name, install hook or executable.
const CATALOG = freeze([
  { id: 'lg-webos', name: 'LG webOS', features: ['observer', 'media'],
    installation: { kind: 'npm-peer', package: 'ws', version: '8.22.0', script: 'adapter:lg:install' } },
  { id: 'ecovacs-x11', name: 'ECOVACS X11', features: [],
    installation: { kind: 'optional-python-worker', requirements: 'optional/ecovacs/requirements.txt' } },
  { id: 'home-assistant', name: 'Home Assistant HTTPS lights', features: ['control', 'dimming'],
    installation: { kind: 'builtin', dependencies: [] } },
  { id: 'mqtt-tls', name: 'MQTT/TLS numeric sensors', features: [],
    installation: { kind: 'npm-peer', package: 'mqtt', version: '5.16.1', script: 'adapter:mqtt:install' } },
]);
const LOADERS = Object.freeze({
  'lg-webos': () => import('../adapters/lg-webos.mjs'),
  'ecovacs-x11': () => import('../adapters/ecovacs-x11.mjs'),
  'home-assistant': () => import('../adapters/home-assistant.mjs'),
  'mqtt-tls': () => import('../adapters/mqtt-tls.mjs'),
});
const CONFIG_LOADERS = Object.freeze({
  'lg-webos': () => import('../adapters/lg-config.mjs'),
  'ecovacs-x11': () => import('../adapters/ecovacs-config.mjs'),
  'home-assistant': () => import('../adapters/home-assistant-config.mjs'),
  'mqtt-tls': () => import('../adapters/mqtt-config.mjs'),
});

export function validateAdapterName(name) {
  if (typeof name !== 'string' || !Object.hasOwn(LOADERS, name)) fail('UNKNOWN_ADAPTER', 'Choose a reviewed adapter from the local catalog.');
  return name;
}
export function adapterMetadata() { return CATALOG; }
export function validateAdapterFeatures(name, features = []) {
  validateAdapterName(name);
  const allowed = CATALOG.find(item => item.id === name).features;
  if (!Array.isArray(features) || features.length > allowed.length ||
      features.some(feature => typeof feature !== 'string' || !allowed.includes(feature)) ||
      new Set(features).size !== features.length) fail('INVALID_FEATURES', 'Choose only explicit reviewed features for this adapter.');
  if (name === 'home-assistant' && features.includes('dimming') && !features.includes('control')) fail('INVALID_FEATURES', 'Dimming requires explicit light control enablement.');
  return Object.freeze([...features]);
}

// Kept dependency-free so enrollment and core startup never import a TV stack.
// Match the SSAP controller's literal private/local address boundary.
export function validatePrivateHost(host) {
  const family = typeof host === 'string' ? isIP(host) : 0;
  if (family === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254)) return host;
  } else if (family === 6 && (/^(fc|fd|fe[89ab])/i.test(host) || host === '::1')) return host;
  fail('INVALID_HOST', 'Use a literal private/local device address without a scheme or port.');
}

export async function loadAdapterConfig(name, options = {}) {
  validateAdapterName(name);
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Object.keys(options).some(key => !['configPath', 'host', 'secretStore'].includes(key)) ||
      typeof options.configPath !== 'string' || !options.configPath || options.configPath.length > 32768 || options.configPath.includes('\0')) {
    fail('INVALID_CONFIG', 'An explicit local adapter configuration file is required.');
  }
  if (name !== 'lg-webos' && options.host !== undefined) fail('INVALID_CONFIG', 'This adapter target is bound by its owner-enrolled configuration.');
  const module = await CONFIG_LOADERS[name]();
  if (name === 'lg-webos') return module.loadTVConfig(options);
  if (name === 'home-assistant') return module.loadHomeAssistantConfig(options.configPath, { secretStore: options.secretStore });
  if (name === 'mqtt-tls') return module.loadMQTTConfig(options.configPath, { secretStore: options.secretStore });
  return module.loadECOVACSConfig(options.configPath);
}

export async function createAdapter({ adapterName, id, config, features = [] } = {}) {
  validateAdapterName(adapterName);
  const selected = validateAdapterFeatures(adapterName, features);
  let module;
  try { module = await LOADERS[adapterName](); }
  catch (error) {
    if (adapterName === 'lg-webos' && error?.code === 'ERR_MODULE_NOT_FOUND' && /(?:package|module) ['"]ws['"]/.test(error.message ?? '')) {
      fail('ADAPTER_DEPENDENCY_MISSING', 'LG webOS is optional. Run npm run adapter:lg:install before enabling it.');
    }
    fail('ADAPTER_UNAVAILABLE', 'The reviewed adapter could not be loaded. Check its explicit installation requirements.');
  }
  if (adapterName === 'lg-webos') return new module.LGWebOSAdapter({ deviceId: id, config, features: selected });
  if (adapterName === 'home-assistant') return new module.HomeAssistantAdapter({ deviceId: id, config, features: selected });
  if (adapterName === 'mqtt-tls') return new module.MQTTTLSAdapter({ deviceId: id, config });
  return new module.ECOVACSX11Adapter({ deviceId: id, config });
}
