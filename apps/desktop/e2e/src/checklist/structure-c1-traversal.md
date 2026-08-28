# C1 结构页全功能遍历记录（可重放资产 · R9 首个产出）

> 2026-08-27 晚 · task 08-27-structure-fixes · 环境：`pnpm dev` + CDP 9222（shell 常开口）。
> 驱动通道：`npx tsx src/attach.ts '<json>'`（本目录相邻命令均可原样重放）；截图在 `docs/tests/2026-08-27-structure-fixes/`。
> 复杂表达式经文件传参：`python` 包 JSON → `attach.ts "$(cat req-eval.json)"`（绕 shell 转义）。
> 新增驱动原语（本轮沉淀进 drive.ts）：`POST /hover`、`POST /eval`、click 的 `button:right`+`position`。

## 步骤台账（步｜命令要点｜期望｜实测｜AC）

| # | 步骤 | 期望 | 实测 | AC |
|---|---|---|---|---|
| 1 | 进结构页 | 双骨架渲染 | 102 槽/75 chip/75 卡/12 pending；zoombar+minimap 在 | 底座 |
| 2 | 视觉基线截图 + 视觉模型判读 | 直角卡/曲率/线束/chrome | ✓✓✓✓（haiku 判读 7 项） | AC11/15/6/5 |
| 3 | 计数器两区对拍 | 同线同值 | causal 10/10/6/3/4 = workbench 五线 ✓ aria 双语 ✓ | AC12 |
| 4 | 跨章 chip 点击→浮层 | 点击邻域 | **红**：x 落 L3 默认左缘+顶出视口（发现 T1/T2） | AC4⚠ |
| 5 | 四入口浮层矩阵 ×4 | 无 (0,0) | 无 (0,0) ✓ 但锚全默认（T1）；T2 修复后顶界回正 top=158 | AC4⚠ |
| 6 | 深滚 chrome 复测 | 恒驻 | 修前 y=-733/-701 **红**→T2 后页自滚 800、y=70/102 **绿** | AC5✓ |
| 7 | 工作台空槽右键 | 菜单+新建+插入 | 「在此章新建场景（第 8 章）」+「插入新章」双条 ✓ | AC13✓ |
| 8 | 插入新章全链路 | idx 漂移+裸 chapter+1+spans byId 安全 | ep-17@idx7、s12 po 11→12、s11 10→11、s22 哨兵保持 ✓ undo 后全复原 | D1✓ |
| 9 | 因果空白右键三点 | 菜单章号归位 | 第10/15/2章随 x 正确 ✓ | AC13✓ |
| 10 | 右键 10 连击 | MenuEvent 零丢失 | 10/10 ✓ | AC13✓ |
| 11 | 图例展开 | 四教育条款 | 18 键含 span-wide/stack-order/empty-slot/**assoc-fold** ✓ | AC6✓ |
| 12 | 第 12 章内容复核 | s12 三线格在位 | 「游戏联动·雪夜活动预告」3/6 线格 ✓ | AC3✓ |
| 13 | 边缘直拖扩章（s1 右把手+110px） | spans 真写 | `{ep-01,0}{ep-02,0}` 首段 pos 0 ✓ 续至第 2 章 ✓ | AC9½ |
| 14 | 左把手越界拖（-110px） | 守卫拒收 | 无写入 ✓ | AC9 |
| 15 | 右把手左拖复原 | 单章规范形 | spans 字段删除、零残留 ✓ | AC9✓ |
| 16 | pending 灰片拖入章格（s17→idx3） | 挪章放行 | 落列 idx3 ✓ 落盘 ✓ undo 后 dangling 原态零残留 | G5✓ |
| 17 | 事故恢复（yaml 隔离） | 数据全量恢复 | schema OK 30/33/16 ✓ 结构页满血 ✓ | 事故 |

**事故记录（步骤 0）**：dev 冷启 `projectDocumentSchema.parse` 拒 PyYAML 空格时间戳 → 静默隔离重建空项目。恢复=两行时间戳 ISO-T 手术 + bff 归一化迁移补丁（防复发）。备份：本地 `Closure-backup/` 隔离目录（2026-08-27）。

## 遍历发现（已入 prd 台账）

- T1 首开锚丢失（AC4 红，修复中）· T2 chrome 深滚失效（AC5 红→已修复测绿）· 事故两项 bff 补丁（已修）。

## 收官补录（T1/T2 修复后复测）

- AC4 四入口锚定复测：干净 reload 后 x=543/1194/1599/522 全锚点击点、y=158 钉 chrome 地板（HMR 陈旧态需 location.reload 才见新代码——遍历注意项）。
- AC5 三态齐：深滚 ✓ / reload 重挂载 ✓ / 面板开合 ✓（zoombar/minimap 恒 y=70/102）。
- AC14 结构证据：21 组双 stop linearGradient（c7→c4 异色对）+ haiku 异常单色判读 ✓。
- AC1 代理：s12 12→13 往返零消失 ✓；AC7=AC9 复原半 ✓；AC2 落点管线（pending drop 同管道）✓。

## 未走完项（jsdom 已覆盖，真机未逐条重放）

- AC10 宽卡路由/平移/取消式三态（jsdom 61+48 测覆盖；DnD 落点管线真机已由 pending drop 验证）、gap 置灰目检、列头「＋」钮、×5 往返的余四次。
- 重放方法：eval 表达式经文件传参（见文件头「文件传参」行——`.trellis/req-eval.js|json` 是**每次探针重写的瞬态通道**而非存档，步骤台账「命令要点」列才是重放依据）；check 批清理的是旧快照（`req-click.json`、花括号误名文件 `apps/desktop/e2e/{`），瞬态通道本体收口 commit 前由主会话终扫。
