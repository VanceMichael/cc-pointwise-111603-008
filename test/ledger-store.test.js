import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntervals,
  confirmSettlements,
  currentReadings,
  diffIntervals,
  emptyLedger,
  importReadings,
  recheckSettlements,
  resolveReview,
  traceReading,
} from '../src/ledger-store.js';

const reading = (readingId, measuredAt, register, epoch = 'e1', extra = {}) => ({
  readingId, meterId: 'M1', measuredAt, receivedAt: measuredAt, register, epoch, unit: 'kWh', ...extra,
});

function withIntervals(ledger, options = {}) {
  const intervals = buildIntervals(ledger, options);
  return { ledger, intervals };
}

test('导入保留测量时间、接收时间、原始读数与内容摘要，重复导入幂等', () => {
  const now = '2026-11-16T10:00:00Z';
  const first = importReadings(emptyLedger(), [reading('r1', '2026-11-16T08:00:00Z', 100)], { now, batchId: 'b1' });
  assert.equal(first.result.added, 1);
  const version = first.ledger.readings.r1.versions[0];
  assert.equal(version.measuredAt, '2026-11-16T08:00:00Z');
  assert.equal(version.receivedAt, '2026-11-16T08:00:00Z');
  assert.equal(version.ingestedAt, now);
  assert.equal(version.batchId, 'b1');
  assert.equal(version.raw.register, 100);
  assert.match(version.digest, /^[0-9a-f]{16}$/);

  const replay = importReadings(first.ledger, [reading('r1', '2026-11-16T08:00:00Z', 100)], { now, batchId: 'b2' });
  assert.equal(replay.result.duplicates, 1);
  assert.equal(replay.result.added, 0);
  assert.equal(replay.ledger.readings.r1.versions.length, 1, '相同内容不产生新版本');
});

test('迟到读数按测量时间归位并标记受影响区间，重复迟到导入不重复计量', () => {
  const base = importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r3', '2026-11-16T09:00:00Z', 114),
  ], { now: '2026-11-16T09:00:00Z' }).ledger;
  const before = buildIntervals(base);
  assert.deepEqual(before.map((interval) => interval.id), ['M1:r1->r3']);

  const late = importReadings(base, [{
    readingId: 'r2', meterId: 'M1', measuredAt: '2026-11-16T08:30:00Z',
    receivedAt: '2026-11-16T09:05:00Z', register: 106, epoch: 'e1', unit: 'kWh',
  }], { now: '2026-11-16T09:05:00Z' });
  const after = buildIntervals(late.ledger);
  assert.deepEqual(after.map((interval) => interval.id), ['M1:r1->r2', 'M1:r2->r3']);
  assert.deepEqual(after.map((interval) => interval.usage), [6, 8]);
  const affected = diffIntervals(before, after);
  assert.deepEqual(affected.removed, ['M1:r1->r3']);
  assert.deepEqual(affected.added.sort(), ['M1:r1->r2', 'M1:r2->r3']);

  const replay = importReadings(late.ledger, [late.ledger.readings.r2.versions[0].raw], { now: '2026-11-16T10:00:00Z' });
  assert.equal(replay.result.duplicates, 1);
  assert.equal(replay.ledger.readings.r2.versions.length, 1);
});

test('更正追加新版本且历史版本保留，区间按新版本重算', () => {
  const base = importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r3', '2026-11-16T09:00:00Z', 114),
  ], { now: '2026-11-16T09:00:00Z' }).ledger;
  const corrected = importReadings(base, [
    reading('r3', '2026-11-16T09:00:00Z', 112, 'e1', { receivedAt: '2026-11-17T02:00:00Z', correctionOf: 'r3' }),
  ], { now: '2026-11-17T02:00:00Z' });
  assert.equal(corrected.result.newVersions, 1);
  const versions = corrected.ledger.readings.r3.versions;
  assert.deepEqual(versions.map((version) => version.raw.register), [114, 112]);
  assert.equal(versions[0].raw.register, 114, '历史原始读数保留');
  const view = currentReadings(corrected.ledger);
  assert.equal(view.find((item) => item.readingId === 'r3').raw.register, 112);
  assert.equal(buildIntervals(corrected.ledger)[0].usage, 12);
});

