/**
 * 08-26 结构页重构 批 5：structure.css 源码级规约锁（CSSLock）。
 *
 * 纯视觉改动（字号地板/网格线退隐/折行 clamp/线聚焦渐变/画布锚点）在 jsdom 里
 * 无 computed-style 断言面——本文件按「样式表字符串断言」先例（chapterWorkbench
 * 的禁 min() 嵌 minmax 守门同款）直接读 structure.css 源码锁定 canonical 规则，
 * 防后续改动无声回退：
 *   - R6 字号地板：--text-3xs/--text-2xs/--text-xs 与 <12px 字面 font-size 全退役
 *     （批 B 扩：rem/em 变相破地板同禁）。
 *   - R5 网格线退隐：--structure-grid-line token 定义（亮暗）+ 行分隔退役。
 *   - #42 卷带标题 wrap + band 最小高 / #44 chip 标题 2 行 clamp。
 *   - #47 线聚焦渐变 ≥1s 挂基础选择器（双向对称）。
 *   - #49 .structure-canvas position:relative；#54 页级单滚容器 + subgrid 链；
 *     #55 钉驻空间前提（骨架链成员不持 width）。
 *   - 批 8：堆叠格封顶家族 / pending sticky-right 组锁 / pending 灰态不透明底 /
 *     泳道线名自然换行 / minimap top+left 双轴锁步 zoombar 高。
 *   - 8.3 语义修订：全量渲染 + 常驻滚轮（pending 变体 max-height 与
 *     pendingStackVisibleCount 推导关系锁）；CR 组 5：因果 pending 变体顶端对齐。
 *   - 批 B（BMad CR 组 3b）：图例切换钮 28px 地板 / 「+N」徽标保留原生 tooltip /
 *     色板三族 × LINE_PALETTE_SIZE 卡数互锁 / chipMaxWidth 镜像态自适应锁。
 *   - T24（发现批11）：章格「＋」钮全族退役（被 T23 装填宽卡遮死——宽卡是别的
 *     槽的 DOM 子元素，被覆盖槽收不到 :hover）——迁章列头与因果区**共用单类**
 *     .narrative-timeline-col-add（默认隐匿不劫持命中 + 两区 hover/焦点显形双路
 *     归还指针 + 宿主锚；旧类名连注释删净负断言）。
 *   - 深夜目检 T4/T8：#68 --folded 族全退役（pending 连线零渲染）；
 *     R7 计数器 absolute 钉非滚动宿主右上角（T8 滚动栈内化——V-F3 sticky 与
 *     T6 负 margin 族退役，零布局脚印 + 零滚动漂移 + pointer-events 放行穿透）。
 *   - T17（用户拍板 re-baseline）：minor 关联线藏/显类族整体退役——弧何时渲染
 *     由 AssocLayer 的 hover∨selected 渲染滤集单源承担，CSS 不持显隐开关。
 *   - 发现批5 T10/T11/T12：续至徽记规则删净（负断言）；把手不可用态置灰
 *     （not-allowed + 显形减半）；resize 预览 z 抬升（3 > chip 族 1/slot chrome 2）。
 *   - 发现批9 T18/T19：静止态宽卡 v2（chip in-flow 内容宽 + 半透明延伸带压底
 *     z:-1，v1 absolute/z:2 全宽卡退役）；hover 高亮外环两选择器（:not(--selected)
 *     守卫）+ 手势期实时宽盒半透明。
 *   - 发现批10 T23：v2 延伸带退役删净（负断言防回魂）+ 装填卡形态锁（--packed
 *     类 position:absolute〔模式归 CSS、值归 inline〕+ 标题 clamp 释放〔完全显示
 *     硬约束〕）+ 章槽 #61 封顶/裁剪退役（行高随轨道自动增长；待编排槽保留）。
 *   - 发现批9 T20/T21：minimap 可见 chrome 小卡（四边框+圆角+不透明实底——防回
 *     退成无框透明浮块）；钉右待编排列 chrome 级左缘分离（叠盖章列头的「挤压」
 *     判读根修）；卷带跨列可读（起点锚 2px + 边界升 outline-variant + 卷名有界
 *     徽标）。
 *
 * 匹配纪律（批 B CR-9）：**先剥块注释再定位规则体**——注释里的示例选择器/失效
 * 规则会造「鬼影规则」（锁住早已删除的东西或被注释里的假块顶替真块）。字号/退
 * 役 token 类负面断言仍对**未剥**原文跑（注释里也不许出现这些遗物，更严）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run structureCssLock`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINE_PALETTE_SIZE } from '../src/features/structure/linePalette';
import { WORKBENCH_GEOMETRY } from '../src/features/structure/workbenchLayout';

// jsdom 环境的全局 URL 非 node URL（readFileSync 收 URL 对象报 scheme 错）——
// 经 fileURLToPath 归一成字符串路径再读。
const cssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/features/structure/structure.css'
);
/** 未剥原文（token/字号类禁令面——注释里出现同样违规）。 */
const rawCss = readFileSync(cssPath, 'utf8');
/** 剥掉块注释（slash-star 包围段）后的源码（规则体定位面——防鬼影规则）。 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
/** z 阶梯单源（scales.css）——T13 钉驻带 token 位次锁的读取面。 */
const scalesCssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/shared/styles/scales.css'
);

/**
 * Extract a **single-selector** rule block body（`.sel { body }` → body；缺省 ''）。
 * 只认「前一非空白字符是 } 或 { 或文件首」的块——防两路误中：
 *   ① 子串（'workbench-band' ≠ 'workbench-volume-tint'；descendant 组合器同理）；
 *   ② 多选择器组的末位成员（#47 渐变组以 `.workbench-lane-label {` 收尾——组内
 *      成员前一非空白字符是 `,`，非独立规则，不遮蔽本选择器自己的规则块）。
 * 输入已剥注释（见上）：注释中的选择器不再可能命中。
 */
function ruleBlock(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\.${esc}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of css.matchAll(re)) {
    const before = css.slice(Math.max(0, m.index! - 200), m.index!);
    const prevNonWs = before.trimEnd().slice(-1);
    if (prevNonWs === '' || prevNonWs === '}' || prevNonWs === '{') {
      return m[1]!;
    }
  }
  return '';
}

/**
 * requireRuleBlock：负断言防空转的 presence 前置（CR-9）。ruleBlock 空串会让一切
 * not.toContain(...) 无声通过（「缺规则」与「规则里没这句」不可分辨）——负断言前
 * 先证明规则在场。全部取块位统一走这里。
 */
function requireRuleBlock(selector: string): string {
  const body = ruleBlock(selector);
  expect(body, `selector .${selector} must exist in structure.css`).not.toBe('');
  return body;
}

/** subgrid 传递链成员组规则块（批 7 共享轨道架构——多处复用同一匹配）。 */
function chainGroupBody(): string | null {
  const m = css.match(/\.structure-skeleton,[\s\S]*?\.workbench-scroll\s*\{([^}]*)\}/);
  return m ? m[1]! : null;
}

