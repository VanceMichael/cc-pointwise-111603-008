import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../src/cli.js');
const ledgerState = resolve(here, '../var/ledger.json');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('帮助同时列出旧命令与台账命令', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  const help = JSON.parse(result.stdout);
  assert.deepEqual(help.commands, ['ingest', 'query']);
  for (const command of ['ledger-import', 'intervals', 'reviews', 'settlements', 'confirm', 'resolve', 'trace']) {
    assert.ok(help.ledgerCommands.includes(command));
    assert.ok(help.usage.includes(command));
  }
});

test('台账 CLI 完整链路：导入、重复幂等、确认保护、更正复核与追溯', async () => {
  await rm(ledgerState, { force: true });
  try {
    const imported = run(['ledger-import', 'fixtures/meter-readings.json']);
    assert.equal(imported.status, 0, imported.stderr);
    const first = JSON.parse(imported.stdout);
    assert.equal(first.added, 2);

    const replay = JSON.parse(run(['ledger-import', 'fixtures/meter-readings.json']).stdout);
    assert.equal(replay.duplicates, 2);
    assert.equal(replay.added, 0);

    const intervals = JSON.parse(run(['intervals']).stdout);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].usage, 14);

    const confirmed = JSON.parse(run(['confirm', 'fixtures/settlements.json']).stdout);
    assert.equal(confirmed.confirmed, 1);
    assert.equal(confirmed.openReviews, 0);

    const corrected = JSON.parse(run(['ledger-import', 'fixtures/meter-readings-correction.json']).stdout);
    assert.equal(corrected.openReviews, 1);

    const reviews = JSON.parse(run(['reviews']).stdout);
    assert.equal(reviews[0].state, 'open');
    assert.equal(reviews[0].delta, -2);
    const settlements = JSON.parse(run(['settlements']).stdout);
    assert.equal(settlements[0].value, 14, 'CLI 下确认账单同样不被改写');

    const trace = JSON.parse(run(['trace', 'r3']).stdout);
    assert.deepEqual(trace.versions.map((version) => version.version), [1, 2]);
    assert.equal(trace.usedBySettlements[0].readingRef.version, 1);

    const resolved = JSON.parse(run(['resolve', '08:00/09:00', 'adjust', '管理员裁决补差额']).stdout);
    assert.equal(resolved.state, 'resolved');
    assert.equal(JSON.parse(run(['reviews']).stdout).filter((review) => review.state === 'open').length, 0);
  } finally {
    await rm(ledgerState, { force: true });
  }
});

test('缺少参数的台账命令明确失败', () => {
  assert.equal(run(['resolve']).status, 1);
  assert.match(run(['resolve']).stderr, /resolve needs/);
  assert.equal(run(['trace']).status, 1);
  assert.match(run(['trace']).stderr, /trace needs/);
});