test('换表复位产出 boundary 且 usage 为 null，不伪造零用量', () => {
  const ledger = importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100, 'e1'),
    reading('r2', '2026-11-16T09:00:00Z', 5, 'e2'),
    reading('r3', '2026-11-16T10:00:00Z', 11, 'e2'),
  ], { now: '2026-11-16T10:00:00Z' }).ledger;
  const intervals = buildIntervals(ledger);
  const boundary = intervals.find((interval) => interval.id === 'M1:r1->r2');
  assert.equal(boundary.status, 'boundary');
  assert.equal(boundary.usage, null);
  assert.match(boundary.reason, /e1 -> e2/);
  assert.equal(intervals.find((interval) => interval.id === 'M1:r2->r3').usage, 6);
  assert.ok(intervals.every((interval) => interval.usage === null || interval.usage >= 0));
});

test('同 epoch 读数倒退产出 regression 且 usage 为 null，不算负用量', () => {
  const ledger = importReadings(emptyLedger(), [
    reading('s4', '2026-11-16T11:00:00Z', 45),
    reading('s5', '2026-11-16T11:30:00Z', 44),
  ], { now: '2026-11-16T11:30:00Z' }).ledger;
  const interval = buildIntervals(ledger)[0];
  assert.equal(interval.status, 'regression');
  assert.equal(interval.usage, null);
  assert.match(interval.reason, /45 -> 44/);
});

test('读数缺口标记 coverage gap 但仍给出真实差值，不写零用量', () => {
  const ledger = importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r2', '2026-11-16T10:00:00Z', 130),
  ], { now: '2026-11-16T10:00:00Z' }).ledger;
  const flagged = buildIntervals(ledger, { expectedStepMinutes: 30 });
  assert.equal(flagged[0].coverage, 'gap');
  assert.equal(flagged[0].usage, 30, '缺口区间保留真实用量而非零');
  const unflagged = buildIntervals(ledger);
  assert.equal(unflagged[0].coverage, 'complete');
});

test('确认结算快照读数版本；更正后差异进入 open review 且确认值不变', () => {
  const now = '2026-11-16T09:30:00Z';
  let state = withIntervals(importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r2', '2026-11-16T08:30:00Z', 106),
    reading('r3', '2026-11-16T09:00:00Z', 114),
  ], { now }).ledger);
  const confirmed = confirmSettlements(state.ledger, [
    { settlementId: 'set-1', meterId: 'M1', readingIds: ['r1', 'r3'], value: 14 },
  ], { now });
  assert.equal(confirmed.result.confirmed, 1);
  assert.deepEqual(confirmed.result.errors, []);
  state = withIntervals(confirmed.ledger);
  const clean = recheckSettlements(state.ledger, state.intervals, { now });
  assert.deepEqual(clean.reviews, []);

  const corrected = importReadings(state.ledger, [
    reading('r3', '2026-11-16T09:00:00Z', 112, 'e1', { receivedAt: '2026-11-17T02:00:00Z' }),
  ], { now: '2026-11-17T02:00:00Z' });
  state = withIntervals(corrected.ledger);
  const checked = recheckSettlements(state.ledger, state.intervals, { now: '2026-11-17T02:00:00Z' });
  const review = checked.reviews[0];
  assert.equal(review.state, 'open');
  assert.equal(review.kind, 'mismatch');
  assert.equal(review.settledValue, 14);
  assert.equal(review.recomputedValue, 12);
  assert.equal(review.delta, -2);
  assert.equal(review.settledReadingRefs.find((ref) => ref.readingId === 'r3').version, 1);
  assert.equal(review.currentReadingRefs.find((ref) => ref.readingId === 'r3').version, 2);
  const settledR3 = review.settledReadingRefs.find((ref) => ref.readingId === 'r3');
  const currentR3 = review.currentReadingRefs.find((ref) => ref.readingId === 'r3');
  assert.notEqual(settledR3.digest, currentR3.digest, '复核同时保留旧版本与新版本摘要证据');
  const r1 = review.currentReadingRefs.find((ref) => ref.readingId === 'r1');
  assert.equal(r1.version, 1, '未更正的读数版本不变');
  assert.equal(checked.ledger.settlements['set-1'].value, 14, '确认账单不被静默改写');
});

test('迟到中间读数不改变已确认总量时不产生复核', () => {
  const now = '2026-11-16T09:30:00Z';
  let state = withIntervals(importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r3', '2026-11-16T09:00:00Z', 114),
  ], { now }).ledger);
  const confirmed = confirmSettlements(state.ledger, [
    { settlementId: 'set-1', meterId: 'M1', readingIds: ['r1', 'r3'], value: 14 },
  ], { now });
  const withLate = importReadings(confirmed.ledger, [
    reading('r2', '2026-11-16T08:30:00Z', 106, 'e1', { receivedAt: '2026-11-16T09:05:00Z' }),
  ], { now: '2026-11-16T09:05:00Z' });
  const intervals = buildIntervals(withLate.ledger);
  const checked = recheckSettlements(withLate.ledger, intervals, { now });
  assert.deepEqual(checked.reviews, []);
  assert.equal(intervals.reduce((sum, interval) => sum + interval.usage, 0), 14);
});