describe('structure.css source locks (batch 5)', () => {
  // ── R6 字号地板（AC9：结构页最小字号 ≥12px = --text-sm 级；zoom<1 画布内随缩、
  //    地板按 100% 档衡量——适用域声明见 .structure-page 段头注）──

  it('font floor: text-3xs/2xs/xs tiers fully retired (no font-size below --text-sm)', () => {
    expect(rawCss).not.toContain('var(--text-3xs)');
    expect(rawCss).not.toContain('var(--text-2xs)');
    expect(rawCss).not.toContain('var(--text-xs)');
    // 字面 <12px font-size 同禁（9/10/11px 遗物）——rem/em 变相破地板也禁
    // （0.x rem/em ≈ <12px 的换个量纲写法；正文无合法用例，min-height:3.2em 等
    // 非 font-size 属性不受此锁管辖）。
    expect(rawCss).not.toMatch(/font-size:\s*(?:[89]|10|11)(?:\.\d+)?px/);
    expect(rawCss).not.toMatch(/font-size:\s*0\.[0-6]+\s*(?:rem|em)/);
  });

  it('popover prose line-height ≥1.5 (AC9 抽屉行高)', () => {
    expect(requireRuleBlock('scene-edit-popover')).toContain('line-height: 1.5');
  });

  // ── R5 视觉减法：网格线退隐 + 行分隔退役 ──

  it('grid-line token defined for light + dark themes', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--structure-grid-line:\s*rgba\(30,\s*34,\s*30,\s*0\.05\)/s);
    expect(css).toMatch(/\[data-theme='dark'\]\s*\{[^}]*--structure-grid-line:\s*rgba\(235,\s*240,\s*235,\s*0\.05\)/s);
  });

  it('row separators retired: cell stacks / slots / lane labels carry no border-bottom', () => {
    for (const sel of ['narrative-timeline-cell-stack', 'workbench-slot', 'narrative-timeline-lane-label', 'workbench-lane-label']) {
      const block = requireRuleBlock(sel);
      expect(block, `${sel} rule`).not.toMatch(/border-bottom/);
      expect(block, `${sel} keeps a faint column separator`).toContain('border-right: 1px solid var(--structure-grid-line)');
    }
  });

  // ── #42 卷带：标题换行 + band 高自适应（#56 起不限行数——2 行 clamp 封顶在
  //    band 跨窄列时长卷名尾部省略，用户目检拍翻） ──

  it('volume-band title wraps WITHOUT a line cap; band uses min-height', () => {
    const title = requireRuleBlock('volume-band-title');
    expect(title).not.toContain('-webkit-line-clamp');
    expect(title).toContain('overflow-wrap: anywhere');
    expect(requireRuleBlock('workbench-band')).toContain('min-height: 22px');
    // 恒高退役（负 lookbehind 排除 min-height 自身）。
    expect(requireRuleBlock('workbench-band')).not.toMatch(/(?<!min-)height:\s*22px/);
  });

  // ── #44 → 08-27 R6「全标题」：chip 标题 3 行 clamp（± 退役腾位后不再静置截断）──

  it('workbench chip title: 3-line clamp replaces the single-line ellipsis', () => {
    const title = requireRuleBlock('workbench-chip-title');
    expect(title).toContain('-webkit-line-clamp: 3');
    expect(title).not.toContain('white-space: nowrap');
    expect(title).not.toContain('text-overflow: ellipsis');
  });

  // ── #47 线聚焦渐变：transition 挂基础选择器（≥1s，双向对称）──

  it('line-hover fade rides base selectors at ≥1s (symmetric add/remove)', () => {
    // dim 类自身不带 transition（带 = 撤类瞬跳、加类渐变的不对称老问题）。
    const dim = requireRuleBlock('structure-hover-dim');
    expect(dim).not.toContain('transition');
    // 基础选择器组 + .scene-card 自身规则（与 background 合并声明）均带 ≥1s 渐变。
    const hits = css.match(/opacity 1s var\(--ease-standard\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2); // 组规则 + scene-card 并入
    for (const sel of ['.workbench-chip', '.narrative-edge', '.assoc-link',
      '.narrative-timeline-lane-label', '.workbench-lane-label']) {
      expect(css, `${sel} rides the fade group`).toMatch(
        new RegExp(`${sel.replace(/\./g, '\\.')}[^{]*\\{[^}]*transition:\\s*opacity 1s var\\(--ease-standard\\)`, 's')
      );
    }
    // .scene-card 自身 transition 并入 opacity 分量（组外独立声明）。
    expect(requireRuleBlock('scene-card')).toContain('transition: background var(--duration-fast), opacity 1s var(--ease-standard)');
  });

  // ── T17（08-27 用户拍板 re-baseline）：minor 藏/显类族整体退役——弧何时渲染由
  //    AssocLayer 的 hover∨selected 渲染滤集单源承担（JSX 面），CSS 不再持开关 ──

  it('T17: minor hide/show class family retired — arc visibility is the AssocLayer render gate', () => {
    // 揭示类全串退役（对未剥原文跑：注释样例也不许回来——T4 folded 族同款纪律）。
    expect(rawCss).not.toContain('assoc-link--show');
    // opacity:0 隐匿规则与 dim 复活守卫（blind V-F2，只为防 dim 复活隐匿线——隐匿
    // 态已不存在）一并删净；规则体定位面对注释剥离后跑。
    expect(css).not.toMatch(/\.assoc-link--minor\s*\{/);
    expect(css).not.toMatch(/\.assoc-link--minor\.structure-hover-dim/);
    // paint 面保留项仍在场（退役不误伤：selected 描边 / 倒叙钢蓝 / 渐变 stop 色源）。
    expect(requireRuleBlock('assoc-link--selected')).toContain('stroke-width: 1.25');
    expect(requireRuleBlock('assoc-link--reorder')).toContain('stroke: var(--accent)');
    expect(requireRuleBlock('assoc-stop')).toContain('stop-color: var(--structure-line-color)');
  });

  // ── 5.2 节奏热度：格顶 3px 细条载体 ──

  it('pacing heat renders as a 3px top strip (full-cell wash retired)', () => {
    expect(requireRuleBlock('pacing-heat')).toContain('height: 3px');
  });

  // ── 批 6 目检（#51-#53）──

  it('#51 minimap volume marks: tick only — text label rule retired (轨道窄必糊叠)', () => {
    expect(rawCss).not.toContain('.minimap-volume-mark i');
  });

  it('#52 workbench column title: 2-line clamp replaces the single-line ellipsis', () => {
    const title = requireRuleBlock('workbench-col-title');
    expect(title).toContain('-webkit-line-clamp: 2');
    expect(title).not.toContain('white-space: nowrap');
    expect(title).not.toContain('text-overflow: ellipsis');
  });

  // ── #53 → 批 B CR-11c：chip max-width 双源失锁的真单源化坐标锁 ──
  // TS inline（WorkbenchChip style={{maxWidth}}）是唯一生效路径；CSS 字面是镜像还是
  // 已删取决于并行批次 A 的落地时序——锁按两种状态各自钉死，任一态漂移即爆红。

  it('#53/batch-B chip max-width: CSS literal either mirrors the TS value or is gone', () => {
    const WIDTH = WORKBENCH_GEOMETRY.chipMaxWidth;
    const chipBody = requireRuleBlock('workbench-chip');
    const literalRe = new RegExp(`max-width:\\s*${WIDTH}px`);
    if (literalRe.test(chipBody)) {
      // 镜像态（A 未砍字面）：两处必须等值，改一处必同步另一处（cssLock 兼当同步哨）。
      expect(chipBody).toMatch(literalRe);
      expect(WIDTH, 'TS single-source value pinned').toBe(212);
    } else {
      // 单源态（A 已砍字面）：CSS 不留第二字面（inline 是唯一生效路径——残留即双源复发）。
      expect(chipBody).not.toMatch(/max-width\s*:/);
    }
  });

  // ── 批 6 #54：页级单一横向滚动容器（架构锁——minimap/shift+wheel/上下对照全靠它）──

  it('#54 inner panel scrollers retired (page is the single horizontal scroller)', () => {
    for (const sel of ['narrative-timeline-scroll', 'workbench-scroll']) {
      const block = requireRuleBlock(sel);
      // 批 7：subgrid 传递链成员——横向 padding 禁止（挤占宿主轨道），纵向 12px
      // literal 锁步保留。
      expect(block, `${sel} keeps the 12px vertical lockstep`).toContain('padding: 12px 0');
      expect(block, `${sel} must not steal page scrolling`).not.toMatch(/overflow:\s*(auto|scroll|hidden)/);
    }
  });

  it('#54/batch7 workbench grid rides subgrid tracks (width:max-content era retired)', () => {
    const grid = requireRuleBlock('workbench-grid');
    expect(grid).toContain('grid-template-columns: subgrid');
    expect(grid).toContain('grid-column: 1 / -1');
    expect(grid).not.toContain('width: max-content');
  });

  it('#54-P3 workbench text surfaces ride above assoc lines (z-index: 1)', () => {
    for (const sel of ['workbench-chip', 'workbench-band', 'workbench-col-header', 'workbench-lane-label']) {
      expect(requireRuleBlock(sel), `${sel} above assoc lines`).toContain('z-index: 1');
    }
  });

  // ── 批 7（design §11「同构锁步」）：共享轨道架构的源码锁 ──

  it('batch7 host: .structure-canvas is a min-width-100% padded grid with position:relative', () => {
    const block = requireRuleBlock('structure-canvas');
    expect(block).toContain('display: grid');
    expect(block).toContain('position: relative'); // #49 沿袭（AssocLayer 宿主锚）
    expect(block).toContain('min-width: 100%'); // #55 钉驻空间前提上移
    expect(block).toContain('padding: 12px');
  });

  it('batch7 pass-through chain members all borrow the host tracks (subgrid)', () => {
    // 链成员共享一个分组规则块（structure.css「传递链成员」段）——锁定该块同时
    // 列出全部五个成员并声明 subgrid + 全宽铺。
    const body = chainGroupBody();
    expect(body, 'chain member group rule present').not.toBeNull();
    expect(body).toContain('display: grid');
    expect(body).toContain('grid-template-columns: subgrid');
    expect(body).toContain('grid-column: 1 / -1');
  });

  it('batch7 causal grid + volume band strip ride the same subgrid tracks', () => {
    const grid = requireRuleBlock('narrative-timeline-grid');
    expect(grid).toContain('grid-template-columns: subgrid');
    expect(grid).toContain('grid-column: 1 / -1');
    const strip = requireRuleBlock('volume-band-strip');
    expect(strip).toContain('grid-template-columns: subgrid');
    expect(strip).toContain('grid-column: 1 / -1');
  });

  // ── #55：页级横滚 chrome 钉驻——盒宽给 sticky 腾空间 + 三行钉左 ──

  it('#55 pinning room moved up with the batch-7 shared-track host (skeleton chain carries no width)', () => {
    // 盒宽前提从 .structure-skeleton 上移到宿主（见上方 batch7 host 锁）。骨架盒
    // 是链成员（多选择器组的一员，自身无独立规则块）——原 ruleBlock('.structure-
    // skeleton') 空转锁（空串让 not.toContain 无声通过）修复为对**链组本体**断言：
    // 组内不持 width 声明（= 链上被拉伸到轨道带宽）。
    const body = chainGroupBody();
    expect(body, 'chain member group rule present').not.toBeNull();
    expect(body!).not.toContain('width:');
  });

  it('#55 chrome rows ride sticky-left: title / overlay toggles / legend', () => {
    // 批 8.7 后 minimap 升页级 chrome（top+left 双轴）——双轴锁移入下方 batch 8
    // describe 单测；本组只保留骨架链内钉左行 + 页级 legend。
    for (const sel of ['structure-skeleton-title', 'narrative-timeline-toolbar', 'structure-legend']) {
      const block = requireRuleBlock(sel);
      expect(block, `${sel} position`).toContain('position: sticky');
      expect(block, `${sel} pinned to viewport left`).toContain('left: 0');
      expect(block, `${sel} above sliding content`).toContain('z-index');
    }
    // 骨架链内两行（title/toggles）：行盒必须窄于包含块（fit-content），否则块级
    // stretch 拉成同宽 → sticky 零滑动余量照旧失灵（#55 实测两连坑）。legend 是
    // 页面直子元素（zoombar 特权路径），无需此约束。
    for (const sel of ['structure-skeleton-title', 'narrative-timeline-toolbar']) {
      expect(requireRuleBlock(sel), `${sel} narrower than containing block`).toContain('width: fit-content');
    }
  });
});

