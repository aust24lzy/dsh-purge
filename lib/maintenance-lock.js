/**
 * 维护操作互斥（备份 / 应用 / 回滚 / 安装）。
 *
 * 为什么要它：`backupAll` 先建 `.dshpurge.bak` 占位再原子拷贝，`revertAll` 反过来
 * 用 bak 覆盖目标。两个进程（面板点「应用」+ CLI 跑 `revert`，或两个 profile 并行）
 * 同时进来时，A 正在 copy、B 已经把 bak 拿去还原，结果是**双方都"成功"、文件却是半新半旧**。
 * 这类损坏不会报错，只会在下一次启动时表现为「宿主神秘坏掉」。
 *
 * 设计约束（照社区 1.6.60 的教训）：
 *   · **锁龄不是死亡证据**。`mtime 超过 30 分钟就抢锁` 会把还在跑的长任务（大 asar 解包
 *     动辄十几分钟）当成遗留锁强行接管，正好在它写文件的中途插进来。
 *   · 判定死亡只有两条路：进程已不存在（ESRCH），或 PID 被复用（进程启动时间晚于锁创建）。
 *     EPERM / 读不到 / 跨机一律**不算死亡**，宁可阻塞也不并发写。
 *   · 发布方式是「把准备好的非空目录 rename 成 guard」，不是「先 rename 旧锁再建新锁」——
 *     后者会短暂暴露一个空锁路径，别的进程可能把它当成"没人持有"。
 *   · 收尾一律非递归 rmdir：绝不删掉别人刚发布的新锁。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const host = os.hostname();
/** 本进程的"诞生时刻"，用来识别 PID 复用。 */
const born = Date.now() - process.uptime() * 1000;
const absent = (e) => Boolean(e) && e.code === "ENOENT";

const busy = (detail) => Object.assign(
  new Error(`已有维护操作或遗留锁：${detail}；本次未并发修改。请确认原维护进程已退出，不要直接删除活动锁。`),
  { code: "MAINTENANCE_BUSY" },
);
const lost = () => Object.assign(
  new Error("维护锁归属无法确认，本次操作已停止；备份与恢复目录已保留，未继续写入或自动恢复。"),
  { code: "LOCK_LOST" },
);

/**
 * 进程启动时间（毫秒）。Windows 走 PowerShell，类 Unix 走 `ps -o lstart`。
 * 拿不到就返回 NaN —— 调用方会把它当作"无法确认"，不会当作死亡。
 */
