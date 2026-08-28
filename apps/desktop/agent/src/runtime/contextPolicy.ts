// ── S4b（task 08-25 design §4.1）：压缩红线策略注入缝 ──
//
// 红线百分比（contextCompaction.redlinePercent）是机器级用户偏好
//（~/.orison/user/preferences.yaml），agent 运行时按 ADR-2 全注入边界不读盘——
// shell（agentIpc）经本 seam 注入一个现读闭包（mirror setTaskSlotResolver 形态：
// 每次装配现取，改红线下一次 send 生效，无需重启）。窗口（contextWindowTokens）
// 不走本缝——它随当前指派模型 limits 在 workflow 装配处现算（resolveModelInfo）。

/** 注入闭包的返回形态：undefined = 未配置/不可用 → runLoop 回落缺省 95%。 */
export type ContextPolicy = { redlinePercent: number };

let _provider: (() => ContextPolicy | undefined) | undefined;

export function setContextPolicyProvider(fn: (() => ContextPolicy | undefined) | undefined): void {
  _provider = fn;
}

/**
 * 现读红线策略。未注入 / 闭包抛错 / 返回缺字段 → undefined（调用方回落缺省）——
 * 偏好读取失败不得阻塞生成主路径。
 */
export function readContextPolicy(): ContextPolicy | undefined {
  try {
    return _provider?.();
  } catch {
    return undefined;
  }
}