// ── 批 8（08-26 晚第二批目检细化）+ 批 B 补丁源码锁 ──

describe('structure.css source locks (batch 8)', () => {
  it('#61/8.3 collision stacks stay capped; causal stack clips via x-axis clip + bleed margin', () => {
    // 工作台 slot：chip 无出卡角标，常规整盒裁切即可。
    const slot = requireRuleBlock('workbench-slot');
    expect(slot, 'slot cap').toContain('max-height: 280px');
    expect(slot, 'slot clips until hover/focus').toContain('overflow: hidden');
    // 因果 stack（批 B CR-2 等价方案）：角标悬出卡缘需要横向放行——x clip +
    // overflow-clip-margin（clip 不产生滚动容器；y 保持 hidden 由揭示组接管），
    // 名义几何（cellStackPadding=4 镜像）零漂移。
    const stack = requireRuleBlock('narrative-timeline-cell-stack');
    expect(stack, 'stack cap').toContain('max-height: 280px');
    expect(stack, 'stack clips horizontally via clip').toContain('overflow-x: clip');
    expect(stack, 'stack bleed room for card corner badges').toContain('overflow-clip-margin: 8px');
    expect(stack, 'stack clips vertically until hover/focus').toContain('overflow-y: hidden');
    // 整盒 shorthand 禁止回归（会把横向放行一并裁掉）。
    expect(stack, 'no full-box overflow shorthand').not.toMatch(/overflow:\s/);
    // #61 hotfix 的揭示规则批 8.3 扩了 :focus-within——四成员一组，锁组本体。
    const reveal = css.match(
      /\.narrative-timeline-cell-stack:hover,\s*\n\.narrative-timeline-cell-stack:focus-within,\s*\n\.workbench-slot:hover,\s*\n\.workbench-slot:focus-within\s*\{[^}]*overflow-y:\s*auto/
    );
    expect(reveal, 'hover/focus-within scroll reveal group present').not.toBeNull();
  });

  it('8.2 pending column pinned right: single-class group lock (.structure-pin-right)', () => {
    // 钉右组的唯一声明块——成员靠 JSX 挂同一类（组件测试断言五面齐挂），这里锁类
    // 本体的 sticky/right/z 三件套；晚于既有 position:relative 规则的级联位置由
    // 「文件尾段」约定维持（见 CSS 批 8 段头注）。
    const m = css.match(/\.structure-pin-right\s*\{([^}]*)\}/);
    expect(m, 'pin-right group block present').not.toBeNull();
    const body = m![1]!;
    expect(body).toContain('position: sticky');
    expect(body).toContain('right: 0');
    expect(body).toContain('z-index: var(--z-sticky)');
  });

  it('8.2 pending greys are OPAQUE (pinned rail must not see through sliding columns)', () => {
    for (const sel of ['narrative-timeline-cell-stack--pending', 'workbench-slot--pending']) {
      const block = requireRuleBlock(sel);
      expect(block, `${sel} backing`).toContain('--surface-container-lowest');
      expect(block, `${sel} no longer transparent-mixed`).not.toMatch(/4%,\s*transparent/);
    }
  });

  it('8.6 lane names wrap naturally on both zones (nowrap/ellipsis retired)', () => {
    for (const sel of ['narrative-timeline-lane-name', 'workbench-lane-name']) {
      const block = requireRuleBlock(sel);
      expect(block, `${sel} no nowrap`).not.toContain('white-space: nowrap');
      expect(block, `${sel} no ellipsis`).not.toContain('text-overflow');
      expect(block, `${sel} CJK-safe wrapping`).toContain('overflow-wrap: anywhere');
    }
  });

  it('8.7 minimap pins BOTH axes: top locksteps the zoombar height (32px), left keeps viewport-edge pinning', () => {
    expect(requireRuleBlock('structure-zoombar')).toContain('height: 32px');
    const mm = requireRuleBlock('timeline-minimap');
    expect(mm).toContain('position: sticky');
    expect(mm).toContain('top: 32px'); // 与 zoombar 高度锁步（改一处必同步另一处）
    // T20（发现批9）：钉左 inset 由 0 改 --space-lg（12px）——可见小卡形态的视口
    // 左缘呼吸（zoombar padding-left 同列对齐）。仍是左轴钉驻（横滚恒可 seek），
    // inset 值非 0 不改变「钉左」性质。
    expect(mm).toContain('left: var(--space-lg)');
    expect(mm).toContain('width: fit-content'); // sticky 余量前提随迁页面直子仍成立
    expect(mm).toContain('z-index');
  });

  it('batch-B legend toggle hits the R6 28px hit-area floor', () => {
    expect(requireRuleBlock('structure-legend-toggle')).toContain('height: 28px');
  });

});

