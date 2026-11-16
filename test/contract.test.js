import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('late meter observation and confirmed settlement use distinct evidence', async () => {
  const late = (await observe('updated')).records[0].attributes;
  assert.ok(late.measuredAt < late.receivedAt);
  assert.equal(late.epoch, 'installed-1');
  const settlements = await fixture('settlements');
  assert.equal(settlements[0].state, 'confirmed');
  assert.deepEqual(settlements[0].readingIds, ['r1', 'r3']);
  assert.equal(settlements[0].value, 14);
});
