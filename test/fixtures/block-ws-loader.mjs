// Test-only resolver: simulate an omitted optional LG dependency without
// changing the developer's node_modules or installing any package.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ws') {
    const error = new Error("Cannot find package 'ws' imported from the optional LG adapter.");
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}