// ── 8.3 语义修订 + #63（08-27 用户拍板）→ 批 B 推导关系锁 ──

describe('structure.css source locks (8.3 revised semantics)', () => {
  /**
   * 从块体抽 max-height px 数值（无 → NaN，由调用方断言显式失败）。
   */
  function maxHeightPx(body: string): number {
    return Number(body.match(/max-height:\s*(\d+)px/)?.[1] ?? Number.NaN);
  }

  it('pending stacks: capped at visible-count height with ALWAYS-on wheel scroll', () => {
    // 用户否决「只渲染前 N 张」——堆全量渲染，折叠部分靠滚动可达；
    // 封顶字面 = 枚数×卡高+gap+padding（workbenchLayout 注释锚定公式）。
    // T8 滚动栈内化：pending-overflow 变体类挂内层滚动栈（宿主非滚动——计数器
    // 的 absolute 定位锚），选择器随之重定域。
    const causal = css.match(/\.narrative-timeline-pending-stack\.pending-overflow\s*\{([^}]*)\}/);
    expect(causal, 'causal pending variant block').not.toBeNull();
    expect(causal![1]).toContain('overflow-y: auto');
    const workbench = css.match(/\.workbench-pending-stack\.pending-overflow\s*\{([^}]*)\}/);
    expect(workbench, 'workbench pending variant block').not.toBeNull();
    expect(workbench![1]).toContain('overflow-y: auto');
    // 宿主级旧选择器已随内化退役（死规则删不留档）。
    expect(css).not.toMatch(/\.narrative-timeline-cell-stack\.pending-overflow\s*\{/);
    expect(css).not.toMatch(/\.workbench-slot\.pending-overflow\s*\{/);

    // 批 B CR-11b 镜像锁：封顶数值与 WORKBENCH_GEOMETRY.pendingStackVisibleCount
    // 的推导关系（卡高名义近似——改枚数须按公式同步 CSS 字面，反之亦然）。
    const count = WORKBENCH_GEOMETRY.pendingStackVisibleCount;
    // 因果卡名义卡高 50（.scene-card min-height）+ 名义余量 16（2×gap4+2×pad4）。
    expect(maxHeightPx(causal![1])).toBe(count * 50 + 16);
    // 工作台 chip 名义 26px 高留两行 clamp 余量（≥ 三枚下限 + 余量族；远小于满额
    // 卡高封顶——8.3 注「~26×3+2×2+8≈90 → 取 120」的有界区间锁定）。
    const wbH = maxHeightPx(workbench![1]);
    expect(wbH).toBeGreaterThanOrEqual(count * 26 + 8);
    expect(wbH).toBeLessThan(count * 50);
  });

  it('batch-B causal pending variant aligns content to the top (centered baseline scrolls unreachable)', () => {
    const causal = css.match(/\.narrative-timeline-pending-stack\.pending-overflow\s*\{([^}]*)\}/);
    expect(causal, 'causal pending variant block').not.toBeNull();
    expect(causal![1]).toContain('justify-content: flex-start');
  });

  it('T8 inner pending stacks exist and mirror their host layout literals (wrap row / centered column)', () => {
    // 内层滚动栈在场 + 布局字面镜像宿主基类——≤3 枚未溢出态视觉与内化前一致。
    const wb = requireRuleBlock('workbench-pending-stack');
    expect(wb).toContain('display: flex');
    expect(wb).toContain('flex-wrap: wrap');
    expect(wb).toContain('gap: 2px'); // 镜像 .workbench-slot gap 字面
    expect(wb).toContain('width: 100%'); // wrap 行占满整行
    const causal = requireRuleBlock('narrative-timeline-pending-stack');
    expect(causal).toContain('flex-direction: column');
    expect(causal).toContain('justify-content: center'); // ≤3 枚居中——镜像宿主基类
    expect(causal).toContain('gap: 4px'); // 镜像 .narrative-timeline-cell-stack gap 字面
    // 渐隐伪元素随滚动栈内迁（::after 的定位锚 = 内层 position:relative）。
    expect(css).toMatch(
      /\.narrative-timeline-pending-stack\.pending-overflow::after,\s*\n\.workbench-pending-stack\.pending-overflow::after\s*\{/
    );
  });

});

