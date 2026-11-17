import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { LedgerRepository } from './ledger-repository.js';
import { MeterLedgerService } from './meter-ledger.js';
import { readLedgerOperations, readOperations } from './operations.js';

const fixtures = (name) => new URL(`../fixtures/${name}.json`, import.meta.url);
const source = await startSource(fixtures('source'));
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  // 旧链路保持可用：来源页面 -> 结构化集合 -> 业务查询
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  const repository = new RecordRepository(join(directory, 'records.json'));
  await new CollectionService(repository).ingest(page.records);

  // 新区间台账：首批读数、迟到中间读数、更正读数
  const ledger = new MeterLedgerService(new LedgerRepository(join(directory, 'ledger.json')), { expectedStepMinutes: 30 });
  const opening = JSON.parse(await readFile(fixtures('meter-readings'), 'utf8'));
  const late = JSON.parse(await readFile(fixtures('meter-readings-late'), 'utf8'));
  const correction = JSON.parse(await readFile(fixtures('meter-readings-correction'), 'utf8'));
  await ledger.importReadings(opening);
  await ledger.importReadings(late);
  const replay = await ledger.importReadings(late); // 重复导入不重复计量
  await ledger.confirmSettlements([
    { settlementId: 'M1-2026-11-16', meterId: 'M1', interval: '08:00/09:00', readingIds: ['r1', 'r3'], value: 14 },
  ]);
  await ledger.importReadings(correction); // 已确认后到达的更正

  const operations = await readOperations(repository, ledger);
  const ledgerOperations = await readLedgerOperations(ledger);
  const trace = await ledger.trace('r3');
  console.log(JSON.stringify({
    legacyRows: operations.rows.length,
    replay,
    intervals: ledgerOperations.intervals,
    openReviews: ledgerOperations.openReviews,
    confirmedSettlements: ledgerOperations.confirmedSettlements,
    r3Versions: trace.versions.map((version) => ({ version: version.version, digest: version.digest, register: version.raw.register })),
  }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