function processBirth(pid) {
  if (pid === process.pid) return born;
  try {
    if (process.platform === "win32") {
      const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`;
      return Number(execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", command,
      ], {
        encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      }).trim());
    }
    const text = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Date.parse(text);
  } catch {
    return NaN;
  }
}

/** 兼容两种旧格式：JSON 对象，或 `pid:createdAt` / `host:pid:createdAt`。 */
function ownerFrom(raw, createdAt) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") return value;
  } catch { /* 老格式 */ }
  const parts = String(raw).trim().split(":");
  return {
    host: parts.length >= 3 ? parts[0] : host,
    pid: Number(parts.length >= 3 ? parts[1] : parts[0]),
    createdAt,
  };
}

/**
 * 持有者是否确定已死。
 * 只有 ESRCH 或 PID 复用算死；跨机、EPERM、读不到、时间不可解析一律 false。
 */
function ownerDead(owner, io) {
  if (owner.host !== host || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    io.kill(owner.pid, 0);
  } catch (e) {
    return e?.code === "ESRCH"; // EPERM / 未知错误不是死亡
  }
  // PID 还在：只有它比锁更晚诞生，才说明这是被复用的另一个进程。
  // 2000ms 余量覆盖 ps 的秒级精度与调度抖动。
  const start = io.birth(owner.pid);
  return Number.isFinite(start) && Number.isFinite(owner.createdAt) && start > owner.createdAt + 2000;
}

/** 锁文件必须是普通文件、硬链接数为 1（防 symlink / 硬链接把写入引到别处）。 */
function regular(io, file) {
  const stat = io.fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw busy("锁文件类型异常，保留现场");
  return stat;
}

/**
 * 取得维护锁。
 *
 * @returns `{ check, release }`
 *   · `check()` —— 每次 await 之后、每次真正落盘之前调用；归属丢了就抛 LOCK_LOST，
 *     调用方必须立刻停止而不是继续写。
 *   · `release()` —— 幂等；只删属于自己 token 的那一份。
 */
export function acquireMaintenanceLock(base, options = {}) {
  const io = { fs, kill: process.kill.bind(process), birth: processBirth, ...options };
  const gate = path.join(base, "maintenance.guard");
  const legacy = path.join(base, "maintenance.lock");
  const token = randomBytes(16).toString("hex");
  const name = token + ".json";
  const owner = { schema: 1, host, pid: process.pid, createdAt: Date.now(), token };
  const raw = JSON.stringify(owner);
  const stage = path.join(base, ".maintenance-" + token);

  io.fs.mkdirSync(stage, { mode: 0o700 });
  try {
    io.fs.writeFileSync(path.join(stage, name), raw, { flag: "wx", mode: 0o600 });
  } catch (e) {
    try { io.fs.unlinkSync(path.join(stage, name)); io.fs.rmdirSync(stage); } catch { /* 清理尽力 */ }
    throw e;
  }

  let held = false;
  let compatibility = false;

  function check() {
    try {
      if (!held || io.fs.readFileSync(path.join(gate, name), "utf8") !== raw
        || io.fs.readFileSync(legacy, "utf8") !== raw) throw lost();
      regular(io, legacy);
    } catch (e) {
      if (e.code === "LOCK_LOST") throw e;
      throw Object.assign(lost(), { cause: e });
    }
  }

  function release() {
    // 新旧两种写者都要在目录门里动 legacy 文件：老版本写者看到 EEXIST 就不会进来。
    try {
      if (compatibility
        && io.fs.readFileSync(path.join(gate, name), "utf8") === raw
        && io.fs.readFileSync(legacy, "utf8") === raw) io.fs.unlinkSync(legacy);
    } catch { /* 已被别人接管时不动 */ }
    if (held) {
      try { io.fs.unlinkSync(path.join(gate, name)); } catch { /* 已不在 */ }
      try { io.fs.rmdirSync(gate); } catch { /* 非递归：绝不删掉新主人发布的目录 */ }
      held = false;
    }
  }

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // 发布一个**非空**的准备目录。比"先把旧锁 rename 走"安全：
        // 任何时候都不会暴露一个空的锁路径名。
        io.fs.renameSync(stage, gate);
        held = true;
        break;
      } catch (error) {
        let stat;
        try {
          stat = io.fs.lstatSync(gate);
        } catch (e) {
          if (absent(e)) {
            if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) continue;
            throw error;
          }
          throw e;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy("维护互斥目录类型异常");
        const names = io.fs.readdirSync(gate);
        if (names.length === 0) {
          // 空目录：上一个持有者 rmdir 前的瞬间。可以清掉重试。
          try { io.fs.rmdirSync(gate); } catch (e) {
            if (!absent(e) && e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e;
          }
          continue;
        }
        if (names.length !== 1 || !/^[a-f0-9]{32}\.json$/.test(names[0])) {
          throw busy("维护互斥目录内容未知");
        }
        const file = path.join(gate, names[0]);
        try {
          regular(io, file);
          const prior = ownerFrom(io.fs.readFileSync(file, "utf8"), NaN);
          if (!ownerDead(prior, io)) {
            throw busy(`进程 ${prior.pid || "未知"} 的归属尚未结束或无法确认`);
          }
          // 只删这个已死持有者的唯一文件名。并发起来的另一个获取者会发布另一个非空目录，
          // 于是后面的 rmdir 安全失败，不会误删。
          io.fs.unlinkSync(file);
          try { io.fs.rmdirSync(gate); } catch (e) {
            if (!absent(e) && e.code !== "ENOTEMPTY" && e.code !== "EEXIST") throw e;
          }
        } catch (e) {
          if (!absent(e)) throw e;
        }
      }
    }
    if (!held) throw busy("其他维护进程正在接管");

    // 兼容层：老版本只认 maintenance.lock。新版本在目录门保护下与它共存。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd;
      try {
        fd = io.fs.openSync(legacy, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const stat = regular(io, legacy);
        const previous = io.fs.readFileSync(legacy, "utf8");
        const prior = ownerFrom(previous, stat.mtimeMs);
        if (!ownerDead(prior, io)) {
          throw busy(`旧锁 PID=${prior.pid || "未知"}，mtime=${stat.mtime.toISOString()}，存活或归属未知`);
        }
        // 回收者被目录门串行化：确认已死的老写者不会释放这个文件，
        // 而新老版本写者都会看到 EEXIST。
        if (io.fs.readFileSync(legacy, "utf8") !== previous) throw busy("旧锁在检查期间变化");
        const current = regular(io, legacy);
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.mtimeMs !== stat.mtimeMs) {
          throw busy("旧锁在检查期间变化");
        }
        io.fs.unlinkSync(legacy);
        continue;
      }
      try {
        io.fs.writeFileSync(fd, raw);
        compatibility = true;
      } catch (e) {
        try { io.fs.unlinkSync(legacy); } catch { /* ignore */ }
        throw e;
      } finally {
        io.fs.closeSync(fd);
      }
      check();
      return { check, release };
    }
    throw busy("未取得维护锁");
  } catch (e) {
    release();
    throw e;
  } finally {
    try { io.fs.unlinkSync(path.join(stage, name)); } catch { /* 已 rename 走 */ }
    try { io.fs.rmdirSync(stage); } catch { /* 已 rename 走 */ }
  }
}

/** 便捷包装：`withMaintenanceLock(base, fn)`，finally 一定 release。 */
export async function withMaintenanceLock(base, fn, options = {}) {
  const guard = acquireMaintenanceLock(base, options);
  try {
    const result = await fn(guard);
    guard.check();
    return result;
  } finally {
    guard.release();
  }
}