// ── 08-27 结构页修复第三轮（Wave1 V 片）源码锁 ──

describe('structure.css source locks (08-27 round 3)', () => {
  // ── R3/#69 chrome 恒驻：zoombar 双轴锁（深滚失效根修——top 轴此前缺省）──

  it('R3 zoombar pins BOTH axes: top:0 engages vertical pinning; left keeps edge pinning', () => {
    const zb = requireRuleBlock('structure-zoombar');
    expect(zb, 'position').toContain('position: sticky');
    expect(zb, 'vertical pin (deep-scroll fix)').toContain('top: 0');
    expect(zb, 'horizontal pin').toContain('left: 0');
    expect(zb, 'height lockstep base for minimap top:32px').toContain('height: 32px');
    expect(zb, 'above sliding content').toContain('z-index');
  });

  // ── C1 真机遍历 T2（发现批 2）：.structure-page 纵向滚动口必须「活」——#69
  //    chrome 恒驻根修第二层（zoombar top:0 只是声明轴，scrollport 死活在此锁）──

  it('T2 page scroller stays LIVE: height-constrained overflow port (dead-port regression lock)', () => {
    const page = requireRuleBlock('structure-page');
    // #54 单一横向滚动容器架构保留——shift+wheel/minimap/AssocLayer/pin-right 的
    // scrollLeft 契约全在此层，拔掉 overflow 即断这批 tsx 契约。
    expect(page, '#54 single horizontal scroller retained').toContain('overflow: auto');
    // 纵滚口「活」的前提：宿主 .workspace-panel-content（workspace.css）是块级滚动
    // 口，flex:1/min-height:0 在块级父下惰性——无 height 约束时页盒高度 auto 随内容
    // 增长，真实纵滚落外层、自身 scrollTop 恒 0 = 死滚动口 → sticky top 钉在永不
    // 滚动的 scrollport 上（深滚 chrome 消失 + topChromeFloor 深负值连带）。
    expect(page, 'height keeps the page the real scroller').toContain('height: 100%');
    // 两轴分离禁令（CSS 规范：一轴 auto/scroll/hidden 把另一轴的 visible 算成
    // auto、clip 算成 hidden）——任何 longhand 绕法都让死纵滚口或隐藏捕获口复发，
    // shorthand 是唯一合法形态。
    expect(page, 'no per-axis overflow gymnastics').not.toMatch(/overflow-[xy]\s*:/);
  });

  // ── #75 异色渐变：stop 色源 token-only 锁 ──

  it('#75 assoc-stop consumes the line-color token only (no literal colors in the mount)', () => {
    const stop = requireRuleBlock('assoc-stop');
    expect(stop).toContain('stop-color: var(--structure-line-color)');
    expect(stop, 'token-only discipline').not.toMatch(/#[0-9a-fA-F]{3,8}\b|hsl\(|rgb\(/);
  });

  // ── 深夜目检 T4：#68 折叠家族整体退役（pending 连线一律零渲染——无隐匿成员可折）──

  it('T4: .assoc-link--folded family fully retired (pending links render zero, nothing to fold)', () => {
    // pending 方向关联线不渲染后折叠显隐族零消费者——规则、注释提及都不许回来
    // （对未剥原文跑：连「鬼影规则」的注释样例也不留）。
    expect(rawCss).not.toContain('assoc-link--folded');
  });

  // ── R6 形状重铸：chip 并入直角矩形卡族（胶囊退役）──

  it('R6 chip joins the rectangular card family (--radius-sm); capsule + span asymmetry retired', () => {
    const chip = requireRuleBlock('workbench-chip');
    expect(chip).toContain('border-radius: var(--radius-sm)');
    expect(chip, 'capsule radius retired').not.toContain('var(--radius-pill)');
    // 跨章「左直角右圆」不对称形状轴退役（跨章语义由延伸带 + 卡形态承载——T18）。
    expect(css, 'span variant carries no capsule/shape rules (v1 position/z rule retired in T18)').not.toMatch(
      /\.workbench-chip--span\s*\{[^}]*border-radius/
    );
  });

  // ── R7/R12/R6 样式钩段（类名 = G 片挂载点协作契约——锁在场与关键形态）──

  it('R7/T8 lane counter: absolute pinned to the NON-SCROLLING host top-right (drift-free by structure)', () => {
    const counter = requireRuleBlock('lane-pending-counter');
    // T8 根修（发现批4）：滚动栈内化后宿主非滚动——absolute 钉右上角＝零布局
    // 脚印 + 零滚动漂移。V-F3 的 sticky 方案与 T6 的负 margin 抵消族随之退役。
    expect(counter).toContain('position: absolute');
    expect(counter).toContain('top: 2px');
    expect(counter).toContain('right: 2px'); // 右上角口径（sticky 时代的「right 禁令」随定位法退役）
    // z 高于滚入的卡/chip（z-index:1 族）——钉驻读数不被滚动内容盖掉。
    expect(counter).toContain('z-index: 2');
    expect(counter).toContain('font-variant-numeric: tabular-nums');
    // 宿主锚（T24 槽位钮退役后，本 position:relative 的唯一消费者即计数器）：
    // 无锚则 absolute 落 canvas 祖先。
    expect(requireRuleBlock('workbench-slot')).toContain('position: relative');
  });

  it('T8: counter carries ZERO layout footprint — T6 negative-margin family fully retired', () => {
    // sticky 仍在流内的缺陷由「absolute + 不进滚动层」根除——负 margin 抵消族与
    // 其行高单源 var 是形态遗物，源码里不许回来（删不留档）。
    expect(rawCss).not.toContain('--lane-pending-counter-h');
    const counter = requireRuleBlock('lane-pending-counter');
    expect(counter).not.toMatch(/margin/);
    // 浮层压卡不挡交互：非交互件 pointer-events:none 放行点击穿透到卡/chip。
    expect(counter).toContain('pointer-events: none');
    // 两区规则合一：分区覆盖选择器（align-self/margin-left:auto 族）零残留——
    // 单一声明块承载两区「宿主右上角小徽标」形态。
    expect(css).not.toMatch(/\.narrative-timeline-cell-stack \.lane-pending-counter\s*\{/);
    expect(css).not.toMatch(/\.workbench-slot \.lane-pending-counter\s*\{/);
  });

  it('R12 empty-slot note fades by default and lifts on hover/focus browse', () => {
    const note = requireRuleBlock('workbench-slot-empty-note');
    expect(note).toContain('opacity: 0.5');
    const lift = css.match(
      /\.workbench-slot:hover \.workbench-slot-empty-note,\s*\n\.workbench-slot:focus-within \.workbench-slot-empty-note\s*\{([^}]*)\}/
    );
    expect(lift, 'hover/focus lift group present').not.toBeNull();
    expect(lift![1]).toContain('opacity: 0.9');
  });

  it('T24: slot ＋ family fully retired (killed by packed wide cards — moved to col headers)', () => {
    // 对未剥原文跑：类名连注释都不许回来（删不留档——T4 folded 族同款纪律）。
    expect(rawCss).not.toContain('workbench-slot-add');
  });

  it('T24: col-header ＋ shared single class across zones — hidden+no-hit by default, two-zone hover/focus reveal', () => {
    // 单类两区共用（勿造平行类）：基形态 + 显隐纪律只长在 .narrative-timeline-col-add
    // 一处。锁小钮形态在场 + 默认隐匿且不劫持命中（opacity 0 不挡 hit-testing，
    // pointer-events:none 防隐形钮劫持列头面点击与 drop 准入）+ 显形组一并归还指针。
    const add = requireRuleBlock('narrative-timeline-col-add');
    expect(add).toContain('opacity: 0');
    expect(add).toContain('pointer-events: none');
    expect(add).toContain('transition: opacity var(--duration-fast)');
    // 两区宿主锚（absolute 钮的定位面——无锚则落到 canvas 祖先，pending 计数器
    // 三轮 CR 同款教训）。工作台侧并进主规则块（首块即含）；因果侧锚是 SP-1 段
    // 的独立小规则（主规则在前——ruleBlock 取首块不含 position，按规则形匹配）。
    expect(requireRuleBlock('workbench-col-header')).toContain('position: relative');
    expect(css).toMatch(/\.narrative-timeline-col-header\s*\{\s*position:\s*relative;\s*\}/);
    // 显形组三路：因果列头 hover + 工作台列头 hover + 钮自身 focus-visible（键盘）。
    const reveal = css.match(
      /\.narrative-timeline-col-header:hover \.narrative-timeline-col-add,\s*\n\.workbench-col-header:hover \.narrative-timeline-col-add,\s*\n\.narrative-timeline-col-add:focus-visible\s*\{([^}]*)\}/
    );
    expect(reveal, 'two-zone hover + focus reveal group present').not.toBeNull();
    expect(reveal![1]).toContain('opacity: 1');
    expect(reveal![1]).toContain('pointer-events: auto');
  });

  it('R6 edge-handle heat zones: ~6px inset strips revealed on chip hover only (transition-driven)', () => {
    const edge = requireRuleBlock('workbench-chip-handle');
    expect(edge).toContain('width: 6px');
    expect(edge).toContain('cursor: ew-resize');
    expect(edge).toContain('opacity: 0');
    expect(edge).toContain('transition: opacity');
    const reveal = css.match(
      /\.workbench-chip:hover \.workbench-chip-handle,\s*\n\.workbench-chip-handle:focus-visible\s*\{([^}]*)\}/
    );
    expect(reveal, 'hover reveal group present').not.toBeNull();
    expect(reveal![1]).toContain('opacity: 0.55');
    // 两枚边缘把手（起点/终点）各自靠边。
    expect(requireRuleBlock('workbench-chip-handle--left')).toContain('left: 0');
    expect(requireRuleBlock('workbench-chip-handle--right')).toContain('right: 0');
  });

  // ── T11/T12（发现批5 深夜三轮）：把手恒渲染置灰 + resize 预览 z 抬升 ──

  it('T11: disabled edge handles stay revealed-but-dimmed with not-allowed cursor', () => {
    // 恒渲染后不可用态 = 置灰视觉（专用显形组压过通用 0.55 组——特异性 (0,4,0)>
    // (0,3,0) 双保险由级联位置补足），说明文案归 chip 侧 title（非本层职责）。
    const disabled = requireRuleBlock('workbench-chip-handle--disabled');
    expect(disabled).toContain('cursor: not-allowed');
    expect(disabled).not.toContain('ew-resize');
    const dim = css.match(
      /\.workbench-chip:hover \.workbench-chip-handle--disabled,\s*\n\.workbench-chip-handle--disabled:focus-visible\s*\{([^}]*)\}/
    );
    expect(dim, 'disabled reveal group present').not.toBeNull();
    expect(dim![1]).toContain('opacity: 0.28'); // 显形亮度减半（0.55 / 2）
  });

  it('T12: resizing preview rides above the chip family (z lift present)', () => {
    // 拖动生长的预览此前与 chip 族同层（z:1）被邻格 chip 覆盖（「拖动没效果」体感
    // 根因）。抬至 3：chip 族 z:1 与 slot 级 chrome z:2 之上，sticky(20)/overlay(100)
    // 族之下——预览浮于卡面但不盖真浮层。
    const resizing = requireRuleBlock('workbench-chip--resizing');
    expect(resizing).toContain('z-index: 3');
    // 预览描边仍为虚线示意（拖动生长的视觉载体）。
    expect(resizing).toContain('outline: 1px dashed');
    // 续至徽记规则随 T10 退役删净（删不留档——含注释面）。
    expect(rawCss).not.toContain('workbench-chip-cont');
  });

  // ── T13（发现批6·真机红）：滚动态 zoombar 被内容层遮蔽——钉驻带层叠链锁 ──

  it('T13: page chrome band outranks ALL in-page content (own z tier above sticky, below overlays)', () => {
    // 根因（真机取证 + 层叠链分析）：zoom=1（computed 1 不建 stacking context）时
    // canvas 后代 sticky 成员（legend/骨架标题/工具栏/corner——z 同为 --z-sticky、
    // DOM 序在后）与 zoombar 同处 .workspace-shell 的 stacking context，同层按 DOM
    // 序绘制 → 滚动穿带成员盖住钉驻带（不透明白底连按钮一起盖死——scrollTop
    // 80-240 实测 elementsFromPoint 序）。修法 = 带成员独立抬 --z-page-chrome。
    for (const sel of ['structure-zoombar', 'timeline-minimap']) {
      const block = requireRuleBlock(sel);
      expect(block, `${sel} rides the dedicated chrome tier`).toContain('z-index: var(--z-page-chrome)');
      // 不再与内容 sticky 平级（回退即复发「同层后序胜」）。
      expect(block, `${sel} must not tie with content sticky`).not.toContain('z-index: var(--z-sticky)');
    }
    // token 阶梯锁（scales.css 单源）：内容 sticky < chrome 带 < 真浮层 popover 族
    // （带成员必须全页内容之上、浮层之下——越界任一侧都是回归）。
    const scales = readFileSync(scalesCssPath, 'utf8');
    const zOf = (name: string) =>
      Number(scales.match(new RegExp(`--${name}:\\s*(\\d+)`))?.[1] ?? Number.NaN);
    const chrome = zOf('z-page-chrome');
    expect(chrome, '--z-page-chrome defined numerically in scales.css').toBeGreaterThan(0);
    expect(chrome, 'band above ALL in-page sticky content').toBeGreaterThan(zOf('z-sticky'));
    expect(chrome, 'band below real overlays (popover/menu family)').toBeLessThan(zOf('z-panel-overlay'));
  });

  it('T15: live-widen lift — resizing chip goes absolute; host slot unclips during gesture', () => {
    // 手势期卡体脱流抬升（absolute + 实测列盒 inline 宽——width/margin-left 归
    // chip 侧 inline 驱动，maxWidth 'none' 同侧；CSS 面锁抬升形态本体）。
    const resizing = requireRuleBlock('workbench-chip--resizing');
    expect(resizing).toContain('position: absolute');
    // 宿主槽解裁剪（:has 门控，仅手势期）：overflow:hidden 基线（#61 堆积封顶族）
    // 会把跨列宽的变宽卡剪回单列宽——「拖了没反应」死观感回归。hover/:focus-within
    // 变体同组在场（overflow-y:auto 会把另一轴 visible 降级回 auto 再裁剪）。
    const unclip = css.match(
      /\.workbench-slot:has\(\s*>\s*\.workbench-chip--resizing[^{]*\{([^}]*)\}/
    );
    expect(unclip, 'slot :has() unclip group present').not.toBeNull();
    expect(unclip![1]).toContain('overflow: visible');
    expect(css.match(/\.workbench-slot:has\(\s*>\s*\.workbench-chip--resizing\):hover/g)).not.toBeNull();
    expect(css.match(/\.workbench-slot:has\(\s*>\s*\.workbench-chip--resizing\):focus-within/g)).not.toBeNull();
  });

  it('T23: span band retired; packed chip absolute via class; span variant stays selector-anchor only', () => {
    // v2 延伸带退役删净（删不留档——对未剥原文跑：注释面也不许回魂）。
    expect(rawCss).not.toContain('workbench-chip-span-band');
    // 装填卡定位模式归 CSS 类（坐标值归 chip inline——归属说明见规则注释）。
    const packed = requireRuleBlock('workbench-chip--packed');
    expect(packed).toContain('position: absolute');
    // 装填卡标题 3 行 clamp 释放（完全显示=硬约束——行数随卡宽自然解，两遍法承担）。
    // display: block——脱离 -webkit-box clamp 载体，兼使标题盒高=纯文本高度（settle
    // 实测面的 CSS 半边，不动点纪律）。
    const packedTitle = css.match(
      /\.workbench-chip--packed \.workbench-chip-title\s*\{([^}]*)\}/
    );
    expect(packedTitle, 'packed title clamp-release rule present').not.toBeNull();
    expect(packedTitle![1]).toContain('display: block');
    expect(packedTitle![1]).toContain('-webkit-line-clamp: unset');
    expect(packedTitle![1]).toContain('overflow: visible');
    // span 变体自身零规则块（纯选择器锚——v1/T18/T23 任何形态规则都不落此位）。
    expect(css, 'span variant carries no rule body (selector anchor only)').not.toMatch(
      /\.workbench-chip--span\s*\{/
    );
    // 常驻解裁剪两态保留（装填宽卡伸出槽仍需）。
    const spanUnclip = css.match(
      /\.workbench-slot:has\(\s*>\s*\.workbench-chip--span[^{]*\{([^}]*)\}/
    );
    expect(spanUnclip, 'span host unclip group present').not.toBeNull();
    expect(spanUnclip![1]).toContain('overflow: visible');
    expect(css.match(/\.workbench-slot:has\(\s*>\s*\.workbench-chip--span\):hover/g)).not.toBeNull();
    expect(css.match(/\.workbench-slot:has\(\s*>\s*\.workbench-chip--span\):focus-within/g)).not.toBeNull();
    // z 阶梯沿用：chip 族 1 < 手势预览 3（装填卡同族 z:1，天际线构造性无重叠）。
    expect(requireRuleBlock('workbench-chip')).toContain('z-index: 1');
    expect(requireRuleBlock('workbench-chip--resizing')).toContain('z-index: 3');
  });

  it('T23: chapter slots grow unbounded (skyline lane height) — #61 cap retired outside pending', () => {
    const m = css.match(/\.workbench-slot:not\(\.workbench-slot--pending\)\s*\{([^}]*)\}/);
    expect(m, 'chapter-slot unbounded rule present').not.toBeNull();
    expect(m![1]).toContain('max-height: none');
    expect(m![1]).toContain('overflow: visible');
    // 基线族（max-height 280 / overflow hidden）仍由 #61 锁持有——待编排槽消费面
    // （内层 .workbench-pending-stack 自有封顶/滚轮，外层基线不再实际约束章槽）。
    expect(requireRuleBlock('workbench-slot')).toContain('max-height: 280px');
    expect(requireRuleBlock('workbench-slot')).toContain('overflow: hidden');
  });

  it('T19: hover highlight rings on chip + scene-card (:not(--selected) guard) + semi-transparent resizing box', () => {
    // 发现批9 判读「弧出现了但悬停的卡无高亮、弧无方向」——归属可读两半：卡面
    // hover 外环（零 JS，本锁）；线面端点圆点/因果箭头归 AssocLayer/EdgeLayer JSX。
    const chipRing = css.match(
      /\.workbench-chip--clickable:not\(\.workbench-chip--selected\):hover\s*\{([^}]*)\}/
    );
    expect(chipRing, 'chip hover ring rule present').not.toBeNull();
    // 08-28 终读修：1px@55% 在截图里像素级不可见（归属功能失效）——升 2px@85%；
    // 与 selected 的区分改由「透明度 vs 实色暗化 + offset 1 vs 2」承载。
    expect(chipRing![1]).toContain('outline: 2px solid');
    expect(chipRing![1]).toContain('outline-offset: 1px');
    const cardRing = css.match(
      /\.scene-card--clickable:not\(\.scene-card--selected\):hover\s*\{([^}]*)\}/
    );
    expect(cardRing, 'scene-card hover ring rule present').not.toBeNull();
    expect(cardRing![1]).toContain('outline: 2px solid');
    expect(cardRing![1]).toContain('outline-offset: 1px');
    // selected 外环保持更重（2px 实色）——hover 退一档可区分，且 :not 守卫使选中
    // 态不被悬停覆写（选中语义不侵）。
    expect(requireRuleBlock('workbench-chip--selected')).toContain('outline: 2px solid');
    expect(requireRuleBlock('scene-card--selected')).toContain('outline: 2px solid');
    // T18 v2 连带：手势期实时宽盒半透明（虚线轮廓保留——T12 锁仍钉 dashed）。
    expect(requireRuleBlock('workbench-chip--resizing')).toContain('opacity: 0.6');
  });

  // ── 发现批9 T20：minimap 可见 chrome 小卡（双段判读一致定罪「无框浅色条」）──

  it('T20: minimap is a visible card — full border + radius + OPAQUE surface (frameless translucent slab retired)', () => {
    const mm = requireRuleBlock('timeline-minimap');
    // 四边完整描边（chrome 级 outline-variant）——旧 border-bottom 单边是「无框」的根。
    expect(mm).toContain('border: 1px solid var(--outline-variant)');
    // 圆角小卡形态在场。
    expect(mm).toContain('border-radius');
    // 不透明实底：滚动行标签从卡下穿过被干净遮断（「文字透叠」禁令）——透明/半透明
    // 底（含 color-mix transparent 族）都算回退成透明浮块。
    expect(mm).toContain('background: var(--surface-container-low)');
    expect(mm).not.toMatch(/transparent/);
    // 单边 border-bottom 形态退役（防悄悄降回「一条横线都不全」的无框浅条）。
    expect(mm).not.toMatch(/border-bottom:/);
  });

  // ── 发现批9 T21：列头挤压族（钉驻覆盖的视觉分离 + 卷带跨列可读）──

  it('T21a: pinned rail carries chrome-grade left separation — overlay reads as a panel, not colliding headers', () => {
    // 根因（Electron 138 实测）：sticky right:0 的不透明待编排列叠盖最右可见章列头，
    // 唯一边缘是 5% 网格线（不可见）→ 判读「三个列头标挤在一团互相碰」。修 = 左缘
    // outline-variant 描边 + 左向阴影（面板读法）；钉右组三件套本体（sticky/right/z）
    // 由批 8 锁另钉，此处只锁新增分离面。
    const m = css.match(/\.structure-pin-right\s*\{([^}]*)\}/);
    expect(m, 'pin-right group block present').not.toBeNull();
    expect(m![1]).toContain('border-left: 1px solid var(--outline-variant)');
    expect(m![1]).toContain('box-shadow');
  });

  it('T21b: volume band span is READABLE — start anchor stripe + bounded title chip + visible boundary', () => {
    // 判读双报「卷标浮签贴在单列而非跨列」的根因：band 体色 6% + 边界 5% 隐线 +
    // 卷名裸文本左缘无界——跨列范围不可读。修 = 起点锚（左缘 2px）+ chrome 级右
    // 边界 + 卷名有界徽标（底色/描边/圆角）。两区共用 .volume-band = 单源，改
    // 一处两区同形。
    const band = requireRuleBlock('volume-band');
    expect(band).toContain('border-left: 2px solid var(--outline-variant)');
    expect(band).toContain('border-right: 1px solid var(--outline-variant)');
    expect(band).not.toContain('border-right: 1px solid var(--structure-grid-line)');
    const title = requireRuleBlock('volume-band-title');
    expect(title).toContain('border: 1px solid var(--outline-variant)');
    expect(title).toContain('border-radius');
    expect(title).toContain('background: var(--surface-container-low)');
    // 换行语义不回退（#56 撤钳保持——长卷名 wrap，徽标随长）。
    expect(title).toContain('overflow-wrap: anywhere');
    expect(title).not.toContain('-webkit-line-clamp');
  });
});

