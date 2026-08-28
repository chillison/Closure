# Vendored: llmlint 静态引擎（llmlint skill/ 子集）

> **本目录是上游第三方代码的 vendored 拷贝**（AGPL-3.0-only）。除本 README 与本目录内
> 明示记录的修改外，文件保持与上游逐字节一致；对引擎源的任何改动都必须记入下方
> 「修改清单」并说明原因。

- **Upstream repo**: https://github.com/notnotype/llmlint
- **Vendored from commit**: `7b0e5a0` (2026-08-15)
- **Upstream package**: `skill/`（package name `llmlint` v3.0.0，private，未发布 npm；
  npm 上的 `llmlint` 名字被无关项目 WillBooster/llmlint 占用，**不可 pnpm add**）
- **License**: AGPL-3.0-only（全文见本目录 `LICENSE`，与根 `LICENSES/AGPL-3.0.txt` 同源）
- **Copyright**: © 2026 notnotype
- **上游同步策略**: 手工 re-vendor（对照上游 diff 更新 `src/` + `rulesets/`，随后更新本
  README 的 commit 号与修改清单）。规则库是活跃资产，规则数字（360 总 / 266 active）会漂移，
  本 README 不锁数字。**不**引入上游 evals 评分体系。

## 拷贝清单与取舍（以 check/fix 路径 import 闭包为准）

入口 API：`loadRules` / `scanWithContext` / `scanHandlerRules`（scanner.ts）、
`scanDensity`（density.ts）、`applyAutoFixWithChanges`（fix.ts）、
`projectCheckIssues`（check-report.ts，即上游「check JSON 紧凑投影」实现——注意上游
没有名为 `createCheckJsonReport` 的导出，CLI 的 `createCheckJsonReport` 在 reporter.ts）。

