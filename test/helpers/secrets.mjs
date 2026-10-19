import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSecretStore } from '../../lib/security/secret-store.mjs';
import { createHubIdentityManager } from '../../lib/security/hub-identity.mjs';

// Portable, explicitly injected test provider. It never becomes a production
// credential provider, and its random key exists only inside this test process.
export function testSecretStore() {
  const key = randomBytes(32);
  return createSecretStore({ provider: 'test-aes-gcm',
    async protect(clear, entropy) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(entropy);
      return Buffer.concat([iv, cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    },
    async unprotect(bytes, entropy) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(entropy); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  });
}

const identities = new WeakMap();
// A real, process-local self-signed identity keeps certificate validation active
// in portable configuration/ACL tests. No private fixture key is stored on disk.
export async function testIdentity(secretStore) {
  if (!identities.has(secretStore)) identities.set(secretStore, createHubIdentityManager(secretStore).createHubIdentity());
  return identities.get(secretStore);
}
