/**
 * C1.2 lint slice（bottom-panel Lint tab 状态面）。Mirror kbIndexSlice 的 slice 组合模式：
 * project-scoped 状态自注册 project-reset（切项目不把上一项目的 lint 报告渗进新项目——
 * spec/ui/state-management 不变式）；错误按 IPC 模式 A code 映射 i18n toast。
 *
 * 修复确认流（R4「不静默改稿」）：勾选状态（章粒度）+ confirmOpen 弹层开关住在 store
 * （LintPanel 渲染），确认后 runLintApplyFix 把勾选章的补丁集发 lint:apply-fix：
 * - CR-005：apply 成功写盘的章若开着 tab，先 reloadFile 刷新（shell 直写章文件，renderer
 *   tab 不重读就看不到正文更新）；
 * - CR-018：仅当确有章写盘（written>0）才重扫刷新报告；ok:false / 全 written:false（正文
 *   未变）不再全量阻塞重扫。generatedAt 语义（= 最后一次全稿扫描时间）由 shell 侧保留。
 *
 * 语境判断按钮可用性（CR-014 单源下沉）：probeLintModel 走 shell `lint:model-probe` IPC
 * （review-judge 档解析 + resolveModel 成功即 true——与 lint:classify 同一解析链），renderer
 * 不再做「任一启用模型」本地启发式（与 shell default 哨兵语义漂移）。
 */
import type { StateCreator } from 'zustand';
import type {
  LintChapterFile,
  LintClassifyResult,
  LintFixPatch,
  LintFullReport,
  LintScanFullResult,
  LintSkippedChapter,
} from '@orison/shared-contracts';
import { registerProjectReset } from './resetRegistry';
import { useToastStore } from './toastStore';
import { translate } from '../i18n/useI18n';
import { lintApplyFix, lintClassify, lintModelProbe, lintScanFull } from '../api/lint';

export type LintSeverityFilter = 'all' | 'high' | 'medium' | 'low';

export type LintSlice = {
  lintReport: LintFullReport | null;
  /** scan 附带的章定位面（issue 跳转打开文件 / 章名展示）。 */
  lintChapterFiles: LintChapterFile[];
  /** scan 跳章清单（CR-011 批 A 字段的 UI 消费面：面板顶部 skipped 摘要行）。 */
  lintSkipped: LintSkippedChapter[];
  lintFixPatches: LintFixPatch[];
  lintClassifyResult: LintClassifyResult | null;
  /** null = 未探测（面板挂载 / 窗口重聚焦时 probe）；false = review-judge 档不可解析（按钮禁用+提示）。 */
  lintModelAvailable: boolean | null;
  lintScanning: boolean;
  lintClassifying: boolean;
  lintApplying: boolean;
  lintSeverityFilter: LintSeverityFilter;
  /** 修复勾选（章粒度——apply-fix 应用单位是章，确认弹层列章与条数）。 */
  lintSelectedChapterIds: string[];
  lintConfirmOpen: boolean;
  runLintScan: () => Promise<void>;
  runLintClassify: () => Promise<void>;
  runLintApplyFix: () => Promise<void>;
  probeLintModel: () => Promise<void>;
  setLintSeverityFilter: (filter: LintSeverityFilter) => void;
  toggleLintChapterSelected: (chapterId: string) => void;
  setLintConfirmOpen: (open: boolean) => void;
};

type Deps = LintSlice & {
  currentProject: { path?: string } | null;
  resolvedLocale: string;
  /** fileTabsSlice（CR-005：apply-fix 后刷新已打开的章 tab）。 */
  reloadFile: (path: string) => Promise<void>;
};

/** IPC 模式 A error code → i18n 文案（mirror kbIndexSlice.rebuildErrorMessage）。 */
function lintErrorMessage(locale: string, error: string, fallback: string): string {
  switch (error) {
    case 'no-project':
      return translate(locale, 'lint.errorNoProject');
    case 'project-not-found':
      return translate(locale, 'lint.errorProjectNotFound');
    case 'engine-unavailable':
      return translate(locale, 'lint.errorEngine');
    case 'invalid-patches':
      return translate(locale, 'lint.errorInvalidPatches');
    case 'operation-failed':
      return translate(locale, 'lint.errorOperation', { reason: fallback });
    default:
      return translate(locale, 'lint.errorOperation', { reason: fallback || error });
  }
}

function toastError(locale: string, error: string, message?: string): void {
  useToastStore.getState().showToast(lintErrorMessage(locale, error, message ?? ''), 'error');
}

