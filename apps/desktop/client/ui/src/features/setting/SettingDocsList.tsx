/**
 * 设定文档区块（task 08-30-asset-cards-visualization B 波 W5，design §7；CR patch 波修订）。
 *
 * settings/ 子目录 md 文件列表——**只做入口**（W0 拍板决策 4：文档区块仅列表，原生 MD
 * 编辑已存在——文件 tab TipTap，不造新编辑器）：
 *   - 数据 = 既有 readDirectory IPC 指向子目录（签名本就收任意目录路径——ProjectTree
 *     loadChildrenIfNeeded 同用法，零 shell 改动）；目录不存在 → []（空态）。
 *   - 行 = 文件名去 .md；点击经既有文件打开通道（readFile + openFile——ProjectTree
 *     handleSelect 同链），编辑即现有 TipTap markdown。**读失败不开空 tab**（CR P13：
 *     空内容 tab 一保存即截断有内容 md——失败走错误 toast，tab 不开、不新建）。
 *   - tab 显隐/死态/空态语义（CR-004 裁决 4，SettingPage 派生 docsDead）：hook 报
 *     entries/loading/loaded/hadEntries——初装即空 = 死态（tab 隐藏/回落 cards）；
 *     装载后被清空（hadEntries=true）且用户停 docs tab → tab 内显空态（docs.empty）。
 *   - 外部变更刷新：orison:tool-event file:changed（ProjectTree 同事件面——agent 写
 *     settings/*.md 后列表跟新）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../shared/i18n/useI18n';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import { normalizePath } from '../../shared/utils/paths';
import { readDirectory, readFile } from '../../shared/api/filesystem';

export type SettingDocEntry = {
  /** 文件名（含 .md）——磁盘身份。 */
  name: string;
  /** 显示名（去 .md）。 */
  label: string;
};

export type SettingDocsState = {
  entries: SettingDocEntry[];
  loading: boolean;
  /** 首次装载已落定（死态判定用——loading 期不判死，CR-004 裁决 4）。 */
  loaded: boolean;
  /** 本挂载周期内曾有过文档（装载后被清空 ≠ 初装即空——tab 内空态 vs 死态回落的分流）。 */
  hadEntries: boolean;
};

// 初态 loading:true——装载在挂载 effect 即发，首帧就以骨架呈现（防先闪 docs.empty 再骨架）。
const EMPTY_DOCS: SettingDocsState = { entries: [], loading: true, loaded: false, hadEntries: false };
/** 无项目路径：无 docs 可言——视为已落定死态（tab 回落 cards）。 */
const NO_PROJECT_DOCS: SettingDocsState = { entries: [], loading: false, loaded: true, hadEntries: false };

function extractDocEntries(raw: unknown): SettingDocEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SettingDocEntry[] = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    const rec = el as Record<string, unknown>;
    if (rec.isDir === true) continue;
    if (typeof rec.name !== 'string' || !rec.name.toLowerCase().endsWith('.md')) continue;
    out.push({ name: rec.name, label: rec.name.slice(0, -3) });
  }
  // readDirectory 已排序（目录优先+字典序）；再排序一次保证 md-only 过滤后字典序稳定。
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * settings/*.md 列表装载（SettingPage 消费——tab 显隐需要可用性在页面层）。
 * 竞态守卫：epoch 计数 + 项目路径复核（ProjectTree loadTree 同模式）。
 */
export function useSettingDocs(projectPath: string | undefined): SettingDocsState {
  const [state, setState] = useState<SettingDocsState>(EMPTY_DOCS);
  const epochRef = useRef(0);
  const hadEntriesRef = useRef(false);

  const load = useCallback(async () => {
    const requestEpoch = ++epochRef.current;
    if (!projectPath) {
      hadEntriesRef.current = false;
      setState(NO_PROJECT_DOCS);
      return;
    }
    const capturedPath = projectPath;
    const isCurrent = () =>
      requestEpoch === epochRef.current
      && useAppStore.getState().currentProject?.path === capturedPath;
    setState((prev) => ({ ...prev, loading: true }));
    let entries: SettingDocEntry[] = [];
    try {
      const raw = await readDirectory(normalizePath(`${capturedPath}/settings`), 1);
      if (!isCurrent()) return;
      entries = extractDocEntries(raw);
    } catch {
      if (!isCurrent()) return;
      entries = []; // 目录读失败（不存在/权限）→ 空态，不炸页面
    }
    if (entries.length > 0) hadEntriesRef.current = true;
    setState({ entries, loading: false, loaded: true, hadEntries: hadEntriesRef.current });
  }, [projectPath]);

  useEffect(() => {
    // 项目切换重置 hadEntries（新目录的装载历史从头计——初装即空即死态）。
    hadEntriesRef.current = false;
    void load();
  }, [load]);

  // 外部变更刷新（ProjectTree 同事件面）：file:changed 时重拉（agent 写 settings/*.md）。
  useEffect(() => {
    if (!projectPath) return;
    const handler = (e: Event) => {
      const { type } = (e as CustomEvent).detail ?? {};
      if (type === 'file:changed') void load();
    };
    window.addEventListener('orison:tool-event', handler);
    return () => window.removeEventListener('orison:tool-event', handler);
  }, [projectPath, load]);

  return state;
}

export function SettingDocsList({ state }: { state: SettingDocsState }) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const openFile = useAppStore((s) => s.openFile);

  const handleOpen = async (name: string) => {
    const projectPath = useAppStore.getState().currentProject?.path;
    if (!projectPath) return;
    const capturedPath = projectPath;
    const fullPath = normalizePath(`${capturedPath}/settings/${name}`);
    try {
      const content = await readFile(fullPath);
      if (useAppStore.getState().currentProject?.path !== capturedPath) return; // 竞态守卫
      // 读失败（null/异常）不开空 tab（CR P13）：空内容 tab 一保存即截断有内容 md——
      // 错误 toast + tab 不开（复用全库 toast 通道）。
      if (content === null) {
        useToastStore.getState().showToast(t('settingPage.docs.openFailed', { name }), 'error');
        return;
      }
      openFile(fullPath, name, content);
    } catch {
      if (useAppStore.getState().currentProject?.path !== capturedPath) return;
      useToastStore.getState().showToast(t('settingPage.docs.openFailed', { name }), 'error');
    }
  };

  if (state.loading) {
    return <div className="setting-docs-list" data-setting-docs-loading="true">{t('settingPage.docs.loading')}</div>;
  }
  if (state.entries.length === 0) {
    // CR-004 裁决 4：装载后被清空且用户停 docs tab → tab 内空态（死态由 SettingPage 派生
    // docsDead 回落 cards，不进此分支）。
    return <div className="setting-docs-list" data-setting-docs-empty>{t('settingPage.docs.empty')}</div>;
  }
  return (
    <ul className="setting-docs-list">
      {state.entries.map((entry) => (
        // CR P11（BH-008）：`<button role="listitem">` 抹掉按钮隐式角色（读屏不播报可交互）
        // ——改为语义正确结构 ul > li > button。
        <li key={entry.name} className="setting-docs-item">
          <button
            type="button"
            className="setting-docs-row"
            data-setting-doc={entry.name}
            onClick={() => { void handleOpen(entry.name); }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">description</span>
            <span className="setting-docs-name">{entry.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
