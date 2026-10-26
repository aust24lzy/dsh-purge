/**
 * 本地重锚覆盖。
 *
 * 宿主升级（0.2.1 → 0.2.2 → 0.3.0）时源码片段会漂，补丁锚点对不上就报
 * `skipped / pattern_not_found`。改插件源码不现实（升级会被覆盖），所以这里允许把
 * 某条补丁的某个 pattern 换成"从当前宿主里取出来的真实片段"，存在
 * `$DSH_HOME/dsh-purge/anchor-overrides.json`，apply 时叠加到补丁表上。
 *
 * 格式：
 *   { "24": { "0": { "pattern": "...", "at": "2026-…", "host": "0.2.1-rc.3" } } }
 * 删掉文件即恢复出厂锚点（不改插件本体，也不动用户提示词）。
 *
 * 故意不 import core：core 会 import 本模块，形成循环依赖。这里只需要"数据目录"，
 * 用同样的解析顺序即可。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function dshHome(explicit) {
  if (explicit) return explicit;
  const env = String(process.env.DSH_HOME || "").trim();
  if (env) return env;
  return path.join(os.homedir(), ".dsh");
}

export const OVERRIDES_FILE = "anchor-overrides.json";

function file(explicit) {
  const home = dshHome(explicit);
  if (!home) return "";
  return path.join(home, "dsh-purge", OVERRIDES_FILE);
}

export function overridesPath(dshHome) {
  return file(dshHome);
}

export function readOverrides(dshHome) {
  const fp = file(dshHome);
  if (!fp) return {};
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function writeOverride(dshHome, patchId, index, pattern, extra = {}) {
  const fp = file(dshHome);
  if (!fp) throw new Error("未定位 DSH 数据目录，无法写重锚覆盖");
  if (typeof pattern !== "string" || pattern === "") throw new Error("pattern 不能为空");
  const all = readOverrides(dshHome);
  const key = String(patchId);
  all[key] = all[key] || {};
  all[key][String(index)] = { pattern, at: new Date().toISOString(), ...extra };
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fp);
  return all;
}

export function clearOverride(dshHome, patchId, index) {
  const all = readOverrides(dshHome);
  const key = String(patchId);
  if (!all[key]) return all;
  if (index === undefined) delete all[key];
  else delete all[key][String(index)];
  if (all[key] && Object.keys(all[key]).length === 0) delete all[key];
  const fp = file(dshHome);
  if (fp) fs.writeFileSync(fp, JSON.stringify(all, null, 2), { mode: 0o600 });
  return all;
}

/** 把覆盖叠到一条补丁的 replacements 上（不改原对象）。 */
export function applyOverrides(patch, overrides) {
  const all = overrides || {};
  const mine = all[String(patch && patch.id)];
  if (!mine) return patch;
  const list = Array.isArray(patch.replacements)
    ? patch.replacements.slice()
    : (patch.patterns ?? []).map((pat) => ({ pattern: pat, replace: patch.replace }));
  let changed = false;
  for (const [index, entry] of Object.entries(mine)) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) continue;
    if (!entry || typeof entry.pattern !== "string" || !entry.pattern) continue;
    list[i] = { ...list[i], pattern: entry.pattern };
    changed = true;
  }
  if (!changed) return patch;
  return { ...patch, replacements: list, overridden: true };
}