// ── 发现批10 T25/T26（多线实例）：拷贝静态标记 + 兄弟柔光源码锁 ──

describe('structure.css source locks (T25/T26 multi-line instances)', () => {
  it('T26 ②: chip ordinal carries the multiline double ring (box-shadow spread, token-only)', () => {
    const ring = requireRuleBlock('workbench-chip-ord--multiline');
    // 双环 = 实底圆号（基类）+ 1px spread 环（本类）；spread 随 border-radius 圆形走。
    expect(ring).toContain('box-shadow: 0 0 0 1px');
    expect(ring).toContain('color-mix(in oklab, var(--structure-line-color) 55%, transparent)');
    // token-only：无字面色。
    expect(ring).not.toMatch(/#[0-9a-fA-F]{3,8}\b|hsl\(|rgb\(/);
  });

  it('T26 ②: scene-card multiline echo stripe mirrors the ::before bar geometry', () => {
    const m = css.match(/\.scene-card--multiline::after\s*\{([^}]*)\}/);
    expect(m, 'echo stripe rule present').not.toBeNull();
    expect(m![1]).toContain('width: 1px');
    expect(m![1]).toContain('color-mix(in oklab, var(--structure-line-color) 55%, transparent)');
    // 与 ::before 同几何域（top/bottom 沿用 space-2xs——镜像左线色条）。
    expect(m![1]).toContain('top: var(--space-2xs)');
    expect(m![1]).toContain('bottom: var(--space-2xs)');
  });

  it('T26 ②: sibling soft-lit rides :not(:hover):not(--selected) guards — lighter than the hover ring', () => {
    // 悬停者自身退让（hover 外环 2px@85% 不被 1px@55% 覆盖）+ 选中语义不侵
    // （T19 双守卫同纪律）。两区（chip/卡）同款。
    const chip = css.match(
      /\.workbench-chip--sibling-lit:not\(:hover\):not\(\.workbench-chip--selected\)\s*\{([^}]*)\}/
    );
    expect(chip, 'chip sibling-lit rule present').not.toBeNull();
    expect(chip![1]).toContain('outline: 1px solid');
    const card = css.match(
      /\.scene-card--sibling-lit:not\(:hover\):not\(\.scene-card--selected\)\s*\{([^}]*)\}/
    );
    expect(card, 'scene-card sibling-lit rule present').not.toBeNull();
    expect(card![1]).toContain('outline: 1px solid');
  });
});

