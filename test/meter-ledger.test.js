import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerRepository } from '../src/ledger-repository.js';
import { MeterLedgerService } from '../src/meter-ledger.js';
import { readLedgerOperations } from '../src/operations.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

async function withService(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-service-'));
  const service = new MeterLedgerService(new LedgerRepository(join(directory, 'ledger.json')), options);
  try {
    await run(service, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('服务层端到端：迟到、确认、更正复核与持久化重启', async () => {
  await withService(async (service) => {
    const opening = await fixture('meter-readings.json');
    const late = await fixture('meter-readings-late.json');
    const correction = await fixture('meter-readings-correction.json');

    const first = await service.importReadings(opening);
    assert.equal(first.added, 2);
    assert.equal(first.intervals, 1);
    const replay = await service.importReadings(opening);
    assert.equal(replay.duplicates, 2);
    assert.equal(replay.affected.added.length, 0, '重复导入不影响任何区间');

    const lateResult = await service.importReadings(late);
    assert.equal(lateResult.added, 1);
    assert.deepEqual(lateResult.affected.removed, ['M1:r1->r3']);
    assert.equal((await service.listIntervals()).length, 2);

    const confirmation = await service.confirmSettlements([
      { settlementId: 'M1-2026-11-16', meterId: 'M1', readingIds: ['r1', 'r3'], value: 14 },
    ]);
    assert.equal(confirmation.confirmed, 1);
    assert.equal(confirmation.openReviews, 0);

    const corrected = await service.importReadings(correction);
    assert.equal(corrected.newVersions, 1);
    assert.equal(corrected.openReviews, 1);
    const [review] = await service.listReviews();
    assert.equal(review.delta, -2);
    const settledV1 = review.settledReadingRefs.find((ref) => ref.readingId === 'r3');
    const currentV2 = review.currentReadingRefs.find((ref) => ref.readingId === 'r3');
    assert.equal(settledV1.version, 1);
    assert.equal(currentV2.version, 2);
    assert.notEqual(settledV1.digest, currentV2.digest, '复核同时呈现旧版本与新版本证据');
    const settled = (await service.listSettlements())[0];
    assert.equal(settled.value, 14, '已确认账单保持原值');

    const trace = await service.trace('r3');
    assert.equal(trace.versions.length, 2);
    assert.equal(trace.usedBySettlements[0].readingRef.version, 1);

    const operations = await readLedgerOperations(service);
    assert.equal(operations.product, '园区电表区间台账');
    assert.equal(operations.openReviews.length, 1);
    assert.equal(operations.confirmedSettlements[0].readingRefs.length, 2);
  }, { expectedStepMinutes: 30 });
});

test('换表与倒退场景在服务层不产生负用量或零用量，缺口被标记', async () => {
  await withService(async (service) => {
    const m2 = await fixture('meter-readings-m2.json');
    await service.importReadings(m2);
    const intervals = await service.listIntervals();
    const byId = Object.fromEntries(intervals.map((interval) => [interval.id, interval]));
    assert.equal(byId['M2:s2->s3'].status, 'boundary');
    assert.equal(byId['M2:s2->s3'].usage, null);
    assert.equal(byId['M2:s4->s5'].status, 'regression');
    assert.equal(byId['M2:s4->s5'].usage, null);
    assert.equal(byId['M2:s1->s2'].usage, 10);
    assert.equal(byId['M2:s3->s4'].usage, 5);
    assert.equal(byId['M2:s2->s3'].coverage, 'gap', '跨复位且超过预期步长标记缺口');
    assert.ok(intervals.every((interval) => interval.usage === null || interval.usage > 0));
  }, { expectedStepMinutes: 45 });
});

test('重启后区间、复核与审计轨迹完整回读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-restart-'));
  try {
    const path = join(directory, 'ledger.json');
    const service = new MeterLedgerService(new LedgerRepository(path), { expectedStepMinutes: 30 });
    await service.importReadings(await fixture('meter-readings.json'));
    await service.confirmSettlements([
      { settlementId: 'M1-2026-11-16', meterId: 'M1', readingIds: ['r1', 'r3'], value: 14 },
    ]);
    await service.importReadings(await fixture('meter-readings-correction.json'));

    const reopened = new MeterLedgerService(new LedgerRepository(path), { expectedStepMinutes: 30 });
    const ledger = await reopened.readLedger();
    assert.equal(ledger.readings.r3.versions.length, 2);
    assert.equal(ledger.settlements['M1-2026-11-16'].value, 14);
    assert.equal(ledger.reviews['M1-2026-11-16'].state, 'open');
    assert.ok(ledger.audit.some((entry) => entry.type === 'review.opened'));
    assert.ok(ledger.audit.some((entry) => entry.type === 'settlement.confirm'));
    assert.ok(ledger.audit.some((entry) => entry.type === 'settlement.confirm'));
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.readings.r3.versions[0].raw.register, 114, '磁盘保留原始读数版本');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
