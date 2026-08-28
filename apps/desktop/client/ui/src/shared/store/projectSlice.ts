import type { StateCreator } from 'zustand';
import type { ProjectMeta } from './types';
import { clearLastProject, loadLastProject, persistLastProject } from './workspaceSession';

export type ProjectSlice = {
  currentProject: ProjectMeta | null;
  projectDocumentHydrated: boolean;
  projectWordCount: number;
  openProject: (project: ProjectMeta) => Promise<{ opened: boolean; failed: string[]; error?: string }>;
  restoreLastProject: () => void;
  /** Update meta fields of the *current* project in place (name/logline/…)
   *  WITHOUT resetting projectDocumentHydrated or re-running the project-switch
   *  subscription. Used by the Overview editor so saving a rename can't be
   *  mistaken for a project switch (which would wipe creativeFields + reload
   *  the document and clobber in-flight Outline edits). */
  updateProjectMeta: (patch: Partial<ProjectMeta>) => void;
  closeProject: () => Promise<{ closed: boolean; failed: string[]; error?: string }>;
  saveProject: () => Promise<void>;
  /** Flush in-memory dirty edits to disk (open text tabs + chapter meta) so a
   *  subsequent on-disk read sees the latest content. */
  flushDirty: () => Promise<{ failed: string[]; error?: string }>;
  refreshWordCount: () => Promise<void>;
};