export const createLintSlice: StateCreator<Deps, [], [], LintSlice> = (set, get) => {
  registerProjectReset(() => {
    // lint 报告/补丁/verdict 全部 project-scoped——切项目整体丢弃（新项目重新扫描）。
    set({
      lintReport: null,
      lintChapterFiles: [],
      lintSkipped: [],
      lintFixPatches: [],
      lintClassifyResult: null,
      lintScanning: false,
      lintClassifying: false,
      lintApplying: false,
      lintSelectedChapterIds: [],
      lintConfirmOpen: false,
    });
  });

  return {
    lintReport: null,
    lintChapterFiles: [],
    lintSkipped: [],
    lintFixPatches: [],
    lintClassifyResult: null,
    lintModelAvailable: null,
    lintScanning: false,
    lintClassifying: false,
    lintApplying: false,
    lintSeverityFilter: 'all',
    lintSelectedChapterIds: [],
    lintConfirmOpen: false,

    async runLintScan() {
      const locale = get().resolvedLocale ?? 'en-US';
      const projectPath = get().currentProject?.path;
      if (!projectPath) {
        useToastStore.getState().showToast(translate(locale, 'lint.noProject'), 'error');
        return;
      }
      set({ lintScanning: true });
      try {
        const result = (await lintScanFull(projectPath)) as LintScanFullResult | null;
        if (result && result.ok) {
          set({
            lintReport: result.report,
            lintChapterFiles: result.chapterFiles,
            // CR-011 批 A 字段：跳章清单（旧载荷无此字段时空数组防御）。
            lintSkipped: result.skipped ?? [],
            lintFixPatches: result.fixPatches,
            // 新报告使旧 verdict / 勾选失效。
            lintClassifyResult: null,
            lintSelectedChapterIds: [],
            lintConfirmOpen: false,
            lintScanning: false,
          });
        } else if (result && !result.ok) {
          toastError(locale, result.error, result.message);
          set({ lintScanning: false });
        } else {
          // IPC 桥不可用（测试外不应发生）。
          set({ lintScanning: false });
        }
      } catch (err) {
        toastError(locale, 'operation-failed', err instanceof Error ? err.message : String(err));
        set({ lintScanning: false });
      }
    },

    async runLintClassify() {
      const locale = get().resolvedLocale ?? 'en-US';
      const projectPath = get().currentProject?.path;
      if (!projectPath || !get().lintReport) return;
      set({ lintClassifying: true });
      try {
        const result = (await lintClassify(projectPath)) as LintClassifyResult | null;
        set({ lintClassifyResult: result ?? { verdicts: [], degraded: true }, lintClassifying: false });
      } catch {
        set({ lintClassifyResult: { verdicts: [], degraded: true }, lintClassifying: false });
      }
    },

    async runLintApplyFix() {
      const locale = get().resolvedLocale ?? 'en-US';
      const projectPath = get().currentProject?.path;
      const { lintFixPatches, lintSelectedChapterIds } = get();
      if (!projectPath) return;
      const selected = new Set(lintSelectedChapterIds);
      const patches = lintFixPatches.filter((patch) => selected.has(patch.chapterId));
      if (patches.length === 0) {
        useToastStore.getState().showToast(translate(locale, 'lint.noFixSelection'), 'error');
        return;
      }
      set({ lintApplying: true, lintConfirmOpen: false });
      try {
        const result = (await lintApplyFix(projectPath, patches)) as
          | { ok: true; results: Array<{ chapterId: string; filePath: string; written: boolean }> }
          | { ok: false; error: string; message?: string }
          | null;
        if (result && result.ok) {
          const writtenResults = result.results.filter((r) => r.written);
          if (writtenResults.length > 0) {
            useToastStore
              .getState()
              .showToast(translate(locale, 'lint.applySuccess', { n: writtenResults.length }), 'success');
            // CR-005：shell 直写章文件，已打开的 tab 须重读盘上正文（未打开的章 reloadFile 无操作）。
            for (const r of writtenResults) {
              await get().reloadFile(r.filePath);
            }
            // 正文已变——重扫刷新报告（旧账作废；含 nothing-to-fix 章的对账）。
            await get().runLintScan();
          }
          // CR-018：全部章 written:false（nothing-to-fix 等）→ 正文未变，跳过全量重扫，
          // 也不报「已修复」成功 toast。
        } else if (result && !result.ok) {
          // CR-018：apply 失败（模式 A 错误码）→ toast 报错，不重扫（旧报告仍对应当前盘面）。
          toastError(locale, result.error, result.message);
        }
      } catch (err) {
        toastError(locale, 'operation-failed', err instanceof Error ? err.message : String(err));
      } finally {
        set({ lintApplying: false });
      }
    },

    async probeLintModel() {
      // CR-014：探测下沉 shell 单源（lint:model-probe——review-judge 档解析 + resolveModel），
      // 与 classify 实际调用同一解析链；桥不可用/异常 → false（按钮禁用+提示，宁保守）。
      try {
        const result = await lintModelProbe();
        set({ lintModelAvailable: result?.available ?? false });
      } catch {
        set({ lintModelAvailable: false });
      }
    },

    setLintSeverityFilter(filter) {
      set({ lintSeverityFilter: filter });
    },

    toggleLintChapterSelected(chapterId) {
      set((s) => ({
        lintSelectedChapterIds: s.lintSelectedChapterIds.includes(chapterId)
          ? s.lintSelectedChapterIds.filter((id) => id !== chapterId)
          : [...s.lintSelectedChapterIds, chapterId],
      }));
    },

    setLintConfirmOpen(open) {
      set({ lintConfirmOpen: open });
    },
  };
};
