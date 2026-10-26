/**
 * 宿主布局与"当前进程是不是真的加载了这份代码"的证据。
 *
 * 关键区分（社区 #40 / #19 反复踩的那条）：
 *   **磁盘上有什么 !== 运行中的进程加载了什么。**
 *   app.asar 存在、app/ 已解开、补丁计数全绿 —— 全都只证明磁盘状态。
 *   唯一能证明"加载了"的，是当前服务进程的**入口路径**落在同一份 resources 里。
 *
 * 所以这里输出两部分，且明确标注可信度：
 *   disk    —— 磁盘布局（archive/unpacked 是否存在），只读探测，读不到记错误不臆测；
 *   process —— 入口布局（archive / unpacked）、来源（--app-path / argv / unknown）、
 *              是否与所选安装同一份（matches_target）。
 * state 取值：
 *   archive_entry      入口指向 app.asar
 *   unpacked_entry     入口指向解包目录
 *   unknown_runtime    拿不到入口证据（CLI 单独调用时常见，属正常）
 *   different_instance 入口指向**另一份**安装 —— 不能用它证明目标已加载
 *   unreadable         磁盘探测出错 —— 保留未知，不要报绿
 */
import path from "node:path";
import { diskFs } from "./extract-asar.js";

/** 从任意宿主路径归一成 resources 目录。只认已知形状，绝不爬任意祖先。 */
export function resourcesOfHost(host) {
  if (!host) return "";
  const n = path.normalize(String(host)).replace(/\\/g, "/");
  const m = /^(.*\/resources)(?:\/(?:app|app\.asar|app\.asar\.unpacked)(?:\/|$)|\(|$)/i.exec(n);
  return m ? path.normalize(m[1]) : "";
}

/**
 * 采集宿主布局证据。
 *
 * @param {object} options
 * @param {string} [options.resources] 目标安装的 resources 目录
 * @param {object} [options.reader]    文件系统读取器（默认 diskFs()）
 * @param {string} [options.platform]
 * @param {string[]} [options.argv]
 * @param {string[]} [options.execArgv]
 * @param {number} [options.pid]
 * @param {string} [options.surface]
 */
export function hostLayoutEvidence(options = {}) {
  const io = options.reader || diskFs();
  const argv = options.argv || process.argv;
  const execArgv = options.execArgv || process.execArgv;
  const platform = options.platform || process.platform;
  const resources = options.resources ? path.resolve(options.resources) : "";

  const disk = { surface: options.surface || "unknown", archive_exists: null, unpacked_exists: null };
  const errors = [];
  const probe = (file, kind) => {
    try { return io.statSync(file)[kind](); } catch (e) {
      if (e.code === "ENOENT") return false;
      errors.push({ code: e.code || "UNKNOWN", message: e.message });
      return null;
    }
  };
  if (resources) {
    disk.archive_exists = probe(path.join(resources, "app.asar"), "isFile");
    disk.unpacked_exists = probe(path.join(resources, "app"), "isDirectory");
  }

  // 只看 --app-path 与 argv[1]。绝不扫描整条命令行：
  // 用户提示词、无关文件参数都不是"进程入口证据"，还会把提示词内容带出来。
  const flags = [...execArgv, ...argv];
  let entry = "";
  let source = "unknown";
  for (let i = 0; i < flags.length; i += 1) {
    const f = flags[i];
    if (typeof f !== "string") continue;
    if (f.startsWith("--app-path=")) { entry = f.slice(11); source = "app-path"; break; }
    if (f === "--app-path" && flags[i + 1]) { entry = flags[i + 1]; source = "app-path"; break; }
  }
  if (!entry && typeof argv[1] === "string" && !argv[1].startsWith("-")) {
    entry = argv[1];
    source = "script";
  }

  const normalized = String(entry).replace(/\\/g, "/");
  const match = /^(.*\/resources)\/(app\.asar|app\.asar\.unpacked|app)(?:\/|$)/i.exec(normalized);
  let layout = "unknown";
  let matchesTarget = null;
  if (match) {
    layout = match[2].toLowerCase() === "app.asar" ? "archive" : "unpacked";
    const norm = (v) => {
      const n = path.normalize(v).replace(/\\/g, "/");
      return platform === "win32" ? n.toLowerCase() : n;
    };
    matchesTarget = resources ? norm(match[1]) === norm(resources) : false;
  } else {
    source = "unknown";
  }

  const state = errors.length ? "unreadable"
    : matchesTarget === false ? "different_instance"
      : layout === "unknown" ? "unknown_runtime"
        : layout === "archive" ? "archive_entry" : "unpacked_entry";

  const notes = {
    unreadable: "磁盘布局读取失败；不能确认当前运行版本。",
    different_instance: "当前服务入口与所选目标安装不同；不能用此进程证明目标已加载。",
    unknown_runtime: "未取得当前服务的桌面入口证据；归档是否存在、磁盘写入计数均不能证明已加载。",
    archive_entry: "当前服务启动入口指向 app.asar；此证据不等于磁盘目录内容已加载。",
    unpacked_entry: "当前服务启动入口指向解包目录；入口位置不能证明之后写入的内容已重新加载。",
  };

  return {
    state,
    disk,
    process: { pid: options.pid ?? process.pid, entry_layout: layout, source, matches_target: matchesTarget },
    note: notes[state],
    ...(errors.length ? { errors } : {}),
  };
}