export const createProjectSlice: StateCreator<ProjectSlice, [], [], ProjectSlice> = (set, get) => {
  let openRequestToken = 0;
  let projectMetaPath: string | null = null;
  let projectMetaVersion = 0;
  let savedProjectMetaVersion = 0;
  const syncProjectMetaScope = (path: string | null) => {
    if (projectMetaPath === path) return;
    projectMetaPath = path;
    projectMetaVersion = 0;
    savedProjectMetaVersion = 0;
  };

  return {
  currentProject: null,
  projectDocumentHydrated: false,
  projectWordCount: 0,
  openProject: async (project) => {
    const requestToken = ++openRequestToken;
    const previousPath = get().currentProject?.path ?? null;
    syncProjectMetaScope(previousPath);
    const isSwitch = previousPath !== null && previousPath !== project.path;
    const state = get() as any;
    const hasPendingMeta = projectMetaVersion > savedProjectMetaVersion;
    if (isSwitch && (state.hasDirtyFiles?.() || hasPendingMeta)) {
      const result = await get().flushDirty();
      if (result.failed.length > 0 || result.error) {
        return { opened: false, ...result };
      }
      if (requestToken !== openRequestToken || (get().currentProject?.path ?? null) !== previousPath) {
        return { opened: false, failed: [] };
      }
    }
    set({
      currentProject: project,
      projectDocumentHydrated: false,
      projectWordCount: 0,
    });
    syncProjectMetaScope(project.path ?? null);
    persistLastProject(project);
    // Bump the registry's last-opened time so ProjectsPage orders recents
    // correctly. Best-effort: ordering only, never blocks opening.
    if (project.path) {
      void window.orisonDesktop?.touchProjectRegistration?.({
        localFingerprint: project.path,
        coverImage: project.coverImage,
      }).catch(() => {});
    }
    return { opened: true, failed: [] };
  },
  restoreLastProject: () => {
    if (get().currentProject) return;
    const project = loadLastProject();
    if (!project) return;
    // dogfood #16：恢复前 probe 可达性（路径存在 + 在 allowed-roots 内）。复用既有
    // `project:path-exists` IPC——handler 先 assertSafePath（范围外路径 invoke 直接
    // reject）再 existsSync，一次调用覆盖两种失效形态，零新增契约。探测失败（目录被
    // 删 / 范围外）时清 lastProject 回落项目列表，不再对坏路径连发
    // load-document/read-directory/watch 刷 "Path outside allowed scope" 错误屏。
    //
    // CR-T2-002（2026-08-25）：probe 三态判定——旧写法 `await ...?.pathExists?.() === true`
    // 在桥缺失/方法未注入时 `undefined === true` 也走清记录分支，瞬断/旧 preload 会**销毁
    // 用户记录**（下次启动再也回不来）。区分：
    // - `false`（桥在、方法在、明确回不存在）→ 清记录 + 回落（目录确认被删）；
    // - reject 且消息为范围外（assertSafePath）→ 清记录 + 回落（用户明确移出）；
    // - reject 其他异常 / `undefined`（桥缺失/瞬断）→ **保留记录**，本次不恢复（warn 留痕，
    //   下次启动再试——记录比一次恢复尝试值钱）。
    void (async () => {
      let reachable: boolean | undefined;
      try {
        reachable = await window.orisonDesktop?.pathExists?.(project.path);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Path outside allowed scope/i.test(msg)) {
          clearLastProject();
          return;
        }
        // 非「范围外」的异常（IPC 瞬断/主进程忙）——不可判定，保留记录本次不恢复。
        console.warn('[restoreLastProject] probe rejected (record kept):', msg);
        return;
      }
      if (reachable !== true) {
        if (reachable === false) {
          clearLastProject();
        } else {
          // undefined = 桥缺失/方法未注入（preload 变体/启动竞态）——保留记录，本次不恢复。
          console.warn('[restoreLastProject] pathExists bridge missing (record kept, skip restore)');
        }
        return;
      }
      // probe 是异步的：等待期间用户可能已手动打开了别的项目。
      if (get().currentProject) return;
      try {
        await get().openProject(project);
      } catch (err) {
        // CR-T2-002：openProject 的拒绝不得变 unhandled rejection（回落语义已由上面保证，
        // 这里只 warn 留痕——恢复失败不是错误态，用户照常从项目列表进入）。
        console.warn('[restoreLastProject] openProject rejected:', err instanceof Error ? err.message : String(err));
      }
    })();
  },
  updateProjectMeta: (patch) => {
    const current = get().currentProject;
    if (!current) return;
    // In-place meta update: keep the SAME logical project (same path) so the
    // project-switch subscription's path check treats this as an edit, not a
    // switch — no creativeFields wipe, no document reload, no hydrated reset.
    const next = { ...current, ...patch };
    syncProjectMetaScope(current.path ?? null);
    projectMetaVersion += 1;
    set({ currentProject: next });
    persistLastProject(next);
  },
  closeProject: async () => {
    const projectPath = get().currentProject?.path ?? null;
    const result = await get().flushDirty();
    if (result.failed.length > 0 || result.error) {
      return { closed: false, ...result };
    }
    if ((get().currentProject?.path ?? null) !== projectPath) {
      return { closed: false, failed: [] };
    }
    set({
      currentProject: null,
      projectDocumentHydrated: false,
      projectWordCount: 0,
    });
    syncProjectMetaScope(null);
    clearLastProject();
    return { closed: true, failed: [] };
  },
  async saveProject() {
    const project = get().currentProject;
    if (!project?.path) return;
    syncProjectMetaScope(project.path);
    const savingVersion = projectMetaVersion;
    // project.json 已废弃：meta 直接落 project.yaml。saveProjectMeta 现在就是写 yaml meta，
    // 单次调用即可（旧版 saveProjectMeta + syncProjectMeta 双写已是同一目标，去重）。
    const meta = {
      name: project.name,
      type: project.type,
      logline: project.logline ?? null,
      synopsis: project.synopsis ?? null,
      genre: project.genre ?? null,
      theme: project.theme ?? null,
      writing_style: project.writingStyle ?? null,
      tone: project.tone ?? null,
      coverImage: project.coverImage ?? null,
      projectId: project.projectId ?? null,
    };
    if (window.orisonDesktop?.saveProjectMeta) {
      await window.orisonDesktop.saveProjectMeta(project.path, meta);
    }
    if (get().currentProject?.path === project.path && projectMetaPath === project.path) {
      savedProjectMetaVersion = Math.max(savedProjectMetaVersion, savingVersion);
    }
  },
  async flushDirty() {
    const state = get() as any;
    const projectPath = state.currentProject?.path ?? null;
    syncProjectMetaScope(projectPath);
    // Persist dirty open text tabs (the manuscript files word count reads).
    // refreshWordCount calls this, so navigating to the Overview/word-count
    // surfaces a save. Reflect that in saveStatus so the flush isn't silent —
    // otherwise the dirty indicator just vanishes with no "saved" feedback.
    const hasDirtyFiles = !!state.hasDirtyFiles?.();
    const hasDirtyMeta = projectMetaVersion > savedProjectMetaVersion;
    if (!hasDirtyFiles && !hasDirtyMeta) return { failed: [] };

    state.setSaveStatus?.('saving');
    try {
      if (hasDirtyFiles) {
        const result = await state.saveAllOpenFiles?.() ?? { failed: [] };
        const isCurrentProject = ((get() as any).currentProject?.path ?? null) === projectPath;
        if (result.failed.length > 0) {
          if (isCurrentProject) state.setSaveStatus?.('error');
          return result;
        }
      }

      while (
        projectPath !== null
        && (get() as any).currentProject?.path === projectPath
        && projectMetaPath === projectPath
        && projectMetaVersion > savedProjectMetaVersion
      ) {
        await get().saveProject();
      }

      if (((get() as any).currentProject?.path ?? null) === projectPath) {
        state.setLastSavedAt?.(Date.now());
        state.setSaveStatus?.('saved');
      }
      return { failed: [] };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (((get() as any).currentProject?.path ?? null) === projectPath) {
        state.setSaveStatus?.('error');
      }
      return { failed: [], error };
    }
  },
  async refreshWordCount() {
    const project = get().currentProject;
    if (!project?.path) return;
    // Flush in-memory edits first: word count reads md/txt from disk, so an
    // unsaved buffer would otherwise be counted one edit stale (the bug).
    const result = await get().flushDirty();
    if (result.failed.length > 0 || result.error) return;
    const count = await window.orisonDesktop?.wordCount?.(project.path) ?? 0;
    if (get().currentProject?.path === project.path) {
      set({ projectWordCount: count });
    }
  },
  };
};
