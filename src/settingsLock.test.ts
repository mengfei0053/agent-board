import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  _resetCliPathOverridesForTests,
  applyCliPathMemory,
  getCliPathSettings,
  planCliPathOverrides,
} from "./cliPaths.js";
import { setSettingsBarrierForTests, withSettingsLock } from "./settingsLock.js";

describe("settings lock (R2-M13)", () => {
  it("keeps both keys when two partial updates overlap", async () => {
    _resetCliPathOverridesForTests({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setSettingsBarrierForTests(gate);
    const first = withSettingsLock(async () => {
      const plan = planCliPathOverrides({ pi: "/opt/pi-a" });
      applyCliPathMemory(plan.next);
    });
    await new Promise((r) => setImmediate(r));
    const second = withSettingsLock(async () => {
      const plan = planCliPathOverrides({ claude: "/opt/claude-b" });
      applyCliPathMemory(plan.next);
    });
    release();
    await Promise.all([first, second]);
    const { cliPaths } = getCliPathSettings();
    assert.equal(cliPaths.pi.override, "/opt/pi-a");
    assert.equal(cliPaths.claude.override, "/opt/claude-b");
    setSettingsBarrierForTests(null);
    _resetCliPathOverridesForTests({});
  });
});
