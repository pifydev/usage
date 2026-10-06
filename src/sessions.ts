import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordFromLine } from "./aggregate.ts";
import type { UsageRecord } from "./types.ts";

/**
 * Scan pi's session store for usage records. Zero network, zero LLM tokens
 * (aporcelli's principle): everything is computed from local JSONL files.
 * Per-file mtime+size cache keeps repeat scans cheap.
 */

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const cache = new Map<string, { mtimeMs: number; size: number; records: UsageRecord[] }>();
/** Files the latest scan saw; only these are persisted, so a moved store does not grow the cache forever. */
let lastSeen = new Set<string>();

export function clearScanCache(): void {
  cache.clear();
  lastSeen = new Set();
}

/** Bump when the cached record shape changes; an older file is ignored and rebuilt. */
export const SCAN_CACHE_VERSION = 1;
/** Entries kept on disk; beyond it the oldest-modified files are dropped. */
export const SCAN_CACHE_MAX_ENTRIES = 5000;

/**
 * The in-process cache only ever helped within one pi process, and the
 * dashboard is opened about once per session — so every fresh pi paid the
 * whole cold scan (seconds, for a large store) on the first /usage. The
 * same Map, written once after a completed scan and read back before the
 * first, makes a warm open cheap. Keyed by size+mtime exactly like the
 * in-memory check, so a stale entry is simply re-read; corrupt, missing or
 * older-version files start empty. Last writer wins — no lock: the cost of
 * a lost write is one cold scan. (pi-usage-extension's cache, simplified.)
 */
export function restoreScanCache(file: string): number {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return 0;
  }
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== SCAN_CACHE_VERSION) return 0;
  const entries = (raw as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object") return 0;
  let loaded = 0;
  for (const [path, value] of Object.entries(entries as Record<string, unknown>)) {
    const v = value as { mtimeMs?: unknown; size?: unknown; records?: unknown };
    if (typeof v?.mtimeMs !== "number" || typeof v.size !== "number" || !Array.isArray(v.records)) continue;
    cache.set(path, { mtimeMs: v.mtimeMs, size: v.size, records: v.records as UsageRecord[] });
    loaded++;
  }
  return loaded;
}

export function persistScanCache(file: string): number {
  const kept = [...cache.entries()]
    .filter(([path]) => lastSeen.has(path))
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    .slice(0, SCAN_CACHE_MAX_ENTRIES);
  const entries: Record<string, { mtimeMs: number; size: number; records: UsageRecord[] }> = {};
  for (const [path, value] of kept) entries[path] = value;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: SCAN_CACHE_VERSION, entries }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // An unwritable cache costs the next process one cold scan, nothing else.
    return 0;
  }
  return kept.length;
}

function listJsonlFiles(dir: string, depth: number): string[] {
  if (depth > 4) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) files.push(...listJsonlFiles(full, depth + 1));
      else if (name.endsWith(".jsonl") && stat.size <= MAX_FILE_BYTES) files.push(full);
    } catch {
      // race/permission — skip
    }
  }
  return files;
}

export interface ScanResult {
  records: UsageRecord[];
  files: number;
}

const MAX_LABEL = 34;

/**
 * Readable name for a project directory. pi encodes the project path into the
 * directory name (--D--project-pify-plugins--); the tail is the recognizable
 * part, so long names keep their end.
 */
export function projectLabel(dirName: string): string {
  const stripped = dirName.replace(/^-+|-+$/g, "");
  if (!stripped) return "unknown";
  return stripped.length > MAX_LABEL ? `…${stripped.slice(-(MAX_LABEL - 1))}` : stripped;
}

/** Session files grouped by the project directory they sit under. */
function groupByProject(sessionsDir: string): Array<{ project: string; files: string[] }> {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const groups: Array<{ project: string; files: string[] }> = [];
  const loose: string[] = [];
  for (const name of names) {
    const full = join(sessionsDir, name);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        groups.push({ project: projectLabel(name), files: listJsonlFiles(full, 1) });
      } else if (name.endsWith(".jsonl") && stat.size <= MAX_FILE_BYTES) {
        loose.push(full);
      }
    } catch {
      // race/permission — skip
    }
  }
  if (loose.length > 0) groups.push({ project: "", files: loose });
  return groups;
}

export function scanSessions(sessionsDir: string): ScanResult {
  const records: UsageRecord[] = [];
  let fileCount = 0;
  const seen = new Set<string>();
  for (const { project, files } of groupByProject(sessionsDir)) {
    fileCount += files.length;
    for (const file of files) {
      seen.add(file);
      try {
        const stat = statSync(file);
        const cached = cache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          records.push(...cached.records);
          continue;
        }
        const fileRecords: UsageRecord[] = [];
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const record = recordFromLine(line);
          if (record) fileRecords.push({ ...record, project });
        }
        cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, records: fileRecords });
        records.push(...fileRecords);
      } catch {
        // unreadable — skip
      }
    }
  }
  lastSeen = seen;
  return { records, files: fileCount };
}
