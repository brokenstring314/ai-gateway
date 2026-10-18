/**
 * Parsed JSON response bodies in tests: asserted field by field with
 * expect(), so a precise type per response would add nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON in assertions
type TestJson = any;
