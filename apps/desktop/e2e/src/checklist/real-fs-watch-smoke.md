# 真 fs.watch 手动冒烟清单（R3 注入缝后的唯一真句柄验证面）

> task 08-29-ci-stopgap-proper-fixes（CR-009）· 手动执行，非自动化脚本。
> **R3 注入缝后真实 `fs.watch` 的唯一验证面**——自动化测试已全走合成事件源
> （`setWatchFactory` fake 注入，无真句柄；libuv windows CI 断言 `!_wcsnicmp`
> 根除的代价）。生产默认分支的调用形态由 `test/watchFactory.test.ts` 钉
> （mock fs.watch）；watcher 行为面（debounce/过滤/串行化/生命周期）由
> `test/chapterChunkWatcher.test.ts` 等钉（合成事件驱动）。本清单验的是
> **真句柄在真文件系统上的端到端行为**：事件真投递、过滤真生效、句柄真关闭。

## 环境与观测口径

- 环境：本机 `pnpm dev`（非 CI）；Windows/macOS（Linux 无 recursive watch →
  走 degrade 分支，不在本清单预期内）。
- 日志 = shell 主进程 stdout（dev 终端）。各 watcher 启动打 info 行
  （`chapter chunk watcher started` / `setting_md watcher started` /
  `asset_cards watcher started`）；reindex **成功无日志**（indexer 只在失败时
  warn）——正向信号 = 无 `watcher: ... failed` warn + 索引面可见变化
  （`closure:index-status` 计数或命令栏 `@` 检索命中新词）。

## 步骤台账（#｜操作｜期望｜实测）

| # | 操作 | 期望 | 实测 |
|---|---|---|---|
| 1 | dev 起应用并打开项目 | 终端见 `chapter chunk watcher started` + `setting_md watcher started` + `asset_cards watcher started`（`project:watch` 生命周期一次打齐）；无 warn | |
| 2 | 外部编辑器改一章 `chapters/<id>.md` 存盘（加一句可检索新词） | ~500ms debounce 后：无 `chapter chunk watcher: ... failed` warn；索引面见该章更新（`closure:index-status` chunk 计数变化 / 检索命中新词） | |
| 3 | 改 `settings/style.md` 存盘 | 无 `setting_md watcher: debounced reindex failed` warn；设定 prose 索引面更新（检索命中新改词） | |
| 4 | 无关路径扰动：编辑 `chapters/draft/x.md` 与根级 `notes.md` | 零 reindex 动作（过滤真生效：无新 warn、索引面计数不变） | |
| 5 | 关闭项目（`project:unwatch`） | 无报错、无新 warn（三 watcher 停止无显式日志——验证面在步骤 6） | |
| 6 | 关闭后再编辑同项目 `chapters/*.md` | **零新日志**（句柄真关：事件不再投递，无 reindex warn/痕迹） | |
| 7 | 切换/重开另一项目，再切回；开-关 3 轮 | 每次打开步骤 1 的 started 行重打且指向新 projectDir；全程无 `watcher error` / `watcher unavailable` warn（泄漏/竞态面） | |

## 备注

- 覆盖的五个 watcher：chapterChunkWatcher / settingMdWatcher / assetCardsWatcher
  （`project:watch` 起、`project:unwatch` 停）+ projectWatcher（文件树刷新）+
  craftKbWatcher（craft KB 目录，独立生命周期）。本清单以 chapter chunk +
  setting_md 为主信号面（有可观测索引效果），其余以「无 error warn」为门。
- 执行后把「实测」列回填，整表作为 task 收官证据归档。
