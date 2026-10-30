import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionFromJsonLine } from "./sessionFromEvent.js";

describe("sessionFromJsonLine", () => {
  it("returns undefined for invalid / empty", () => {
    assert.equal(sessionFromJsonLine("nope"), undefined);
    assert.equal(sessionFromJsonLine("{}"), undefined);
  });

  it("reads session ids only from session-init events", () => {
    assert.equal(
      sessionFromJsonLine(JSON.stringify({ type: "session", id: "pi-1" })),
      "pi-1",
    );
    assert.equal(
      sessionFromJsonLine(
        JSON.stringify({ type: "thread.started", thread_id: "th-9" }),
      ),
      "th-9",
    );
    assert.equal(
      sessionFromJsonLine(
        JSON.stringify({ type: "session_meta", payload: { session_id: "roll" } }),
      ),
      "roll",
    );
    assert.equal(
      sessionFromJsonLine(
        JSON.stringify({ type: "system", subtype: "init", session_id: " s1 " }),
      ),
      "s1",
    );
    assert.equal(
      sessionFromJsonLine(JSON.stringify({ session_id: "nope" })),
      undefined,
    );
    assert.equal(
      sessionFromJsonLine(JSON.stringify({ type: "assistant", payload: { id: "evt" } })),
      undefined,
    );
    assert.equal(
      sessionFromJsonLine(JSON.stringify({ chatId: "c1" })),
      undefined,
    );
  });
});
