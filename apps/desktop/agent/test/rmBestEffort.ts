// 测试共享 helper：fs.rmSync best-effort 清理（R5 收敛，单源定义）。
// mirror 于 apps/desktop/client/shell/test/rmBestEffort.ts（两包孪生，改动两处同步）。
//
// 语义定谳（CR-001，08-29）：best-effort 全吞——Windows 句柄竞争下 CI 实录
// 重试 3 次仍不够，吞是实证语义（PRD R5 已按此定谳 08-29；非「带一次重试」）。
// force:true 已容忍路径不存在（existsSync 守卫冗余）。注意：清理目标若在仓库
// 工作树内（test-tmp-*），残留会污染 git status——此类目标与合法裸 rmSync 残留
// 的登记见 .trellis/tasks/08-29-ci-stopgap-proper-fixes/research/rm-residue-registry.md。
//
// 形态说明：显式 import（非 setupFiles 全局 patch fs.rmSync——ESM 命名空间
// 绑定 patch 已被证明不可靠，该方案已废弃删除）。确需「失败必须红」的删除
// 语义时直接裸用 rmSync，不走本 helper。
import { rmSync } from 'node:fs';

export function rmBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort：Windows 句柄竞态 EPERM，tmpdir 残留无害 */
  }
}
