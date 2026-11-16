const fields = ["readingId", "meterId", "measuredAt", "receivedAt", "register", "epoch", "unit"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "园区电表读数台账", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}
