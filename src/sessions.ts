import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { recordFromLine } from "./aggregate.ts";
import type { UsageRecord } from "./types.ts";

/**
 * Scan pi's session store for usage records. Zero network, zero LLM tokens
 * (aporcelli's principle): everything is computed from local JSONL files.
 * Per-file mtime+size cache keeps repeat scans cheap.
 */

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const cache = new Map<string, { mtimeMs: number; size: number; records: UsageRecord[] }>();

export function clearScanCache(): void {
  cache.clear();
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
  for (const { project, files } of groupByProject(sessionsDir)) {
    fileCount += files.length;
    for (const file of files) {
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
  return { records, files: fileCount };
}
