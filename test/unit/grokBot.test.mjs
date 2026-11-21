import assert from "node:assert/strict";
import { it } from "node:test";
import { validTeamId } from "../../web/grokBot.js";

it("accepts automatic selection or a canonical positive safe-integer string", () => {
  for (const value of ["", "1", "42", "9007199254740991"]) assert.equal(validTeamId(value), true);
  for (const value of [undefined, null, 1, "0", "01", "-1", "+1", "1.0", "1e2", "0x10", "１２", "abc", "1 ", "1\n", "9007199254740992", "1".repeat(100)]) {
    assert.equal(validTeamId(value), false, `unexpectedly accepted ${JSON.stringify(value)}`);
  }
});
