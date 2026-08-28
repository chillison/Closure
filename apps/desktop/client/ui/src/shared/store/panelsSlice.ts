import type { StateCreator } from 'zustand';
import type { ActivePage, BottomPanelTab, SidebarPanel } from './types';
import { storage } from './storage';
import { registerProjectReset } from './resetRegistry';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';
import {
  PROJECT_TREE_WIDTH_DEFAULT,
  PROJECT_TREE_WIDTH_MIN,
  PROJECT_TREE_WIDTH_MAX,
  BOTTOM_PANEL_HEIGHT_DEFAULT,
  BOTTOM_PANEL_HEIGHT_MIN,
  BOTTOM_PANEL_HEIGHT_MAX,
  AGENT_PANEL_WIDTH_DEFAULT,
  AGENT_PANEL_WIDTH_MIN,
  AGENT_PANEL_WIDTH_MAX,
} from '../constants';

export type SplitDirection = 'none' | 'horizontal' | 'vertical' | 'outline';

export type MainView = 'page' | 'files';

export type PanelsSlice = {
  projectTreeOpen: boolean;
  toggleProjectTree: () => void;
  projectTreeWidth: number;
  setProjectTreeWidth: (w: number) => void;
  activeSidebarPanel: SidebarPanel;
  setActiveSidebarPanel: (panel: SidebarPanel) => void;
  bottomPanelOpen: boolean;
  toggleBottomPanel: () => void;
  bottomPanelHeight: number;
  setBottomPanelHeight: (h: number) => void;
  activeBottomTab: BottomPanelTab;
  setActiveBottomTab: (tab: BottomPanelTab) => void;
  agentPanelOpen: boolean;
  toggleAgentPanel: () => void;
  setAgentPanelOpen: (open: boolean) => void;
  agentPanelWidth: number;
  setAgentPanelWidth: (w: number) => void;
  // Story 3.2 — workbench mode. `agentExpanded` flips the docked side-panel
  // layout: when true (and the panel is open) the AgentPanel goes FULLSCREEN
  // over the main area (dogfood 2026-08-21 拍板：放大 = 占满到项目文件侧栏旁，
  // 原「主区/工作台分屏」形态退役——侧栏并排需求由 docked 模式拖宽覆盖)。
  // Orthogonal to activePage — the target panel reuses the existing page/files
  // routing, no new concept.
  //
  // `agentExpanded` is a project-scoped viewing state (like mainView /
  // splitDirection) — NOT persisted to localStorage, so a restart can't revive
  // an expanded mode that project isolation (registerProjectReset) cleared.
  agentExpanded: boolean;
  toggleAgentExpanded: () => void;
  setAgentExpanded: (expanded: boolean) => void;
  // Story 3.5 Step 8: per-batch folded/unfolded preference for `<BatchGroup>`
  // headers. Memory-only viewing state keyed by batchId — NOT persisted (a
  // restart re-collapses batches, which is the default anyway), but
  // project-scoped and therefore cleared on project switch so another
  // project's batch ids can't stay expanded (state-management spec: persisted
  // fields must sync storage on reset OR simply not persist — this one
  // doesn't persist). The grouping itself is pure derived state over the
  // message stream; only this viewing preference lives in the store.
  agentBatchExpanded: Record<string, boolean>;
  setAgentBatchExpanded: (batchId: string, open: boolean) => void;
  activePage: ActivePage;
  setActivePage: (page: ActivePage) => void;
  mainView: MainView;
  setMainView: (view: MainView) => void;
  splitDirection: SplitDirection;
  splitFilePath: string | null;
  setSplit: (direction: SplitDirection, filePath?: string | null) => void;
  // Top-level dialogs. Lifted to the store so the command palette (and any other
  // entry point) can open them, not just the TopBar menu that used to own the
  // local useState. TopBar renders the dialogs driven by these flags.
  settingsDialogOpen: boolean;
  aboutDialogOpen: boolean;
  newProjectDialogOpen: boolean;
  setSettingsDialogOpen: (open: boolean) => void;
  setAboutDialogOpen: (open: boolean) => void;
  setNewProjectDialogOpen: (open: boolean) => void;
};

