import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { add } from "./add";

describe("add", () => {
  it("returns 3 for 1+2", () => {
    assert.equal(add(1, 2), 3);
  });

  it("returns 4 for 2+2", () => {
    assert.equal(add(2, 2), 4);
  });
});