test('复核可由管理员显式裁决，再次出现差异会重新打开并保留裁决史', () => {
  const now = '2026-11-16T09:30:00Z';
  let state = withIntervals(importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r3', '2026-11-16T09:00:00Z', 114),
  ], { now }).ledger);
  state = withIntervals(confirmSettlements(state.ledger, [
    { settlementId: 'set-1', meterId: 'M1', readingIds: ['r1', 'r3'], value: 14 },
  ], { now }).ledger);
  const corrected = importReadings(state.ledger, [reading('r3', '2026-11-16T09:00:00Z', 112)], { now: '2026-11-17T02:00:00Z' });
  let checked = recheckSettlements(corrected.ledger, buildIntervals(corrected.ledger), { now: '2026-11-17T02:00:00Z' });
  const resolved = resolveReview(checked.ledger, 'set-1', 'adjust', { now: '2026-11-17T03:00:00Z', note: '补差额', by: 'admin' });
  assert.equal(resolved.review.state, 'resolved');
  assert.throws(() => resolveReview(resolved.ledger, 'set-1', 'accept'), /already resolved/);

  const again = importReadings(resolved.ledger, [reading('r3', '2026-11-16T09:00:00Z', 110)], { now: '2026-11-18T02:00:00Z' });
  checked = recheckSettlements(again.ledger, buildIntervals(again.ledger), { now: '2026-11-18T02:00:00Z' });
  const reopened = checked.ledger.reviews['set-1'];
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.history.length, 1);
  assert.equal(reopened.history[0].resolution, 'adjust');
});

test('结算引用缺失读数或跨表读数时拒绝确认', () => {
  const ledger = importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    { readingId: 'x1', meterId: 'M9', measuredAt: '2026-11-16T09:00:00Z', receivedAt: '2026-11-16T09:00:00Z', register: 1, epoch: 'e1', unit: 'kWh' },
  ], { now: '2026-11-16T09:00:00Z' }).ledger;
  const unknown = confirmSettlements(ledger, [{ settlementId: 'bad-1', meterId: 'M1', readingIds: ['r1', 'nope'], value: 1 }], {});
  assert.equal(unknown.result.rejected, 1);
  assert.match(unknown.result.errors[0].reason, /unknown reading/);
  const foreign = confirmSettlements(ledger, [{ settlementId: 'bad-2', meterId: 'M1', readingIds: ['r1', 'x1'], value: 1 }], {});
  assert.equal(foreign.result.rejected, 1);
  assert.match(foreign.result.errors[0].reason, /does not belong/);
});

test('trace 可追到读数版本、参与区间和结算使用的版本', () => {
  const now = '2026-11-16T09:30:00Z';
  let state = withIntervals(importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    reading('r3', '2026-11-16T09:00:00Z', 114),
  ], { now }).ledger);
  state = withIntervals(confirmSettlements(state.ledger, [
    { settlementId: 'set-1', meterId: 'M1', readingIds: ['r1', 'r3'], value: 14 },
  ], { now }).ledger);
  const corrected = importReadings(state.ledger, [reading('r3', '2026-11-16T09:00:00Z', 112)], { now: '2026-11-17T02:00:00Z' });
  const intervals = buildIntervals(corrected.ledger);
  const checked = recheckSettlements(corrected.ledger, intervals, { now: '2026-11-17T02:00:00Z' });
  const trace = traceReading(checked.ledger, intervals, 'r3');
  assert.deepEqual(trace.versions.map((version) => version.version), [1, 2]);
  assert.equal(trace.usedByIntervals[0].end.version, 2);
  assert.equal(trace.usedBySettlements[0].readingRef.version, 1, '结算引用的是确认时的 v1');
  assert.equal(trace.reviews[0].settlementId, 'set-1');
});

test('非法读数被拒绝且不写入台账', () => {
  const result = importReadings(emptyLedger(), [
    reading('r1', '2026-11-16T08:00:00Z', 100),
    { readingId: 'r2', meterId: 'M1', measuredAt: 'bad-date', register: 1, epoch: 'e1' },
    { readingId: 'r3', meterId: 'M1', measuredAt: '2026-11-16T09:00:00Z', register: 'no', epoch: 'e1' },
  ], { now: '2026-11-16T09:00:00Z' });
  assert.equal(result.result.added, 1);
  assert.equal(result.result.rejected, 2);
  assert.deepEqual(Object.keys(result.ledger.readings), ['r1']);
});
