export class SecretStoreError extends Error {
  constructor(code = 'SECRET_STORE_FAILED') { super('The protected secret operation could not be completed.'); this.name = 'SecretStoreError'; this.code = code; }
}
