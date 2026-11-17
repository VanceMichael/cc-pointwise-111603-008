import { createHash, randomUUID } from 'node:crypto';

// 区间台账纯函数模块：读数版本、区间推导、结算复核全部在这里。
// 不做任何文件或网络 I/O，状态对象结构即磁盘格式，由 repository 负责持久化。

export function emptyLedger() {
  return {
    readings: {},          // readingId -> { readingId, meterId, versions: [] }
    intervals: [],         // 从当前读数版本推导出的区间（可随时重建）
    settlements: {},       // settlementId -> 已确认结算快照
    reviews: {},           // settlementId -> 当前复核差异（open/resolved）
    audit: [],             // 追加式审计轨迹
  };
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function digestReading(raw) {
  return createHash('sha256').update(canonicalize(raw)).digest('hex').slice(0, 16);
}

const rawFields = ['readingId', 'meterId', 'measuredAt', 'receivedAt', 'register', 'epoch', 'unit'];

export function readingFromRaw(raw) {
  const reading = {};
  for (const field of rawFields) reading[field] = raw[field] ?? null;
  // 保留任何额外来源属性（例如 correctionOf），原始读数不丢字段
  for (const [field, value] of Object.entries(raw)) {
    if (!(field in reading)) reading[field] = structuredClone(value);
  }
  return reading;
}

function validateRaw(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('meter reading must be an object');
  }
  for (const field of ['readingId', 'meterId', 'measuredAt', 'register', 'epoch']) {
    if (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === '') {
      throw new Error(`missing ${field} for meter reading`);
    }
  }
  if (!Number.isFinite(Date.parse(raw.measuredAt))) {
    throw new Error(`invalid measuredAt for reading ${raw.readingId}`);
  }
  if (raw.receivedAt !== undefined && raw.receivedAt !== null && !Number.isFinite(Date.parse(raw.receivedAt))) {
    throw new Error(`invalid receivedAt for reading ${raw.readingId}`);
  }
  if (typeof raw.register !== 'number' || !Number.isFinite(raw.register)) {
    throw new Error(`register must be a finite number for reading ${raw.readingId}`);
  }
}

function appendAudit(ledger, entry) {
  ledger.audit.push({ id: randomUUID(), at: entry.at, type: entry.type, detail: entry.detail });
}

// 导入一批来源读数：重复内容去重，更正追加新版本，绝不覆盖历史版本。
export function importReadings(ledger, rawItems, options = {}) {
  if (!Array.isArray(rawItems)) throw new TypeError('import input must be an array');
  const now = options.now ?? new Date().toISOString();
  const batchId = options.batchId ?? `batch-${Date.parse(now)}-${randomUUID().slice(0, 8)}`;
  const next = structuredClone(ledger);
  next.audit = ledger.audit.map((entry) => structuredClone(entry));
  const result = { batchId, receivedAt: now, received: rawItems.length, added: 0, newVersions: 0, duplicates: 0, rejected: 0, errors: [] };

  rawItems.forEach((raw, index) => {
    try {
      validateRaw(raw);
    } catch (error) {
      result.rejected += 1;
      result.errors.push({ index, readingId: raw?.readingId ?? null, reason: error.message });
      return;
    }
    const readingId = String(raw.readingId);
    const meterId = String(raw.meterId);
    const rawReading = readingFromRaw(raw);
    const versionDigest = digestReading(rawReading);
    const entry = next.readings[readingId];
    if (entry && entry.versions.some((version) => version.digest === versionDigest)) {
      // 同一读数内容重复导入：不产生新版本、不重复计量
      result.duplicates += 1;
      return;
    }
    if (!entry) next.readings[readingId] = { readingId, meterId, versions: [] };
    const previousVersion = next.readings[readingId].versions.length;
    next.readings[readingId].versions.push({
      version: previousVersion + 1,
      digest: versionDigest,
      measuredAt: rawReading.measuredAt,
      receivedAt: rawReading.receivedAt ?? null,
      ingestedAt: now,
      batchId,
      raw: rawReading,
    });
    result.added += 1;
    if (previousVersion > 0) result.newVersions += 1;
  });

  if (result.added > 0 || result.duplicates > 0) {
    appendAudit(next, {
      at: now,
      type: 'import',
      detail: {
        batchId,
        added: result.added,
        newVersions: result.newVersions,
        duplicates: result.duplicates,
        rejected: result.rejected,
      },
    });
  }
  return { ledger: next, result };
}

