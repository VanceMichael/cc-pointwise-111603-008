import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyLedger } from './ledger-store.js';

// 台账状态独立于旧 records.json，原子写入，缺文件时返回空台账。
export class LedgerRepository {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      const ledger = emptyLedger();
      for (const key of Object.keys(ledger)) {
        if (value[key] !== undefined) ledger[key] = value[key];
      }
      return ledger;
    } catch (error) {
      if (error.code === 'ENOENT') return emptyLedger();
      throw error;
    }
  }

  async replace(ledger) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
