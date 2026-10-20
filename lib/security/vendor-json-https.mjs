// Fixed, reviewed vendor route/header policies live beside the shared transport.
// No caller-supplied cloud origin, trust override, redirect or generic HTTP tool.
export { createVendorJsonClient } from './pinned-json-https.mjs';