// ── 批 B CR-11a：色板三族 × LINE_PALETTE_SIZE 卡数互锁（镜像声明的可执行化）──

describe('structure.css palette mirror locks (batch B)', () => {
  /** 抽正则捕获组下标集（升序去重）。 */
  function indices(re: RegExp): number[] {
    return [...new Set([...css.matchAll(re)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  }

  const fullRange = Array.from({ length: LINE_PALETTE_SIZE }, (_, i) => i);

  it('--viz-line-* variables: exactly LINE_PALETTE_SIZE hues per theme branch (light + dark)', () => {
    const all = [...css.matchAll(/--viz-line-(\d+)\s*:/g)].map((m) => Number(m[1]));
    expect(all, 'light + dark branches combined').toHaveLength(LINE_PALETTE_SIZE * 2);
    expect(indices(/--viz-line-(\d+)\s*:/g)).toEqual(fullRange);
    // 每个下标亮暗各恰一次（漏一半主题分支/重复声明都算镜像破坏）。
    for (let i = 0; i < LINE_PALETTE_SIZE; i++) {
      expect(all.filter((v) => v === i), `--viz-line-${i} declared once per theme`).toHaveLength(2);
    }
  });

  it('.lane-hue--c{n} consumer classes cover exactly LINE_PALETTE_SIZE contiguous hues', () => {
    expect(indices(/\.lane-hue--c(\d+)\s*\{/g)).toEqual(fullRange);
  });

  it('.minimap-block--c{n} classes cover exactly LINE_PALETTE_SIZE contiguous hues', () => {
    expect(indices(/\.minimap-block--c(\d+)\s*\{/g)).toEqual(fullRange);
  });
});
