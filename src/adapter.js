export const entryPath = "/meters/M1/readings";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["readingId"]),
    source: "园区电表读数台账",
    observedAt: item["measuredAt"],
    label: String(item["meterId"]),
    attributes: structuredClone(item),
  })) };
}
