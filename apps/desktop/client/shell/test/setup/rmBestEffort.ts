// 全局测试 setup（agent 包）：fs.rmSync EPERM best-effort 包装。
//
// Windows 负载下 WAL/句柄释放与 rmSync 有竞态，afterEach 清理临时目录偶发 EPERM
// ——GitHub windows runner 多轮实录（orison-batch-segment-* / orison-leader-* /
// dispatch-style-analyzer-* 等，逐文件加重试不收敛）。此处在测试进程内统一兜底：
// EPERM 一律吞掉（目录在 os.tmpdir()，残留无害），其余错误照抛。断言面零影响——
// 没有任何测试断言「rm 必须成功」；真正的句柄泄漏由各测试自身的 closeDb/afterEach
// 语义保证。
import fs from 'node:fs';

const origRmSync = fs.rmSync.bind(fs);

type RmSyncArgs = Parameters<typeof fs.rmSync>;
const patchedRmSync = (...args: RmSyncArgs) => {
  try {
    return origRmSync(...args);
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM') return undefined;
    throw err;
  }
};

// cast：Node 类型把重载摊平后 bind 已丢失精确签名，测试 setup 内可接受。
(fs as unknown as { rmSync: typeof patchedRmSync }).rmSync = patchedRmSync;

export {};