// 每个读数取其最新版本作为当前视图（历史版本仍完整保留）。
export function currentReadings(ledger) {
  return Object.values(ledger.readings)
    .map((entry) => {
      const latest = entry.versions[entry.versions.length - 1];
      return { readingId: entry.readingId, meterId: entry.meterId, ...latest };
    })
    .sort((left, right) => {
      const byTime = Date.parse(left.measuredAt) - Date.parse(right.measuredAt);
      return byTime !== 0 ? byTime : left.readingId.localeCompare(right.readingId);
    });
}

function intervalId(interval) {
  const endpoint = interval.start ? interval.start.readingId : 'start';
  return `${interval.meterId}:${endpoint}->${interval.end.readingId}`;
}

// 从当前读数推导区间台账。
// 换表/复位（epoch 变化）=> boundary，usage 为 null，绝不产出零用量；
// 同 epoch 读数倒退 => regression，usage 为 null，绝不产出负用量；
// 时间跨度超出 expectedStepMinutes => coverage: gap（真实差值照算，但提示缺口）。
export function buildIntervals(ledger, options = {}) {
  const stepMinutes = options.expectedStepMinutes ?? null;
  const readings = currentReadings(ledger);
  const meterIds = [...new Set(readings.map((reading) => reading.meterId))].sort();
  const intervals = [];

  for (const meterId of meterIds) {
    const series = readings.filter((reading) => reading.meterId === meterId);
    for (let index = 1; index < series.length; index += 1) {
      const start = series[index - 1];
      const end = series[index];
      const base = {
        meterId,
        start: { readingId: start.readingId, version: start.version, measuredAt: start.measuredAt, register: start.raw.register },
        end: { readingId: end.readingId, version: end.version, measuredAt: end.measuredAt, register: end.raw.register },
        unit: end.raw.unit ?? start.raw.unit ?? null,
      };
      const spanMinutes = (Date.parse(end.measuredAt) - Date.parse(start.measuredAt)) / 60000;
      const gap = stepMinutes !== null && spanMinutes > stepMinutes;
      if (start.raw.epoch !== end.raw.epoch) {
        intervals.push({ ...base, id: intervalId(base), status: 'boundary', usage: null, coverage: gap ? 'gap' : 'complete', reason: `epoch ${start.raw.epoch} -> ${end.raw.epoch}` });
      } else if (end.raw.register < start.raw.register) {
        intervals.push({ ...base, id: intervalId(base), status: 'regression', usage: null, coverage: gap ? 'gap' : 'complete', reason: `register ${start.raw.register} -> ${end.raw.register}` });
      } else {
        intervals.push({ ...base, id: intervalId(base), status: 'computed', usage: end.raw.register - start.raw.register, coverage: gap ? 'gap' : 'complete' });
      }
    }
  }
  return intervals.sort((left, right) => {
    const byMeter = left.meterId.localeCompare(right.meterId);
    if (byMeter !== 0) return byMeter;
    const byTime = Date.parse(left.end.measuredAt) - Date.parse(right.end.measuredAt);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

// 标记两次区间推导之间受影响的区间（迟到中间读数会让相邻区间分裂/改写）。
export function diffIntervals(before, after) {
  const beforeById = new Map(before.map((interval) => [interval.id, interval]));
  const afterById = new Map(after.map((interval) => [interval.id, interval]));
  const added = after.filter((interval) => !beforeById.has(interval.id)).map((interval) => interval.id);
  const removed = before.filter((interval) => !afterById.has(interval.id)).map((interval) => interval.id);
  const changed = after.filter((interval) => {
    const previous = beforeById.get(interval.id);
    return previous && digestInterval(previous) !== digestInterval(interval);
  }).map((interval) => interval.id);
  return { added, removed, changed };
}

export function digestInterval(interval) {
  return createHash('sha256').update(canonicalize(interval)).digest('hex').slice(0, 16);
}

function versionRef(ledger, readingId) {
  const entry = ledger.readings[readingId];
  if (!entry) return null;
  const latest = entry.versions[entry.versions.length - 1];
  return { readingId, version: latest.version, digest: latest.digest, measuredAt: latest.measuredAt, register: latest.raw.register };
}

// 确认一批结算：快照当时使用的读数版本，已确认结算不可重复确认。
export function confirmSettlements(ledger, settlements, options = {}) {
  if (!Array.isArray(settlements)) throw new TypeError('settlements must be an array');
  const now = options.now ?? new Date().toISOString();
  const next = structuredClone(ledger);
  next.audit = ledger.audit.map((entry) => structuredClone(entry));
  const result = { confirmed: 0, rejected: 0, errors: [], settlementIds: [] };

  for (const [index, item] of settlements.entries()) {
    try {
      if (!item || typeof item !== 'object') throw new Error('settlement must be an object');
      const settlementId = String(item.settlementId ?? item.interval ?? '').trim();
      if (!settlementId) throw new Error('missing settlementId or interval');
      if (next.settlements[settlementId]) throw new Error(`settlement ${settlementId} already confirmed`);
      const meterId = String(item.meterId ?? '').trim();
      if (!meterId) throw new Error('missing meterId');
      const readingIds = item.readingIds ?? item.readingRefs?.map((ref) => ref.readingId);
      if (!Array.isArray(readingIds) || readingIds.length < 2) throw new Error('readingIds must contain at least two readings');
      const refs = [];
      for (const readingId of readingIds.map(String)) {
        const ref = versionRef(next, readingId);
        if (!ref) throw new Error(`unknown reading ${readingId}`);
        if (ref.measuredAt && next.readings[readingId].meterId !== meterId) {
          throw new Error(`reading ${readingId} does not belong to meter ${meterId}`);
        }
        refs.push(ref);
      }
      if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
        throw new Error(`settlement ${settlementId} needs a numeric confirmed value`);
      }
      const snapshot = {
        settlementId,
        meterId,
        state: 'confirmed',
        confirmedAt: item.confirmedAt ?? now,
        value: item.value,
        readingIds: refs.map((ref) => ref.readingId),
        readingRefs: refs,
        source: item.source ?? null,
      };
      next.settlements[settlementId] = snapshot;
      result.confirmed += 1;
      result.settlementIds.push(settlementId);
      appendAudit(next, { at: now, type: 'settlement.confirm', detail: { settlementId, meterId, value: snapshot.value, readingRefs: refs } });
    } catch (error) {
      result.rejected += 1;
      result.errors.push({ index, settlementId: settlements[index]?.settlementId ?? settlements[index]?.interval ?? null, reason: error.message });
    }
  }
  return { ledger: next, result };
}

function evaluateSettlement(ledger, intervals, snapshot) {
  const refs = snapshot.readingIds.map((readingId) => versionRef(ledger, readingId)).filter(Boolean);
  if (refs.length !== snapshot.readingIds.length) {
    return { status: 'missing', recomputed: null, reason: 'settled reading no longer present' };
  }
  const ordered = [...refs].sort((left, right) => {
    const byTime = Date.parse(left.measuredAt) - Date.parse(right.measuredAt);
    return byTime !== 0 ? byTime : left.readingId.localeCompare(right.readingId);
  });
  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  // 结算覆盖的时间窗：窗内同表区间全部纳入重算（迟到中间读数会把原区间分裂为多段）。
  const startMs = Date.parse(first.measuredAt);
  const endMs = Date.parse(last.measuredAt);
  const windowIntervals = intervals.filter((interval) => {
    if (interval.meterId !== snapshot.meterId) return false;
    const begin = Date.parse(interval.start.measuredAt);
    const finish = Date.parse(interval.end.measuredAt);
    return begin >= startMs && finish <= endMs;
  });
  if (!windowIntervals.length) {
    return { status: 'missing', recomputed: null, reason: 'no computable interval chain covers the settled readings' };
  }
  // 窗内出现换表/复位或读数倒退：无法形成可信数字，交给管理员处理，绝不硬算。
  const nonComputed = windowIntervals.find((interval) => interval.status !== 'computed');
  if (nonComputed) {
    return {
      status: nonComputed.status,
      recomputed: null,
      reason: nonComputed.reason ?? `interval ${nonComputed.id} is ${nonComputed.status}`,
      intervals: windowIntervals.map((interval) => interval.id),
    };
  }
  const gaps = windowIntervals.filter((interval) => interval.coverage === 'gap').map((interval) => interval.id);
  const recomputed = windowIntervals.reduce((sum, interval) => sum + interval.usage, 0);
  const basis = windowIntervals.length === 1 && directEndpoints(windowIntervals[0], first, last) ? 'direct' : 'split';
  return {
    status: recomputed === snapshot.value ? 'matches' : 'mismatch',
    recomputed,
    basis,
    gaps,
    intervals: windowIntervals.map((interval) => interval.id),
    currentRefs: ordered.map((ref) => ({ readingId: ref.readingId, version: ref.version, digest: ref.digest })),
  };
}

function directEndpoints(interval, first, last) {
  return interval.start.readingId === first.readingId && interval.end.readingId === last.readingId;
}

// 按当前读数重新核对所有已确认结算：差异进入 reviews，绝不静默改写确认值。
export function recheckSettlements(ledger, intervals, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const next = structuredClone(ledger);
  next.audit = ledger.audit.map((entry) => structuredClone(entry));
  const reviews = [];

  for (const snapshot of Object.values(ledger.settlements)) {
    const evaluation = evaluateSettlement(ledger, intervals, snapshot);
    const existing = ledger.reviews[snapshot.settlementId];
    if (evaluation.status === 'matches') {
      if (existing) {
        delete next.reviews[snapshot.settlementId];
        appendAudit(next, { at: now, type: 'review.cleared', detail: { settlementId: snapshot.settlementId } });
      }
      continue;
    }
    const review = {
      settlementId: snapshot.settlementId,
      meterId: snapshot.meterId,
      state: 'open',
      detectedAt: existing?.state === 'resolved' ? now : (existing?.detectedAt ?? now),
      settledValue: snapshot.value,
      recomputedValue: evaluation.recomputed,
      delta: evaluation.recomputed === null ? null : evaluation.recomputed - snapshot.value,
      kind: evaluation.status,
      reason: evaluation.reason ?? null,
      gaps: evaluation.gaps ?? [],
      intervals: evaluation.intervals ?? [],
      basis: evaluation.basis ?? null,
      settledReadingRefs: snapshot.readingRefs,
      currentReadingRefs: evaluation.currentRefs ?? snapshot.readingRefs.map((ref) => {
        const current = versionRef(ledger, ref.readingId);
        return current ? { readingId: current.readingId, version: current.version, digest: current.digest } : ref;
      }),
      history: existing?.history ?? [],
    };
    if (existing?.state === 'resolved') {
      review.history.push({ state: 'resolved', resolvedAt: existing.resolvedAt, resolution: existing.resolution, note: existing.note ?? null, by: existing.by ?? null });
    }
    next.reviews[snapshot.settlementId] = review;
    reviews.push(review);
    appendAudit(next, {
      at: now,
      type: 'review.opened',
      detail: {
        settlementId: snapshot.settlementId,
        kind: review.kind,
        settledValue: review.settledValue,
        recomputedValue: review.recomputedValue,
        delta: review.delta,
      },
    });
  }
  return { ledger: next, reviews };
}

// 管理员显式裁决差异（保留原确认账单与裁决轨迹）。
export function resolveReview(ledger, settlementId, resolution, options = {}) {
  const now = options.now ?? new Date().toISOString();
  if (!['adjust', 'accept', 'reject'].includes(resolution)) {
    throw new Error('resolution must be one of adjust, accept, reject');
  }
  const review = ledger.reviews[String(settlementId)];
  if (!review) throw new Error(`no open review for settlement ${settlementId}`);
  if (review.state !== 'open') throw new Error(`review for settlement ${settlementId} is already resolved`);
  const next = structuredClone(ledger);
  next.audit = ledger.audit.map((entry) => structuredClone(entry));
  const updated = { ...review, state: 'resolved', resolvedAt: now, resolution, note: options.note ?? review.note ?? null, by: options.by ?? null };
  next.reviews[review.settlementId] = updated;
  appendAudit(next, {
    at: now,
    type: 'review.resolved',
    detail: { settlementId: review.settlementId, resolution, note: updated.note, by: updated.by },
  });
  return { ledger: next, review: updated };
}

// 追溯某个读数：所有版本、参与的区间、引用它的结算与复核。
export function traceReading(ledger, intervals, readingId) {
  const entry = ledger.readings[String(readingId)];
  if (!entry) throw new Error(`unknown reading ${readingId}`);
  const usedByIntervals = intervals
    .filter((interval) => interval.start.readingId === readingId || interval.end.readingId === readingId)
    .map((interval) => ({
      id: interval.id,
      status: interval.status,
      usage: interval.usage,
      coverage: interval.coverage,
      start: { readingId: interval.start.readingId, version: interval.start.version },
      end: { readingId: interval.end.readingId, version: interval.end.version },
    }));
  const usedBySettlements = Object.values(ledger.settlements)
    .filter((snapshot) => snapshot.readingIds.includes(String(readingId)))
    .map((snapshot) => ({
      settlementId: snapshot.settlementId,
      state: snapshot.state,
      value: snapshot.value,
      readingRef: snapshot.readingRefs.find((ref) => ref.readingId === String(readingId)),
    }));
  const reviews = Object.values(ledger.reviews)
    .filter((review) => review.settledReadingRefs.some((ref) => ref.readingId === String(readingId))
      || review.currentReadingRefs.some((ref) => ref.readingId === String(readingId)))
    .map((review) => ({ settlementId: review.settlementId, state: review.state, kind: review.kind, delta: review.delta }));
  return {
    readingId: String(readingId),
    meterId: entry.meterId,
    versions: entry.versions.map((version) => ({
      version: version.version,
      digest: version.digest,
      measuredAt: version.measuredAt,
      receivedAt: version.receivedAt,
      ingestedAt: version.ingestedAt,
      batchId: version.batchId,
      raw: version.raw,
    })),
    usedByIntervals,
    usedBySettlements,
    reviews,
  };
}
