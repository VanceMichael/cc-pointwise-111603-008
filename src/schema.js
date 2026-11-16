export const schema = Object.freeze({
  "product": "园区电表读数台账",
  "entity": "电表读数",
  "identity": "sourceId",
  "required": [
    "sourceId",
    "source",
    "observedAt",
    "label"
  ],
  "description": "电表读数采集的迟到回补"
});
