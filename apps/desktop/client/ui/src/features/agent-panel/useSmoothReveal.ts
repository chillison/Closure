import { useEffect, useRef, useState } from 'react';

/**
 * dogfood R2 #11（findings #11④，2026-08-25）：流式出字平滑过渡的 displayLen 动画轨。
 *
 * 问题：MD 快照轨 250ms 整段跳变（「一段一段出的，段内无平滑过渡」）。方案 = 头部 250ms
 * 节流 MD 块 + 尾部逐字生长纯文本（AgentMessageItem 拼装），本 hook 提供中间的
 * **grow-only 渐进长度**：rAF 步进向 target 长度收敛，自适应速率（积压越大越快，
 * ~CATCHUP_MS 内追平当前积压）+ 最小速率保底（追平后新 delta 仍有可感推进）。
 *
 * r4 不变式（**绝不回潮 useTypewriter**）：target 变化绝不重置、绝不回退 displayLen——
 * target 变化触发 index 归零全量重放是 r4 实证过的事故；挂载即取当时 target 全长
 *（流式中途挂载/切回视图不重放既有内容）。
 *
 * 拉满路径（三条，均绕过动画）：
 * - `active` 变 false（终帧/settle）：直接拉满（renderedHtml 收敛前不留尾巴）；
 * - `revealed`（CR-T1-043 直出语义）：拉满且后续每次渲染即时跟随；
 * - prefers-reduced-motion：跳过动画恒全量（dogfood T1 design §7 动效降级惯例）。
 *
 * CR-43（dogfood R2 BMad CR）两项常驻开销治理：
 * - prefersReducedMotion 的 MediaQueryList 模块级缓存（旧实现每渲染 matchMedia 新建，
 *   多消息并行流式时高频）——.matches 活读天然跟随系统偏好变化，无需额外监听器；
 * - 追平后不再每 rAF 空转——拆 rAF 转 SETTLE_POLL_MS 静态轮询查目标增长，新 delta
 *   到达即回 rAF（流式期响应不变，grow-only r4 语义不变）。
 *
 * CR-46（dogfood R2 BMad CR）：displayLen 边界落低代理（代理对中间劈码位）时回退一码位
 * ——emoji/星面字符 reveal 中不渲染替换符（U+FFFD）；回退只影响返回的展示值，状态与
 * 后续帧推进不变（grow-only 不破）。
 */
export type SmoothRevealOptions = {
  /** 动画轨活跃（AgentMessageItem 的 snapshotActive：streaming 或打字机在途）。 */
  active: boolean;
  /** CR-T1-043 直出激活：displayLen 恒贴 target（拉满 + 后续即时跟随）。 */
  revealed?: boolean;
};

/** 积压追平目标时长（ms）——速率 = backlog / CATCHUP_MS，积压越大速率越快。 */
const CATCHUP_MS = 900;
/** 最小速率保底（字/ms，~2 字/帧 @60fps）——小积压时不至于近乎停滞。 */
const MIN_RATE = 0.033;
/** CR-43：追平后的目标增长轮询间隔（ms）——rAF 空转降频为静态轮询。 */
const SETTLE_POLL_MS = 250;

/**
 * jsdom 无 matchMedia（typeof 守卫）——按无偏好处理，测试经手动 rAF 步进驱动动画路径。
 * CR-43：模块级缓存（懒初始化单例）——见 hook 头注释。
 */
let reducedMotionQuery: MediaQueryList | null = null;
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (reducedMotionQuery === null) {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  }
  return reducedMotionQuery.matches;
}

/** CR-46：展示边界避开代理对中间——`target.charCodeAt(len)` 是低代理（0xDC00-0xDFFF）
 * 说明 slice(0, len) 会把一对劈开，回退一码位（该字符本帧不显、下帧越过低代理后补上）。 */
function avoidSplitSurrogate(target: string, len: number): number {
  if (len <= 0 || len >= target.length) return len;
  return (target.charCodeAt(len) & 0xfc00) === 0xdc00 ? len - 1 : len;
}

export function useSmoothReveal(target: string, options: SmoothRevealOptions): number {
  const { active, revealed = false } = options;
  // 挂载即取当时 target 全长（r4 不变式：不重放挂载前的既有内容）。
  const [displayLen, setDisplayLen] = useState(() => target.length);
  const targetRef = useRef(target);
  targetRef.current = target;
  const lenRef = useRef(displayLen);
  lenRef.current = displayLen;

  useEffect(() => {
    // 拉满路径（!active / revealed / reduced-motion）无需时钟，由渲染期覆写承担。
    if (!active || revealed || prefersReducedMotion()) return;
    if (typeof requestAnimationFrame !== 'function') return; // 环境无 rAF：渲染期覆写兜底全量
    let raf = 0;
    let poll = 0;
    let polling = false;
    let last = 0;
    const stopPolling = () => {
      polling = false;
      if (poll !== 0) {
        window.clearInterval(poll);
        poll = 0;
      }
    };
    const step = (time: number) => {
      const targetLen = targetRef.current.length;
      const current = lenRef.current;
      if (current >= targetLen) {
        // CR-43：追平后拆 rAF（旧实现每帧 no-op 回调常驻，并行子 agent 各一条轨时倍增），
        // 转 SETTLE_POLL_MS 轮询查目标增长；新 delta 到达即拆轮询回 rAF。
        raf = 0;
        last = 0;
        if (!polling) {
          polling = true;
          poll = window.setInterval(() => {
            if (!polling) return; // 拆除后残留回调（测试桩清不掉的 id）无害退出
            if (lenRef.current < targetRef.current.length) {
              stopPolling();
              raf = requestAnimationFrame(step);
            }
          }, SETTLE_POLL_MS);
        }
        return;
      }
      raf = requestAnimationFrame(step);
      if (last === 0) {
        last = time; // 停摆后首帧只记时基（elapsed 从下一帧起算）
        return;
      }
      const elapsed = Math.max(time - last, 0);
      last = time;
      const backlog = targetLen - current;
      const rate = Math.max(backlog / CATCHUP_MS, MIN_RATE);
      const next = Math.min(current + Math.max(elapsed * rate, 1), targetLen);
      setDisplayLen(next);
    };
    raf = requestAnimationFrame(step);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      stopPolling();
    };
  }, [active, revealed]);

  // 渲染期覆写：拉满路径不经动画（终帧直出 / reveal 即时跟随 / reduced-motion 全量）。
  if (!active || revealed || prefersReducedMotion()) return target.length;
  // target 收缩防御（append-only 假设被破坏时防切片越界——clamp 展示值，不动状态）。
  return avoidSplitSurrogate(target, Math.min(displayLen, target.length));
}
