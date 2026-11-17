import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { LedgerRepository } from './ledger-repository.js';
import { MeterLedgerService } from './meter-ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const expectedStepMinutes = process.env.LEDGER_EXPECTED_STEP_MINUTES
  ? Number(process.env.LEDGER_EXPECTED_STEP_MINUTES) : null;
const ledgerService = new MeterLedgerService(
  new LedgerRepository(resolve(here, '../var/ledger.json')),
  { expectedStepMinutes: Number.isFinite(expectedStepMinutes) ? expectedStepMinutes : null },
);

// 兼容旧结构化导入格式（attributes 包裹）与来源原始读数数组。
function toRawReadings(items) {
  return items.map((item) => (item.attributes && item.attributes.readingId ? item.attributes : item));
}

async function readJson(argument, fallback) {
  return JSON.parse(await readFile(argument ?? resolve(here, fallback), 'utf8'));
}

const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | ledger-import [文件] | intervals | reviews | settlements | confirm [文件] | resolve <结算ID> <adjust|accept|reject> [说明] | trace <读数ID>',
    commands: ['ingest', 'query'],
    ledgerCommands: ['ledger-import', 'intervals', 'reviews', 'settlements', 'confirm', 'resolve', 'trace'],
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = await readJson(process.argv[3], '../fixtures/records.json');
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'ledger-import') {
  const items = await readJson(process.argv[3], '../fixtures/meter-readings.json');
  console.log(JSON.stringify(await ledgerService.importReadings(toRawReadings(items)), null, 2));
} else if (action === 'intervals') {
  console.log(JSON.stringify(await ledgerService.listIntervals(), null, 2));
} else if (action === 'reviews') {
  console.log(JSON.stringify(await ledgerService.listReviews(), null, 2));
} else if (action === 'settlements') {
  console.log(JSON.stringify(await ledgerService.listSettlements(), null, 2));
} else if (action === 'confirm') {
  const items = await readJson(process.argv[3], '../fixtures/settlements.json');
  console.log(JSON.stringify(await ledgerService.confirmSettlements(items), null, 2));
} else if (action === 'resolve') {
  const [settlementId, resolution, ...noteParts] = process.argv.slice(3);
  if (!settlementId || !resolution) throw new Error('resolve needs <结算ID> <adjust|accept|reject> [说明]');
  console.log(JSON.stringify(await ledgerService.resolveReview(settlementId, resolution, { note: noteParts.join(' ') || null }), null, 2));
} else if (action === 'trace') {
  const readingId = process.argv[3];
  if (!readingId) throw new Error('trace needs <读数ID>');
  console.log(JSON.stringify(await ledgerService.trace(readingId), null, 2));
} else {
  throw new Error('action must be ingest or query');
}
