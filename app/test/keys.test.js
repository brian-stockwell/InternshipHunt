// Unit tests for the posting key algorithm (spec section 9).
// The two test vectors are pre-verified; if the implementation disagrees,
// the implementation is wrong.

const test = require("node:test");
const assert = require("node:assert/strict");
const { norm, hashKey, isValidKey } = require("../state");

test("spec test vector 1: Fifth Third / Charlotte", () => {
  assert.equal(
    hashKey("Fifth Third Bank", "Wealth Management Intern - Summer 2027", ["Charlotte, NC"]),
    "hash|93a0ce5fbf6ba496"
  );
});

test("spec test vector 2: Truist / no locations", () => {
  assert.equal(
    hashKey("Truist", "Corporate Finance & FP&A Intern", []),
    "hash|29b408b874d74411"
  );
});

test("norm strips diacritics, punctuation, and extra whitespace", () => {
  assert.equal(norm("Crédit  Agricole & Co."), "credit agricole co");
  assert.equal(norm("  FP&A   Intern "), "fp a intern");
});

test("key format validation accepts both forms and rejects junk", () => {
  assert.equal(isValidKey("workday|fifththird|r123456"), true);
  assert.equal(isValidKey("hash|93a0ce5fbf6ba496"), true);
  assert.equal(isValidKey("usajobs|usajobs|823456700"), true);
  assert.equal(isValidKey("other|acme|r1"), false);       // "other" never structured
  assert.equal(isValidKey("hash|XYZ"), false);            // not 16 hex chars
  assert.equal(isValidKey("workday||r1"), false);         // empty tenant
  assert.equal(isValidKey("just a string"), false);
});