export const createPanelsSlice: StateCreator<PanelsSlice, [], [], PanelsSlice> = (set, get) => {
  // The split view and file-editing mode are tied to the previous project's open
  // files. On project switch, collapse back to page mode with no split so the new
  // project doesn't inherit a split pointing at a file it doesn't have.
  // Story 3.2: also drop expanded workbench mode — it's a project-scoped viewing
  // state, and leaving it expanded would carry the previous project's direction
  // context into the new project. Width persists (user preference, like
  // agentPanelWidth — not project state).
  registerProjectReset(() => {
    set({ mainView: 'page', splitDirection: 'none', splitFilePath: null, agentExpanded: false });
    // Story 3.5: batch fold prefs are keyed by the previous project's batch
    // ids — drop them so a new project starts with all groups collapsed.
    set({ agentBatchExpanded: {} });
  });

  return {
  projectTreeOpen: true,
  toggleProjectTree: () => set((s) => ({ projectTreeOpen: !s.projectTreeOpen })),
  projectTreeWidth: storage.get<number>('projectTreeWidth', PROJECT_TREE_WIDTH_DEFAULT),
  setProjectTreeWidth: (w) => {
    const clamped = Math.max(PROJECT_TREE_WIDTH_MIN, Math.min(PROJECT_TREE_WIDTH_MAX, w));
    storage.set('projectTreeWidth', clamped);
    set({ projectTreeWidth: clamped });
  },
  activeSidebarPanel: 'explorer',
  setActiveSidebarPanel: (panel) => set({ activeSidebarPanel: panel, projectTreeOpen: true }),
  bottomPanelOpen: false,
  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  bottomPanelHeight: storage.get<number>('bottomPanelHeight', BOTTOM_PANEL_HEIGHT_DEFAULT),
  setBottomPanelHeight: (h) => {
    const clamped = Math.max(BOTTOM_PANEL_HEIGHT_MIN, Math.min(BOTTOM_PANEL_HEIGHT_MAX, h));
    storage.set('bottomPanelHeight', clamped);
    set({ bottomPanelHeight: clamped });
  },
  activeBottomTab: 'output',
  setActiveBottomTab: (tab) => set({ activeBottomTab: tab }),
  // 工作台（AgentPanel，冷启动邀请卡/leader 对话所在）默认可见——dogfood 2026-08-20
  // 实录：默认关着 + 唯一入口是右缘细 chevron 标签页，新作者找不到工作台=冷启动断路。
  agentPanelOpen: true,
  toggleAgentPanel: () => set((s) => ({ agentPanelOpen: !s.agentPanelOpen })),
  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),
  agentPanelWidth: storage.get<number>('agentPanelWidth', AGENT_PANEL_WIDTH_DEFAULT),
  setAgentPanelWidth: (w) => {
    const clamped = Math.max(AGENT_PANEL_WIDTH_MIN, Math.min(AGENT_PANEL_WIDTH_MAX, w));
    storage.set('agentPanelWidth', clamped);
    set({ agentPanelWidth: clamped });
  },
  agentExpanded: false,
  toggleAgentExpanded: () => get().setAgentExpanded(!get().agentExpanded),
  setAgentExpanded: (expanded) => {
    // agentExpanded is a viewing state, not persisted (see field note above) —
    // only the in-memory flag flips, so a restart can't revive an expanded mode
    // that project isolation cleared.
    // expanded ⊥ split: workbench (dominant) + target panel + split = three
    // panes, which is too cramped. Collapse any active split when entering
    // expanded mode (mirror setSplit's toast pattern by silently collapsing —
    // the expand affordance itself signals the mode change).
    if (expanded && get().splitDirection !== 'none') {
      set({ agentExpanded: expanded, splitDirection: 'none', splitFilePath: null });
      return;
    }
    set({ agentExpanded: expanded });
  },
  agentBatchExpanded: {},
  setAgentBatchExpanded: (batchId, open) => {
    set((s) => ({ agentBatchExpanded: { ...s.agentBatchExpanded, [batchId]: open } }));
  },
  activePage: storage.get<ActivePage>('activePage', 'overview'),
  setActivePage: (page) => { storage.set('activePage', page); set({ activePage: page, mainView: 'page' }); },
  mainView: 'page' as MainView,
  setMainView: (view) => set({ mainView: view }),
  splitDirection: 'none',
  splitFilePath: null,
  setSplit: (direction, filePath) => {
    if (direction === 'none' || direction === 'outline') {
      set({ splitDirection: direction, splitFilePath: null });
      return;
    }
    // Two live editors on the same document don't share state and overwrite
    // each other's edits (no shared doc model yet), so a split never shows the
    // active file. When asked to (TopBar's Split Right/Down passes the active
    // path), show another open tab instead; with no other tab there is
    // nothing safe to show.
    // Cross-slice read of the merged store (typed cleanup tracked in plan 4.3).
    const s = get() as unknown as { activeFilePath: string | null; openFiles: { path: string }[]; resolvedLocale: string; agentExpanded: boolean };
    // expanded ⊥ split (symmetric guard): entering expanded collapses split
    // (see setAgentExpanded); refuse to open a new split while expanded — three
    // panes (workbench + target + split) are too cramped. Mirror the second-file
    // toast pattern so the user knows to collapse the workbench first.
    if (s.agentExpanded) {
      useToastStore.getState().showToast(translate(s.resolvedLocale, 'workspace.splitNeedsCollapseWorkbench'), 'info');
      return;
    }
    let target = filePath ?? null;
    if (!target || target === s.activeFilePath) {
      target = s.openFiles.find((f) => f.path !== s.activeFilePath)?.path ?? null;
    }
    if (!target) {
      useToastStore.getState().showToast(translate(s.resolvedLocale, 'fileEditor.splitNeedsSecondFile'), 'info');
      return;
    }
    set({ splitDirection: direction, splitFilePath: target });
  },
  settingsDialogOpen: false,
  aboutDialogOpen: false,
  newProjectDialogOpen: false,
  setSettingsDialogOpen: (open) => set({ settingsDialogOpen: open }),
  setAboutDialogOpen: (open) => set({ aboutDialogOpen: open }),
  setNewProjectDialogOpen: (open) => set({ newProjectDialogOpen: open }),
  };
};
