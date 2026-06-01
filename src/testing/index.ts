export { MockAdapter } from "./mock-adapter.js";
export type { MockCall, MockHandler, MockResponse } from "./mock-adapter.js";
export { Fixtures } from "./fixtures.js";
// Note: the contract test harness (`runProviderContract`) is intentionally NOT
// re-exported here. It imports `vitest` (a devDependency), so it is exposed via
// the dedicated `meridianjs/contract` subpath to keep this barrel — and the main
// entry point that re-exports it — free of test-runner dependencies at runtime.
