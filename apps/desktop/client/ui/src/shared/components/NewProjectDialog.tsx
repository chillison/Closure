import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useI18n } from '../i18n/useI18n';
import { useToastStore } from '../store/toastStore';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss';
import { ensureProjectRegistration } from '../api/projects';

// Story 8.6 R8：结构 pattern 表单行退役（epics.md:755 定案）——创建期不再让作者盲选结构模板，
// 选型移入冷启动对话（story-planner 三型推荐 + 作者确认；derivePatternGuide 链零动）。
// 2026-08-20 dogfood：项目类型行同退役（默认恒为小说；'script' 仍是 schema 合法历史值，老项目展示用）。
// creative_brief 只 seed rawRequirement（项目名兜底，真灵感待对话补——leader 第一问入档）。

type Props = {
  onClose: () => void;
};

export function NewProjectDialog({ onClose }: Props) {
  const openProject = useAppStore((s) => s.openProject);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);
  const showToast = useToastStore((s) => s.showToast);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, onClose);
  const overlayDismiss = useOverlayDismiss(onClose);

  const [name, setName] = useState('');
  const type = 'novel' as const;
  const [parentDir, setParentDir] = useState('');
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handlePickDir = async () => {
    const dir = await window.orisonDesktop?.pickProjectDirectory();
    if (dir) setParentDir(dir);
  };

  const handlePickCover = async () => {
    const file = await window.orisonDesktop?.pickCoverImage();
    if (file) setCoverSrc(file);
  };

  const handleRemoveCover = () => setCoverSrc(null);

  const canCreate = name.trim();

  const handleCreate = async () => {
    if (!canCreate || creating) return;
    setCreating(true);
    try {
      const projectDir = await window.orisonDesktop.createProjectDirectory(parentDir, name.trim());

      let coverImage: string | undefined;
      if (coverSrc) {
        coverImage = await window.orisonDesktop.copyCoverImage(coverSrc, projectDir);
      }

      let projectId: string | undefined;
      try {
        projectId = await ensureProjectRegistration({
          project: { name: name.trim(), type, path: projectDir, coverImage }
        });
      } catch {
        projectId = undefined;
      }

      const meta = {
        name: name.trim(),
        type,
        coverImage: coverImage ?? null,
        projectId: projectId ?? null,
        // project:save-meta handler 把 creativeBrief seed 进 project.yaml.creative_brief
        // （仅创建时，不覆盖既有 brief）。rawRequirement 用项目名兜底（最小落盘）——真灵感
        // 待冷启动对话补（leader 第一问 → creative_brief_update）。
        creativeBrief: { rawRequirement: name.trim() }
      };
      // CR-008：save-meta 失败返回 {ok:false,error}（不抛错），此处检查以保留错误可见性。
      const saveResult = await window.orisonDesktop.saveProjectMeta(projectDir, meta);
      if (!saveResult.ok) {
        throw new Error(saveResult.error);
      }

      const result = await openProject({ projectId, name: name.trim(), path: projectDir, type, coverImage });
      if (!result.opened) {
        if (result.error || result.failed.length > 0) {
          const reason = result.error
            ?? result.failed.map((path) => path.split(/[\\/]/).pop() ?? path).join(', ');
          showToast(`${t('topbar.saveFailed')} — ${reason}`, 'error');
        }
        setCreating(false);
        return;
      }
      // 新项目落地即见工作台（冷启动邀请卡入口）——即便本会话中作者关过面板也重开。
      setAgentPanelOpen(true);
      onClose();
    } catch (err) {
      // Disk/permission/path failures must be visible, not a dead button.
      const reason = err instanceof Error ? err.message : String(err);
      showToast(t('projects.createFailed', { reason }), 'error');
      setCreating(false);
    }
  };

  return (
    <div className="topbar-new-dialog-overlay" role="dialog" aria-modal="true" {...overlayDismiss}>
      <div className="settings-dialog settings-dialog-fit" ref={dialogRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="settings-dialog-header">
          <h2 className="settings-dialog-title">{t('projects.newProject')}</h2>
          <button type="button" className="settings-dialog-close" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="settings-dialog-body">
          {/* 项目名称 */}
          <div className="form-field-row">
            <span className="form-field-label">{t('projects.projectName')}</span>
            <input
              className="auth-input"
              type="text"
              placeholder={t('projects.projectName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
          </div>

          {/* 存储位置 */}
          <div className="form-field-row">
            <span className="form-field-label">{t('projects.location')}</span>
            <div className="new-project-dir-row">
              <input
                className="auth-input new-project-dir-input"
                type="text"
                readOnly
                value={parentDir}
                placeholder={t('projects.locationPlaceholder')}
              />
              <button type="button" className="new-project-dir-btn" onClick={handlePickDir}>
                <span className="material-symbols-outlined">folder_open</span>
              </button>
            </div>
          </div>

          {/* 封面图（可选） */}
          <div className="form-field-row">
            <span className="form-field-label">
              {t('projects.coverImage')}
              <span className="form-field-hint" style={{ marginLeft: '0.4rem', marginTop: 0 }}>
                {t('projects.optional')}
              </span>
            </span>
            {coverSrc ? (
              <div className="new-project-cover-preview">
                <img src={`orison-file:///${coverSrc}`} alt="Cover" className="new-project-cover-img" />
                <button type="button" className="new-project-cover-remove" onClick={handleRemoveCover} aria-label="Remove">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            ) : (
              <button type="button" className="new-project-cover-pick" onClick={handlePickCover}>
                <span className="material-symbols-outlined">add_photo_alternate</span>
                <span>{t('projects.pickCover')}</span>
              </button>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="topbar-new-dialog-actions">
            <button
              type="button"
              className="auth-submit"
              onClick={handleCreate}
              disabled={!canCreate || creating}
            >
              {creating ? t('auth.pleaseWait') : t('projects.create')}
            </button>
            <button type="button" className="projects-cancel" onClick={onClose}>
              {t('projects.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
