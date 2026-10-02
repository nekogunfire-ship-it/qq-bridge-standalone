// 递归复制目录的安全实现。
//
// ⚠️ 为什么不用 fs.cpSync：本机实测 `fs.cpSync(dir, dest, { recursive: true })` 会让
// Node 进程直接 fast-fail（Windows NTSTATUS 0xC0000409，退出码 3221226505 / -1073740791），
// 连 uncaughtException / unhandledRejection 都来不及触发，也没有任何输出。
//
// 对照实验结果（tools 里的探针一次性验证过）：
//   ✅ fs.writeFileSync / mkdirSync(recursive) / copyFileSync 单文件
//   ✅ fs.cpSync 复制单个文件（不带 recursive）
//   ❌ fs.cpSync 复制目录（带 recursive）—— 无论目录里是什么，普通目录也崩
//   ✅ 手动 walk + copyFileSync
//
// 因此这里自己走 walk + copyFileSync。附带好处：可以按文件名过滤（打包脱敏时需要）。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 递归复制目录内容。
 * @param {string} src 源目录
 * @param {string} dest 目标目录（不存在会创建）
 * @param {{ filter?: (name: string, srcPath: string) => boolean, skip?: RegExp }} [options]
 *   filter 返回 false 的文件会被跳过；skip 匹配到的文件/目录名会被跳过。
 * @returns {{ copied: number, skipped: number, dirs: number }}
 */
export function copyDirRecursive(src, dest, options = {}) {
  const { filter, skip } = options;
  const stats = { copied: 0, skipped: 0, dirs: 0 };

  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    stats.dirs += 1;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      // 跳过符号链接：避免把链接目标的内容复制进来，或形成复制环
      if (entry.isSymbolicLink()) { stats.skipped += 1; continue; }
      if (skip && skip.test(entry.name)) { stats.skipped += 1; continue; }
      const srcPath = path.join(from, entry.name);
      const destPath = path.join(to, entry.name);
      if (entry.isDirectory()) { walk(srcPath, destPath); continue; }
      if (!entry.isFile()) { stats.skipped += 1; continue; }
      if (filter && !filter(entry.name, srcPath)) { stats.skipped += 1; continue; }
      fs.copyFileSync(srcPath, destPath);
      stats.copied += 1;
    }
  };

  walk(src, dest);
  return stats;
}
