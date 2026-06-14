import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { add } from "./add";

describe("add", () => {
  it("throws for any input", () => {
    assert.throws(() => add(1, 2), /Not implemented/);
  });
});
