import type { BinaryFilePayload, FileTreeEntry, ProjectSearchResult, SaveBase64ImageInput, SavedImageFile } from '@orison/shared-contracts';

export type { FileTreeEntry, BinaryFilePayload, SavedImageFile, ProjectSearchResult };

/** Read the preload bridge at call time (not module load) so tests that install a
 *  fake `window.orisonDesktop` per-case see it. Mirrors shared/api/lint.ts. */
function api() {
  return window.orisonDesktop;
}

export async function readDirectory(dir: string, depth?: number): Promise<FileTreeEntry[]> {
  return (await api()?.readDirectory(dir, depth)) ?? [];
}

export async function readFile(fullPath: string): Promise<string | null> {
  return (await api()?.readFile(fullPath)) ?? null;
}

export async function searchProject(projectDir: string, query: string, maxResults?: number): Promise<ProjectSearchResult[]> {
  return (await api()?.searchProject(projectDir, query, maxResults)) ?? [];
}

export async function readFileBinary(filePath: string): Promise<BinaryFilePayload | null> {
  return (await api()?.readFileBinary(filePath)) ?? null;
}

export async function saveBase64Image(projectPath: string, opts: SaveBase64ImageInput): Promise<SavedImageFile> {
  return api()!.saveBase64Image(projectPath, opts);
}

export async function moveProjectFile(projectPath: string, src: string, dest: string): Promise<void> {
  await api()?.moveProjectFile(projectPath, src, dest);
}

export async function deleteProjectFile(projectPath: string, relativePath: string): Promise<void> {
  await api()?.deleteProjectFile(projectPath, relativePath);
}
