import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * rename 瞬态错重试（dogfood R2 #85）。
 *
 * 来源：Windows 上原子写的 rename 步骤会被**本进程之外**的句柄瞬态占用——
 * 杀软扫描新改名文件、git 轮询读目标、过滤驱动语义——抛 EPERM/EBUSY。
 * 两次实录（16:01/17:02）均在写章链写盘窗口：旧文件保住（数据零丢失）、
 * tmp 已清理，但错误直接炸到用户面（「章节元数据写入失败」toast）。写侧
 * 已全部走 withProjectLock（进程内串行化），占持源在进程外、追责不可行，
 * 唯一解是短延迟避让后重试（外部持柄窗口典型为毫秒~百毫秒级）。
 *
 * 只重试 EPERM/EBUSY（Windows 瞬态占用族：句柄拒绝删除/改名 + 共享冲突）：
 * ENOENT/EACCES 等其余错误码是真错（路径不存在/权限问题），重试无益且
 * 掩盖问题，直抛原错。
 *
 * 延迟量级 50/150/300/500ms（四级退避共 ~1s，含首次共至多 5 次尝试）：
 * #85 时的 [50,150]（200ms/3 试）已跨过绝大多数扫描器持柄窗口，但 08-30
 * 实录（#106）出现 >200ms 的外部持柄——预算耗尽抛原错后，上游
 * sync-chapters-meta 链只 toast 无重试，真丢一次章元数据同步。加码到
 * ~1s/5 试；竞态顶满时主线程 sleepSync 最坏 1s 有界阻塞，是「本来要丢
 * 数据」场景下正确的代价交换（1s 仍不够时递进项=IPC 层整步退避，见
 * dogfood R2 修复批 design §3.3）。更早的 attempt*10ms 自旋（总 100ms）
 * 在 #85 实录中已证明不够用。
 */
const RENAME_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 150, 300, 500];

/** 同步短睡。atomicWriteFileSync 是同步函数（全库调用点皆同步，签名零变化），
 * 重试等待必须同步——Atomics.wait 是 Node/Electron 主进程里唯一不烧 CPU 的
 * 真同步 sleep（阻塞的只是 JS 主线程，libuv 线程池与进程外持柄者照常推进）。 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 兜底：环境异常禁用 Atomics.wait 时退化为有界忙等（最坏 200ms）。
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !RENAME_TRANSIENT_CODES.has(code ?? '')) {
        throw err;
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function atomicWriteFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  encoding?: BufferEncoding,
): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    const buffer = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf-8') : data;
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, buffer as NodeJS.ArrayBufferView);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmpPath, filePath);
  } catch (error) {
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
    throw error;
  }
}
