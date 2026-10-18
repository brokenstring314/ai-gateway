import { beforeEach, describe, expect, it } from "bun:test";
import { EnvRefError, expandAnyMap, expandEnvRefs, expandStringMap, templateForm } from "../../../src/config/envref.js";

describe("expandEnvRefs", () => {
  it("resolves a single ${VAR} reference", () => {
    process.env["_ENVREF_TEST_HOME"] = "/home/user";
    try {
      expect(expandEnvRefs("${_ENVREF_TEST_HOME}")).toBe("/home/user");
    } finally {
      delete process.env["_ENVREF_TEST_HOME"];
    }
  });

  it("resolves multiple references in one string", () => {
    process.env["_ENVREF_TEST_HOST"] = "localhost";
    process.env["_ENVREF_TEST_PORT"] = "8080";
    try {
      expect(expandEnvRefs("${_ENVREF_TEST_HOST}:${_ENVREF_TEST_PORT}")).toBe("localhost:8080");
    } finally {
      delete process.env["_ENVREF_TEST_HOST"];
      delete process.env["_ENVREF_TEST_PORT"];
    }
  });

  it("preserves bare $ — $100 stays $100", () => {
    expect(expandEnvRefs("$100")).toBe("$100");
  });

  it("preserves double dollar — pa$$w0rd stays pa$$w0rd", () => {
    expect(expandEnvRefs("pa$$w0rd")).toBe("pa$$w0rd");
  });

  it("preserves bare $$ as-is", () => {
    expect(expandEnvRefs("$$")).toBe("$$");
  });

  it("returns empty string unchanged", () => {
    expect(expandEnvRefs("")).toBe("");
  });

  it("returns string with no references as-is", () => {
    expect(expandEnvRefs("hello world")).toBe("hello world");
  });

  it("throws EnvRefError for undefined variable", () => {
    // Ensure the variable does not exist
    delete process.env["_ENVREF_TEST_UNDEFINED_VAR"];
    expect(() => expandEnvRefs("${_ENVREF_TEST_UNDEFINED_VAR}")).toThrow(EnvRefError);
  });

  it("EnvRefError contains the variable name", () => {
    delete process.env["_ENVREF_TEST_MISSING_XYZ"];
    try {
      expandEnvRefs("${_ENVREF_TEST_MISSING_XYZ}");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvRefError);
      expect((err as EnvRefError).varName).toBe("_ENVREF_TEST_MISSING_XYZ");
    }
  });

  it("resolves inner braced reference in ${${VAR}} — outer braces become literal", () => {
    process.env["_ENVREF_TEST_OUTER"] = "resolved";
    try {
      // The regex matches ${_ENVREF_TEST_OUTER} inside the outer braces,
      // producing "${resolved}" — the outer braces are literal after inner expansion.
      // Go behaves the same: only ${VAR} is a reference, so the inner match resolves.
      expect(expandEnvRefs("${${_ENVREF_TEST_OUTER}}")).toBe("${resolved}");
    } finally {
      delete process.env["_ENVREF_TEST_OUTER"];
    }
  });

  it("mixes literal text with references", () => {
    process.env["_ENVREF_TEST_KEY"] = "secret123";
    try {
      expect(expandEnvRefs("Bearer ${_ENVREF_TEST_KEY}")).toBe("Bearer secret123");
    } finally {
      delete process.env["_ENVREF_TEST_KEY"];
    }
  });

  it("resolves reference with underscore and digits in name", () => {
    process.env["_ENVREF_TEST_VAR_2"] = "value";
    try {
      expect(expandEnvRefs("${_ENVREF_TEST_VAR_2}")).toBe("value");
    } finally {
      delete process.env["_ENVREF_TEST_VAR_2"];
    }
  });
});

describe("templateForm", () => {
  it("preserves ${VAR} references as-is", () => {
    expect(templateForm("${API_KEY}")).toBe("${API_KEY}");
  });

  it("returns plain strings unchanged", () => {
    expect(templateForm("hello")).toBe("hello");
  });

  it("returns empty string unchanged", () => {
    expect(templateForm("")).toBe("");
  });
});

describe("expandStringMap", () => {
  beforeEach(() => {
    process.env["_ENVREF_TEST_A"] = "alpha";
    process.env["_ENVREF_TEST_B"] = "beta";
  });

  it("expands each value in the map", () => {
    const result = expandStringMap({
      key1: "${_ENVREF_TEST_A}",
      key2: "${_ENVREF_TEST_B}",
    });
    expect(result).toEqual({ key1: "alpha", key2: "beta" });
  });

  it("preserves values without references", () => {
    const result = expandStringMap({
      key1: "${_ENVREF_TEST_A}",
      key2: "plain",
    });
    expect(result).toEqual({ key1: "alpha", key2: "plain" });
  });

  it("returns empty object for empty map", () => {
    expect(expandStringMap({})).toEqual({});
  });

  it("throws EnvRefError for undefined variable in any value", () => {
    delete process.env["_ENVREF_TEST_UNDEFINED"];
    expect(() => expandStringMap({ ok: "${_ENVREF_TEST_A}", bad: "${_ENVREF_TEST_UNDEFINED}" })).toThrow(EnvRefError);
  });
});

describe("expandAnyMap", () => {
  beforeEach(() => {
    process.env["_ENVREF_TEST_X"] = "ex";
    process.env["_ENVREF_TEST_Y"] = "why";
  });

  it("expands strings in nested objects", () => {
    const input = {
      level1: {
        key: "${_ENVREF_TEST_X}",
        plain: "text",
      },
    };
    expect(expandAnyMap(input)).toEqual({
      level1: { key: "ex", plain: "text" },
    });
  });

  it("expands strings in arrays", () => {
    const input = ["${_ENVREF_TEST_X}", "static", "${_ENVREF_TEST_Y}"];
    expect(expandAnyMap(input)).toEqual(["ex", "static", "why"]);
  });

  it("skips non-string values — numbers, booleans, null", () => {
    const input = {
      count: 42,
      flag: true,
      nothing: null,
      text: "${_ENVREF_TEST_X}",
    };
    expect(expandAnyMap(input)).toEqual({
      count: 42,
      flag: true,
      nothing: null,
      text: "ex",
    });
  });

  it("handles deeply nested structures", () => {
    const input = {
      a: {
        b: [{ c: "${_ENVREF_TEST_X}" }],
      },
    };
    expect(expandAnyMap(input)).toEqual({
      a: { b: [{ c: "ex" }] },
    });
  });

  it("returns primitives as-is", () => {
    expect(expandAnyMap(42)).toBe(42);
    expect(expandAnyMap(true)).toBe(true);
    expect(expandAnyMap(null)).toBe(null);
  });

  it("throws EnvRefError for undefined variable deep in structure", () => {
    delete process.env["_ENVREF_TEST_MISSING_DEEP"];
    const input = { nested: { key: "${_ENVREF_TEST_MISSING_DEEP}" } };
    expect(() => expandAnyMap(input)).toThrow(EnvRefError);
  });
});

describe("EnvRefError", () => {
  it("has varName property", () => {
    const err = new EnvRefError("MY_VAR");
    expect(err.varName).toBe("MY_VAR");
    expect(err.name).toBe("EnvRefError");
    expect(err.message).toContain("MY_VAR");
  });

  it("is an instance of Error", () => {
    const err = new EnvRefError("FOO");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EnvRefError);
  });
});
