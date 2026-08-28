import type { ProjectMeta } from './types';
import { runProjectResets } from './resetRegistry';
import { chaptersFromProjectDocument, deriveChaptersFromDisk } from './chapterDiskDerivation';

type AppStoreApi = {
  subscribe: (listener: (state: any) => void) => () => void;
  getState: () => any;
  setState: (partial: any) => void;
};

// HMR（dogfood 2026-08-21 实录）：i18n yaml 等被 slice import 的模块失效会把
// appStore 整条 import 链拖入重执行，产生全新 store 实例。此模块是 appStore 的
// **依赖**（不是 importer），不会跟着失效——旧的模块级 `installed` flag 于是把
// project 订阅钉死在已无人引用的旧 store 上：新 store 收不到切换事件，
// loadCreativeFields 水合断流，总览承诺区全空而盘上数据完好。按 store 实例判重
// （WeakSet）+ prevProject 收进闭包：同一 store 幂等，新 store 装新订阅、从
// null 起算真切换；旧 store 连同其订阅自然湮灭。
const installedStores = new WeakSet<AppStoreApi>();

/**
 * dogfood R2 #77：项目文档装载共用 helper——项目切换流与 outline:changed 收敛刷新共用。
 * 流程：loadProjectDocument → loadCreativeFields 水合 → deriveChaptersFromDisk →
 * setNovelChapters；每个异步边界后做路径守卫（回来时 currentProject.path 已变 → 丢弃，
 * 防跨项目串写）。
 * - `hydrate: true`（切换流缺省）：额外 restoreProjectTabs + 翻 projectDocumentHydrated +
 *   刷字数；装载失败也翻水合旗标（防 UI 骨架屏卡死）——与抽helper前的切换流行为逐句等价。
 * - `hydrate: false`（agent 写盘后的增量刷新）：不动水合旗标、不 restoreProjectTabs——
 *   用户正在用的 tab 布局不能被后台收敛冲掉；失败静默丢弃（收敛 best-effort，下一次
 *   outline:changed 会再试）。
 */
export async function refreshProjectDocument(
  useAppStore: AppStoreApi,
  projectPath: string,
  options?: { hydrate?: boolean },
): Promise<void> {
  if (!window.orisonDesktop?.loadProjectDocument) return;
  const hydrate = options?.hydrate !== false;
  try {
    const doc = await window.orisonDesktop.loadProjectDocument(projectPath);
    const current = useAppStore.getState();
    if (current.currentProject?.path !== projectPath) return;
    if (doc) current.loadCreativeFields(doc as any);
    const storedChapters = chaptersFromProjectDocument(doc);
    const chapters = await deriveChaptersFromDisk(projectPath, storedChapters);
    const latest = useAppStore.getState();
    if (latest.currentProject?.path !== projectPath) return;
    latest.setNovelChapters(chapters);
    if (!hydrate) return;
    await latest.restoreProjectTabs?.(projectPath);
    if (useAppStore.getState().currentProject?.path !== projectPath) return;
    useAppStore.setState({ projectDocumentHydrated: true });
    latest.refreshWordCount();
  } catch {
    if (hydrate && useAppStore.getState().currentProject?.path === projectPath) {
      useAppStore.setState({ projectDocumentHydrated: true });
    }
  }
}

export function installProjectSubscription(useAppStore: AppStoreApi) {
  if (installedStores.has(useAppStore)) return;
  installedStores.add(useAppStore);

  let prevProject: ProjectMeta | null = null;

  useAppStore.subscribe((state) => {
    const project = state.currentProject;
    if (project === prevProject) return;
    const prev = prevProject;
    prevProject = project;

    // Compare by PATH, not object reference: editing project meta (rename,
    // logline…) produces a new currentProject object with the SAME path. That
    // must NOT be treated as a project switch — otherwise resetAll() flushes +
    // wipes ALL project-scoped state (open files, creative fields, agent…) and
    // reloads the document, clobbering in-flight Outline edits on every rename
    // keystroke. Only a genuine path change is a real switch.
    const isSwitch = (project?.path ?? null) !== (prev?.path ?? null);
    if (!isSwitch) return;

    // Drop ALL project-scoped slice state (open files, chapters, creative fields,
    // agent conversation, pending diffs, split view…) via the reset registry, so
    // nothing bleeds across projects. Each slice owns its own reset.
    const resetAll = () => {
      runProjectResets();
    };

    if (!project && prev) {
      resetAll();
      useAppStore.setState({
        chapterCandidate: null,
        chapterCandidateStatus: 'idle',
        chapterCandidateError: null,
      } as any);
      return;
    }

    if (project && project !== prev) {
      resetAll();
      useAppStore.setState({
        chapterCandidate: null,
        chapterCandidateStatus: 'idle',
        chapterCandidateError: null,
        projectDocumentHydrated: false,
      } as any);

      state.addRecentProject(project);
      state.loadBgTasks();

      if (project.path) {
        // dogfood R2 #77：切换流装载逻辑抽成 refreshProjectDocument 共用 helper
        // （与 outline:changed 增量刷新同源）；此处 hydrate 缺省 true，行为零变化。
        void refreshProjectDocument(useAppStore, project.path);
      }
    }
  });
}
