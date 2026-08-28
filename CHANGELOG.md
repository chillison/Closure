# 更新日志 · Changelog

本项目所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

This project's notable changes are documented here, following [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-08-28

Closure 首个公开发布。以 [OrisonSpace](https://github.com/LumenStorm/OrisonSpace)（Apache-2.0）为代码基底，叠加叙事操作系统层。

### 新增 · Added — 叙事层

- **多线叙事结构**：场景图统一管理故事骨架，多线并行推进、互相咬合
- **设定层**：资产卡、题材契约（GenreContract）、创作决策记录（StoryDecision）
- **结构工作台**：因果骨架 + 编排工作台两区联动结构页，同构锁步跨区高亮，章节轴按卷分带、小地图长篇导航
- **生成质量链**：写手两阶段成稿（自查缺口 → 调查清单 → 资料核实 → 动笔），上下文降级梯
- **情绪闭环**：每场戏先定目标情绪，写完自动检查落地，未落地打回修
- **信息差操控**：角色所知 / 读者所知分开记账，审核发现「说了不该知道的」「该揭的忘揭」
- **世界事件系统**：每章自动提取五类变化（物理/认知/情绪/关系/势力），事实真相与读者所知双层世界状态
- **修订保义**：AI 改动词级对比展示，改了什么、有没有偏原义一眼可验
- **百万字长程供给**：章摘要 checkpoint、完整性校验、提及台账
- **涟漪传播**：改设定沿叙事依赖图正向追查下游受影响章节
- **去 AI 味引擎**：内嵌 [llmlint](https://github.com/notnotype/llmlint) 静态引擎（数百条规则本地扫描）+ Lint 面板与修订闭环
- **双层审核漏斗**：L1 纯代码规则免费放行干净稿，L2 模型六组维度细审（每条意见必须附原文引证）
- **任务型模型路由与思考控制**：规划/正文/审核/研究等环节分别指定模型档位与推理力度
- **风格卡**：贴一段心仪小说，子代理分析成风格卡供写手/精修/规划参考
- **联网研究**：Tavily / Bocha / AnySearch 多供应商可配，资料员检索、导演核实、矛盾打回

### 变更 · Changed

- Agent Skill 改为 OpenCode 风格按需加载：`skill` tool 只加载 `SKILL.md` 内容和资源清单，不再将任意 `SKILL.md` 编译执行为 workflow DAG；后端强制执行 session mode 与 skill `allowed-tools` 权限
- 打包资源接线修复：craft KB 种子与 agent 契约 prompts 改走 `extraResources`（asar 外），打包版不再读空

### 继承 · Inherited

以下能力继承自 OrisonSpace 基座，详见上游：本地优先项目文件模型、isomorphic-git 版本时间线、IDE 式编辑器（分屏/Minimap/多标签/命令面板）、图片生成与编辑、任意 OpenAI 兼容端点接入（密钥本地加密）。

### 已知问题 · Known Issues

项目处于**早期开发阶段（Alpha）**：界面与功能可能变化，可能遇到各种 BUG。欢迎[提 Issue](https://github.com/chillison/Closure/issues)（附复现步骤与应用内「复制诊断」输出）。macOS / Linux 产物继承自上游架构，尚未充分实测。
