const fields = ["readingId", "meterId", "measuredAt", "receivedAt", "register", "epoch", "unit"];

export async function readOperations(repository, ledgerService = null) {
  const records = await repository.read();
  const view = { product: "园区电表读数台账", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
  if (ledgerService) {
    const ledger = await ledgerService.readLedger();
    view.ledger = {
      intervals: ledger.intervals,
      reviews: Object.values(ledger.reviews),
      settlements: Object.values(ledger.settlements),
    };
  }
  return view;
}

// 台账业务视图：区间（含 boundary/regression/gap 解释）与待管理员处理的复核差异。
export async function readLedgerOperations(ledgerService) {
  const ledger = await ledgerService.readLedger();
  return {
    product: "园区电表区间台账",
    intervals: ledger.intervals,
    openReviews: Object.values(ledger.reviews).filter((review) => review.state === 'open'),
    confirmedSettlements: Object.values(ledger.settlements).map((snapshot) => ({
      settlementId: snapshot.settlementId,
      meterId: snapshot.meterId,
      value: snapshot.value,
      confirmedAt: snapshot.confirmedAt,
      readingRefs: snapshot.readingRefs,
    })),
  };
}
