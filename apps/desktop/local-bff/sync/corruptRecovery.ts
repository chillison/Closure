import { copyFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Resilience for already-corrupt YAML files on disk.
 *
 * Background: a single unparseable `project.yaml` (legacy corruption from the
 * pre-atomic-write era — a short write left a stale tail behind a valid prefix)
 * used to wedge EVERY save path, because every writer starts with a load and
 * `YAML.parse` threw with no guard. These helpers let loaders catch that, set
 * the bad file aside (never silently destroyed), and self-heal.
 */

/**
 * 隔离根目录（T22-bff，2026-08-27 盲态判读 #11 + 真机实案）：`~/.orison/quarantine/`
 * ——与 shell 侧 `~/.orison/{data,logs,craft-kb}` 全局目录同 convention（app.getPath
 * ('home') 的 bff 侧等价物 = os.homedir()）。`ORISON_QUARANTINE_ROOT` 环境变量是
 * 测试注入缝（ORISON_CDP_PORT 同款 ORISON_ 前缀先例；生产恒缺省）——防测试污染
 * 开发机真实 home。
 */
export function quarantineRootDir(): string {
  return process.env.ORISON_QUARANTINE_ROOT ?? path.join(os.homedir(), '.orison', 'quarantine');
}

/**
 * Move a corrupt file out of the way so callers can rebuild a fresh one without
 * clobbering it.
 *
 * T22-bff（判读批9 双段判读 + 真机实案收口）：备份目标从**项目目录内**（旧：
 * `<file>.corrupt-<timestamp>` 原地改名）改为**项目外安全位置**
 * `~/.orison/quarantine/<项目目录名>/<文件名>.corrupt-<timestamp>`——留在项目里
 * 的 `.corrupt-*` 是文件树可见的「吓人残留」（用户目击 `project.yaml.corrupt-*`
 * 误判工程损坏扩散；08-27 真机已手工清出到 Closure-backup）。
 *
 * 项目标识口径：判腐时文档本身已不可信（解析失败才走到这里），meta.id 无从取
 * ——按项目目录名兜底（`bootstrapProjectFromMeta` 的目录名兜底同款先例）。目录
 * 不存在递归建。
 *
 * 文件名保留 `<原名>.corrupt-<timestamp>` 形态：上层通知/日志的 backupPath 语义
 * 不变，只有路径值所指的位置变。Best-effort：跨盘 rename（EXDEV）落 copy+unlink
 * 兜底；再失败不抛（调用方仍照常 bootstrap），返回 null = 原文件原位保留。
 */
export function backupCorruptFile(filePath: string): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const projectDirName = path.basename(path.dirname(path.resolve(filePath)));
  const backupDir = path.join(quarantineRootDir(), projectDirName);
  const backupPath = path.join(backupDir, `${path.basename(filePath)}.corrupt-${stamp}`);
  try {
    mkdirSync(backupDir, { recursive: true });
    renameSync(filePath, backupPath);
    return backupPath;
  } catch {
    try {
      copyFileSync(filePath, backupPath);
      unlinkSync(filePath);
      return backupPath;
    } catch {
      return null;
    }
  }
}

/**
 * Salvage the largest leading slice of a corrupt YAML string that still parses
 * to a non-null object. The legacy corruption signature is a valid document
 * followed by stale trailing garbage, so the valid prefix usually carries the
 * real data (name, ids, version, …) — far better than discarding everything and
 * falling back to a directory-name bootstrap.
 *
 * Scans line boundaries from the end inward (cheap for the small config files
 * this runs on). Returns the parsed object, or null if nothing parses.
 */
export function salvageYamlPrefix(raw: string): Record<string, unknown> | null {
  const lines = raw.split('\n');
  for (let end = lines.length; end > 0; end--) {
    const candidate = lines.slice(0, end).join('\n');
    try {
      const parsed = YAML.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Prefix still breaks the parser — shrink and retry.
    }
  }
  return null;
}
