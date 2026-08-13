import { dirname } from "node:path";
import { mkdir, open, readFile } from "node:fs/promises";

export const MONITOR_RECORD_TYPE = "project_status_monitor_run";

export function assertMonitorRunRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Monitor run record must be an object.");
  }
  if (record.schemaVersion !== 1 || record.recordType !== MONITOR_RECORD_TYPE) {
    throw new TypeError("Unsupported monitor run record schema.");
  }
  if (!Array.isArray(record.checks)) throw new TypeError("Monitor run record checks must be an array.");
  if (!Number.isFinite(Date.parse(record.completedAt))) throw new TypeError("Monitor run completedAt is invalid.");
  return record;
}

export class JsonlRunStore {
  constructor(filePath, dependencies = {}) {
    if (typeof filePath !== "string" || filePath.trim() === "") throw new TypeError("History file path is required.");
    this.filePath = filePath;
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir,
      open: dependencies.open ?? open,
      readFile: dependencies.readFile ?? readFile,
    };
  }

  async append(record) {
    assertMonitorRunRecord(record);
    const line = `${JSON.stringify(record)}\n`;
    await this.fs.mkdir(dirname(this.filePath), { recursive: true });
    const handle = await this.fs.open(this.filePath, "a", 0o600);
    try {
      await handle.writeFile(line, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async readLatest() {
    const records = await this.readHistory({ limit: 1 });
    return records[0] ?? null;
  }

  async readHistory({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("History limit must be an integer between 1 and 10,000.");
    }
    let source;
    try {
      source = await this.fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const retained = [];
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (line === "") continue;
      let record;
      try {
        record = JSON.parse(line);
        assertMonitorRunRecord(record);
      } catch {
        throw new Error(`Monitor history contains an invalid JSONL record at line ${index + 1}.`);
      }
      retained.push(record);
      if (retained.length > limit) retained.shift();
    }
    return retained.reverse();
  }
}

/** Deterministic test/development store with the same explicit append surface. */
export class MemoryRunStore {
  #records = [];

  async append(record) {
    assertMonitorRunRecord(record);
    this.#records.push(structuredClone(record));
  }

  async readLatest() {
    return this.#records.length === 0 ? null : structuredClone(this.#records.at(-1));
  }

  async readHistory({ limit = 100 } = {}) {
    return this.#records.slice(-limit).reverse().map((record) => structuredClone(record));
  }

  get size() {
    return this.#records.length;
  }
}
