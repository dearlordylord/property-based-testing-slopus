import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { add } from "./add";

describe("add", () => {
  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });

  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });

  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        assert.equal(add(a, b), add(b, a));
      })
    );
  });

  it("has zero as identity on the right", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(x, 0), x);
      })
    );
  });

  it("is associative", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), fc.integer(), (x, y, z) => {
        assert.equal(add(x, add(y, z)), add(add(x, y), z));
      })
    );
  });

  it("adding 1 twice equals adding 2 once", () => {
    fc.assert(
      fc.property(fc.integer(), (x) => {
        assert.equal(add(1, add(1, x)), add(2, x));
      })
    );
  });
});
