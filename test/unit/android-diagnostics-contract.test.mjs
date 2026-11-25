import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseLogBatch } from '../../relay/src/device-logs.ts';

// A stale allowlist rejects the entire Android batch. Exercise the relay parser with every
// enum the phone serializes, without needing a Gradle build or a live relay in the JS suite.
const source = readFileSync(new URL('../../android/app/src/main/java/tech/mengfei/agentboard/data/AppDiagnostics.kt', import.meta.url), 'utf8');
function enumValues(name) {
  const block = source.match(new RegExp(`enum class ${name}\\b[^{}]*\\{([^;}]+)`));
  assert.ok(block, `missing Android enum ${name}`);
  const values = [...block[1].matchAll(/\b([A-Z][A-Z_]+)\b(?:\("(info|error)"\))?/g)].map(([, key, level]) => [key.toLowerCase(), level]);
  assert.ok(values.length, name);
  return values;
}

test('relay accepts the Android diagnostic vocabulary and legacy rows', () => {
  const base = { id: '00000000-0000-4000-8000-000000000001', ts: 1, event: 'command_failed', level: 'error' };
  const check = (extension) => {
    const row = { ...base, ...extension };
    assert.deepEqual(parseLogBatch({ entries: [row] }), [row]);
  };
  check({});
  for (const [event, level] of enumValues('DiagnosticEvent')) check({ event, level });
  for (const [op] of enumValues('DiagnosticOperation')) check({ op });
  for (const [reason] of enumValues('DiagnosticReason')) check({ reason, count: 2 });
});
