import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRoundDuration } from "../../web/roundTime.js";

describe("formatRoundDuration", () => {
  it("formats sub-minute durations in seconds", () => {
    assert.equal(
      formatRoundDuration("2026-11-05T05:35:37.000Z", "2026-11-05T05:35:37.000Z"),
      "0秒",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T05:35:37.000Z", "2026-11-05T05:35:37.400Z"),
      "1秒",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T05:35:37.026Z", "2026-11-05T05:36:33.899Z"),
      "57秒",
    );
  });

  it("formats durations >= 1 minute and < 1 hour in minutes and seconds", () => {
    assert.equal(
      formatRoundDuration("2026-11-05T05:00:00.000Z", "2026-11-05T05:01:00.000Z"),
      "1分钟",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T05:33:03.415Z", "2026-11-05T05:34:41.206Z"),
      "1分钟38秒",
    );
  });

  it("formats durations >= 1 hour with hours as maximum unit", () => {
    assert.equal(
      formatRoundDuration("2026-11-05T00:00:00.000Z", "2026-11-05T01:00:00.000Z"),
      "1小时",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T00:00:00.000Z", "2026-11-05T02:05:12.000Z"),
      "2小时5分钟12秒",
    );
    assert.equal(
      formatRoundDuration("2026-11-05T00:00:00.000Z", "2026-11-06T03:00:00.000Z"),
      "27小时",
    );
  });

  it("returns empty string for invalid or inverted timestamps", () => {
    assert.equal(formatRoundDuration("", "2026-11-05T05:00:00.000Z"), "");
    assert.equal(formatRoundDuration("2026-11-05T05:00:00.000Z", ""), "");
    assert.equal(
      formatRoundDuration("2026-11-05T05:01:00.000Z", "2026-11-05T05:00:00.000Z"),
      "",
    );
  });
});
