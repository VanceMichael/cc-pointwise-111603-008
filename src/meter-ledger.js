import {
  buildIntervals,
  confirmSettlements,
  diffIntervals,
  digestInterval,
  emptyLedger,
  importReadings,
  recheckSettlements,
  resolveReview,
  traceReading,
} from './ledger-store.js';

// 台账应用服务：每次操作先重建区间、再复核已确认结算，并持久化完整状态。
// expectedStepMinutes 用于识别读数缺口；为 null 时不做缺口判定。
export class MeterLedgerService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.expectedStepMinutes = options.expectedStepMinutes ?? null;
  }

  _rebuild(ledger) {
    const intervals = buildIntervals(ledger, { expectedStepMinutes: this.expectedStepMinutes });
    return intervals.map((interval) => ({ ...interval, digest: digestInterval(interval) }));
  }

  async importReadings(rawItems, options = {}) {
    const ledger = await this.repository.read();
    const before = this._rebuild(ledger);
    const imported = importReadings(ledger, rawItems, options);
    const intervals = this._rebuild(imported.ledger);
    const affected = diffIntervals(before, intervals);
    const checked = recheckSettlements(imported.ledger, intervals, options);
    checked.ledger.intervals = intervals;
    await this.repository.replace(checked.ledger);
    return {
      ...imported.result,
      intervals: intervals.length,
      affected,
      openReviews: Object.values(checked.ledger.reviews).filter((review) => review.state === 'open').length,
    };
  }

  async confirmSettlements(settlements, options = {}) {
    const ledger = await this.repository.read();
    const confirmed = confirmSettlements(ledger, settlements, options);
    const intervals = this._rebuild(confirmed.ledger);
    const checked = recheckSettlements(confirmed.ledger, intervals, options);
    checked.ledger.intervals = intervals;
    await this.repository.replace(checked.ledger);
    return {
      ...confirmed.result,
      openReviews: Object.values(checked.ledger.reviews).filter((review) => review.state === 'open').length,
      reviews: checked.reviews,
    };
  }

  async resolveReview(settlementId, resolution, options = {}) {
    const ledger = await this.repository.read();
    const resolved = resolveReview(ledger, settlementId, resolution, options);
    resolved.ledger.intervals = this._rebuild(resolved.ledger);
    await this.repository.replace(resolved.ledger);
    return resolved.review;
  }

  async readLedger() {
    const ledger = await this.repository.read();
    return { ...ledger, intervals: this._rebuild(ledger) };
  }

  async listIntervals() { return this._rebuild(await this.repository.read()); }

  async listReviews() {
    const ledger = await this.repository.read();
    return Object.values(ledger.reviews).sort((left, right) => left.detectedAt.localeCompare(right.detectedAt));
  }

  async listSettlements() {
    const ledger = await this.repository.read();
    return Object.values(ledger.settlements).sort((left, right) => left.settlementId.localeCompare(right.settlementId));
  }

  async trace(readingId) {
    const ledger = await this.repository.read();
    return traceReading(ledger, this._rebuild(ledger), readingId);
  }

  async empty() { await this.repository.replace(emptyLedger()); }
}
