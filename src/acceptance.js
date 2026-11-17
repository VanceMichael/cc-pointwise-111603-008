import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { LedgerRepository } from './ledger-repository.js';
import { MeterLedgerService } from './meter-ledger.js';
import { readOperations } from './operations.js';

const fixture = (name) => new URL(`../fixtures/${name}.json`, import.meta.url);
const source = await startSource(fixture('source'));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // 区间台账验收：迟到回补、重复导入幂等、结算保护、更正复核、版本可追溯
  const ledgerPath = join(directory, 'ledger.json');
  const load = () => new MeterLedgerService(new LedgerRepository(ledgerPath), { expectedStepMinutes: 30 });
  const opening = JSON.parse(await readFile(fixture('meter-readings'), 'utf8'));
  const late = JSON.parse(await readFile(fixture('meter-readings-late'), 'utf8'));
  const correction = JSON.parse(await readFile(fixture('meter-readings-correction'), 'utf8'));
  const epoch = JSON.parse(await readFile(fixture('meter-readings-epoch'), 'utf8'));

  const initial = await load().importReadings(opening);
  assert.equal(initial.added, 2);
  assert.equal((await load().listIntervals())[0].usage, 14);
  const replay = await load().importReadings(opening);
  assert.deepEqual([replay.added, replay.duplicates], [0, 2], '重复导入不重复计量');

  const lateImport = await load().importReadings(late);
  assert.deepEqual(lateImport.affected.added.sort(), ['M1:r1->r2', 'M1:r2->r3']);
  assert.ok(lateImport.affected.removed.includes('M1:r1->r3'), '迟到中间读数分裂原区间');
  const split = await load().listIntervals();
  assert.equal(split.map((interval) => interval.usage).reduce((sum, usage) => sum + usage, 0), 14);

  await load().confirmSettlements([
    { settlementId: 'M1-2026-11-16', meterId: 'M1', interval: '08:00/09:00', readingIds: ['r1', 'r3'], value: 14 },
  ]);
  assert.deepEqual((await load().listReviews()).map((review) => review.state), [], '一致的结算不产生复核');
  const corrected = await load().importReadings(correction);
  assert.equal(corrected.newVersions, 1, '更正追加读数版本而非覆盖');
  const reviews = await load().listReviews();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].state, 'open');
  assert.equal(reviews[0].settledValue, 14);
  assert.equal(reviews[0].recomputedValue, 12);
  assert.equal(reviews[0].delta, -2, '已确认结算的差异显式呈现且账单未被改写');
  const settled = (await load().listSettlements())[0];
  assert.equal(settled.value, 14);
  assert.equal(settled.readingRefs.find((ref) => ref.readingId === 'r3').version, 1, '结算保留当时使用的读数版本');

  const resolved = await load().resolveReview('M1-2026-11-16', 'adjust', { note: '按更正后读数补开差额账单', by: 'admin' });
  assert.equal(resolved.state, 'resolved');
  assert.equal((await load().listReviews()).filter((review) => review.state === 'open').length, 0);

  const trace = await load().trace('r3');
  assert.deepEqual(trace.versions.map((version) => version.version), [1, 2]);
  assert.deepEqual(trace.versions.map((version) => version.raw.register), [114, 112]);
  assert.equal(trace.usedBySettlements[0].readingRef.version, 1, '可追溯结算实际使用过的读数版本');

  // 换表/复位与读数倒退不得产出负用量或零用量
  const anomaly = await load().importReadings(epoch);
  assert.equal(anomaly.rejected, 0);
  const withEpoch = await load().listIntervals();
  const boundary = withEpoch.find((interval) => interval.status === 'boundary');
  assert.equal(boundary.usage, null);
  assert.match(boundary.reason, /installed-1 -> installed-2/);
  assert.ok(withEpoch.every((interval) => interval.usage === null || interval.usage >= 0));

  // 重启后状态完整回读
  const reopenedLedger = await new MeterLedgerService(new LedgerRepository(ledgerPath), { expectedStepMinutes: 30 }).readLedger();
  assert.equal(reopenedLedger.settlements['M1-2026-11-16'].value, 14);
  assert.equal(reopenedLedger.readings.r3.versions.length, 2);
  assert.ok(reopenedLedger.audit.some((entry) => entry.type === 'review.resolved'));

  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayStored: second.stored,
    operationRows: operations.rows.length, ledgerIntervals: reopenedLedger.intervals.length,
    reviews: reopenedLedger.reviews ? Object.keys(reopenedLedger.reviews).length : 0, status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