从入口反查传递依赖闭包，闭包内 12 个 TS 文件全部拷入 `src/`（保持上游 `src/` 目录层级
不变——`rules.ts:27-28` 用 `import.meta.url` 相对定位 `../rulesets`，保持目录结构使
该解析零修改成立）：

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/types.ts` | 640 | 规则 schema + 报告类型（`NormalizedLlmlintConfig` 定义于此，非 config.ts） |
| `src/rules.ts` | 738 | 规则装载 + 校验 + normalize（`loadRules` / `loadRuleCatalog`） |
| `src/rule-registry.ts` | 138 | `materializeRules` 覆盖应用 + `ruleDetectorKind` |
| `src/namespaces.ts` | 168 | namespace 中文 alias 归一 + 策略表 |
| `src/scanner.ts` | 213 | regex 扫描 + handler 执行 + 1-based 码点定位 |
| `src/scan-context.ts` | 449 | 遮罩 / 引号分域 / 三层等长视图 / 行切分 |
| `src/density.ts` | 161 | 密度 detector（门槛 AND 语义） |
| `src/markdown-mask.ts` | 145 | Markdown 结构遮罩 |
| `src/fix.ts` | 272 | 机械修复（`applyAutoFixWithChanges` 等） |
| `src/check-report.ts` | 102 | check 紧凑投影（纯函数，无终端依赖） |
| `src/version.ts` | 1 | `LLMLINT_VERSION`（零依赖；供溯源记录） |
| `src/handler-rules/index.ts` | 506 | 6 个具名 handler 算法注册表 |
| `rulesets/builtin/default/` | 75 JSON | 规则数据全集（含 ruleset.json manifest） |

**未拷文件及原因**（上游 `skill/src/` 共 35 TS 文件，其余 23 个不拷）：

| 文件 | 不拷原因 |
|---|---|
| `cli.ts` / `bin/` | CLI 壳；Closure 走库形态（lintEngine 适配层直调引擎函数） |
| `reporter.ts` | 依赖 npm 包 `picocolors`（stylish 终端着色）；check-report.ts 的纯投影已覆盖需要 |
| `guide.ts` | 依赖 reporter.ts；写作期档位摘要在本 story 无消费者 |
| `config.ts` | 仅 CLI 配置发现（llmlint.config.ts 向上查找 + 动态 import）；适配层自行构造 `NormalizedLlmlintConfig`（类型在 types.ts） |
| `base-rules.ts` + `base-rules/*.ts`（10 文件） | legacy TS 规则，运行时 check 不加载，仅 curated-import 转换工具消费 |
| `curated-import.ts` / `curated-slugs.ts` | 外部策展规则包转 JSON 的导入工具，一次性 |
| `detect/`（3 文件） | 外部神经检测器（HF Space）——**PRD 禁外发通道，绝不集成** |
| `round.ts` / `contribute.ts` / `user-state.ts` | 多轮台账 / 本地发件箱（contribute 有上传通道语义）/ 用户级设置——check/fix 路径不经它们 |
| `references/` + `SKILL.md` + `README.md` | 文档；要点摘录见下方「references 契约要点」 |

**依赖边界**：本 vendor 子集仅依赖 `node:fs` / `node:path` / `node:url` 与闭包内相对
导入。上游 skill 包的 4 个 npm 依赖（commander / picocolors / tinyglobby /
node-fetch-native）全部不进 Closure——它们只被未拷的 CLI 壳与 detect 通道使用。

## 修改清单（modifications）

**初始拷贝：零修改**。以上 12 个 TS 文件与 75 个 rulesets JSON 与上游 commit `7b0e5a0`
逐字节一致（拷贝时 diff 验证）。re-vendor 时在此追加每次改动（文件 + 原因 + 日期）。

## references 契约要点摘录（消费方必读）

上游 `references/rule-model.md` 的核心契约，vendored 消费方（lintEngine / lintNode /
multi-review L2）须遵守：

- **review 三桶**（`Review`）：`agent`（默认——需读上下文判断，check 默认输出）/
  `human`（置信度不足或作者风格偏好，默认不喂 Agent）/ `none`（纯机械诊断，默认不进
  审查输出）。这是**审查期**维度，不当写作期取舍依据。
- **fixability 三档**（`Fixability`）：`auto`（单一确定替换，脚本可盲改，仅 2 条）/
  `candidate`（有替换候选但需上下文判断）/ `manual`（无机械替换，人工或 LLM 改写）。
  它量「脚本能不能盲改」，**不是**「改法要多少判断」——I13 使 264/266 active 规则为
  manual，选规则时零区分度。
- **detector 四类判据**：`"regex"`（词法）/ `"density"`（统计，门槛 AND）/ `"handler"`（编译进包的
  算法，键名须在 `HANDLER_REGISTRY`）/ `"semantic"`（语义——静态**永不命中**，prompt 交给
  读上下文的 LLM 执行）。

当前已注册的 handler：

| name | 粒度 | 判断什么 |
| --- | --- | --- |
| `not-is-comparison` | 逐处 | 「不是 A，(而)是 B」对比句式状态机，带确认语 / either-or / 反问尾巴排除 |
| `period-stutter` | 逐处 | 碎句号：连续极短句堆叠 |
| `overcompressed-prose` | 全文一条 | 过度精炼：短叙述段过密且自然连接偏少，读起来像分镜表 |
| `low-connective-density` | 全文一条 | 引号外叙述的功能词与白话连接同时偏低 |
| `quote-emphasis` | 全文一条 | 叙述层 1–4 字短词被成对引号强调 |
| `long-paragraph` | 逐段 | 叙述层单段可见字数超阈值，字数写进 `Issue.detail` |
- **span 定位**：`line/column/endLine/endColumn` 均为 1-based，列按 Unicode 码点计。
- **I13 替换模板不授予权限**：`action.replace` 只携带模板；是否允许机械应用只看
  materialize 后的 `fixability`。默认 semantic replace 必须是 `manual`。
- **I22 新规则形态前向兼容**：未知 `detector.type` 或未注册 handler 名 → skip +
  diagnostic warning，不得抛错阻断整个 ruleset（re-vendor 到新版规则包时优雅降级）。
- **I23 narrative 占位视图语义**：`scope.layer:"narrative"` 运行在引号段等长 `。`
  占位视图上，offset 与原文一致；规则不得依赖「数句号」或占位串长度做判断。
- **I25 示例必须可分正反**：`examples[].hit` 必填；对照例（`hit:false`）不得带 `fix`。
- **I26 scope 是规则作者合同**：磁盘规则可省略 `scope`，loader 归一为 `{layer:"all"}`；
  Active 记录必须带 `ResolvedScanScope`；项目配置不得覆盖 scope。

## 已知注意点

- **`import.meta.url` 相对定位**：`rules.ts` 以模块自身位置定位 `rulesets/`。dev（tsx）
  与 vitest 下指向源文件，解析正确；生产打包（electron-vite 把 agent 打进 shell
  `dist/main/index.cjs`）下会失配——与 `src/prompt/agentPrompt.ts` 同款已知问题。
  ✅ 已接线（C1.2 Step 7a，2026-08-21）：`shell/electron.vite.config.ts` 的
  `lintRulesetsCopyPlugin` 在 main 构建时把本目录 `rulesets/` 静态拷贝到
  `shell/dist/rulesets`——bundle 内 rollup 把 `import.meta.url` 改写为
  `pathToFileURL(__filename).href`，vendored 解析恰落在 `dist/rulesets`，三种运行上下文
  （agent 源码 / shell dev bundle / 打包 asar）默认解析全部成立，vendored 代码零修改；
  `dist/**` 本就是 electron-builder `files` 条目，拷贝产物必然打包（无 extraResources 依赖）。
- **规则数字口径**：commit `7b0e5a0` 时点 360 总 / 266 默认 active / 74 namespace
  （regex 245 + semantic 8 + density 7 + handler 6）。数字随上游演进漂移，以
  `loadRules().summary` 运行时值为准。
- **examples 字段只存在于 8 条 semantic 规则**（静态永不命中型）——regex/density/handler
  规则不带 examples；引擎测试的命中样例从规则 `detector.targets` 字面量推导（见
  `test/lintEngine.test.ts` 注释）。
