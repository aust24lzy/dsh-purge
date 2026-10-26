/**
 * 原子写 + 权限保持（issue #20）。
 *
 * 为什么单独成一个模块：
 *   · core.js 需要它（配置、状态、补丁落盘），hooks-deny.js 也需要它（#M11），
 *     而 hooks-deny 不能 import core（循环依赖）；
 *   · 两处实现必须**行为完全一致**，否则同一次「应用」里不同文件的权限规则会分叉。
 *
 * 规则：
 *   1. 先 stat 原文件拿到精确的 rwx 位（不存在就交给默认 umask，不硬造 mode）；
 *   2. 写 tmp（flag: "wx"，永不复用别人的 tmp）；
 *   3. chmod tmp 回原 mode —— writeFile 的 mode 会被 umask 掩掉，必须补；
 *   4. rename 到目标。Windows 上目标被面板/杀软短暂占用会 EPERM/EACCES/EBUSY，退避重试；
 *   5. 任何失败都清掉 tmp，绝不留半截文件。
 *
 * @param {object} [fsImpl] 文件系统实现（默认 hostFs：按路径自动选 node:fs / original-fs）。
 */
import path from "node:path";
import crypto from "node:crypto";
import { hostFs } from "./extract-asar.js";

const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function atomicFiles(fsImpl = hostFs) {
  const fsp = fsImpl.promises;

  /** 原文件的 rwx 位。allowMissing 时不存在返回 undefined（交给 umask）。 */
  const modeOf = (file, allowMissing = true) => {
    try { return fsImpl.statSync(file).mode & 0o777; } catch (e) {
      if (allowMissing && (e.code === "ENOENT" || e.code === "ENOTDIR")) return undefined;
      throw e;
    }
  };

  /** 唯一 tmp 名：pid + 时间 + 随机，同毫秒并发也不会撞。 */
  const temporary = (file) => `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  function renameSyncRetry(from, to, tries = 5) {
    for (let i = 0; ; i += 1) {
      try { return fsImpl.renameSync(from, to); } catch (e) {
        if (!e || !BUSY_CODES.has(e.code) || i >= tries - 1) throw e;
        sleepSync(50 * (i + 1));
      }
    }
  }

  async function renameRetry(from, to, tries = 5) {
    for (let i = 0; ; i += 1) {
      try { return await fsp.rename(from, to); } catch (e) {
        if (!e || !BUSY_CODES.has(e.code) || i >= tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
  }

  function atomicWriteSync(file, content, encoding = "utf8") {
    const mode = modeOf(file);
    const tmp = temporary(file);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fsImpl.writeFileSync(tmp, content, { encoding, mode, flag: "wx" });
      if (mode !== undefined) fsImpl.chmodSync(tmp, mode);
      renameSyncRetry(tmp, file);
    } catch (error) {
      try { fsImpl.unlinkSync(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  async function atomicWriteFile(file, content, encoding = "utf8") {
    const mode = modeOf(file);
    const tmp = temporary(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await fsp.writeFile(tmp, content, { encoding, mode, flag: "wx" });
      if (mode !== undefined) fsImpl.chmodSync(tmp, mode);
      await renameRetry(tmp, file);
    } catch (error) {
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  /** 拷一份，原子替换目标。用于建 .dshpurge.bak。 */
  async function atomicCopyFile(src, dst) {
    const tmp = `${dst}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.copytmp`;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fsp.copyFile(src, tmp);
      await renameRetry(tmp, dst);
    } catch (error) {
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
      throw error;
    }
  }

  return { atomicWriteSync, atomicWriteFile, atomicCopyFile, modeOf, temporary };
}

/** 默认实现（走 hostFs，自动处理 app.asar 映射）。 */
export const { atomicWriteSync, atomicWriteFile, atomicCopyFile } = atomicFiles();
