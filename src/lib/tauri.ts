import { invoke } from "@tauri-apps/api/core";
import type {
  ApplySyncResponse,
  OpenProjectResponse,
  PreviewResponse,
  SourceFile,
  SyncPlan,
} from "./types";

export function pickProjectDirectory(): Promise<string | null> {
  return invoke<string | null>("pick_project_directory");
}

export function openProject(originalPath: string): Promise<OpenProjectResponse> {
  return invoke<OpenProjectResponse>("open_project", { originalPath });
}

export function listSnapshotFiles(snapshotId: string): Promise<SourceFile[]> {
  return invoke<SourceFile[]>("list_snapshot_files", { snapshotId });
}

export function readSnapshotFile(snapshotId: string, path: string): Promise<SourceFile> {
  return invoke<SourceFile>("read_snapshot_file", { snapshotId, path });
}

export function writeSnapshotFile(
  snapshotId: string,
  path: string,
  content: string,
): Promise<SourceFile> {
  return invoke<SourceFile>("write_snapshot_file", { snapshotId, path, content });
}

export function installDependencies(snapshotId: string): Promise<string> {
  return invoke<string>("install_dependencies", { snapshotId });
}

export function startPreview(snapshotId: string): Promise<PreviewResponse> {
  return invoke<PreviewResponse>("start_preview", { snapshotId });
}

export function stopPreview(snapshotId: string): Promise<void> {
  return invoke<void>("stop_preview", { snapshotId });
}

export function createSyncPlan(snapshotId: string): Promise<SyncPlan> {
  return invoke<SyncPlan>("create_sync_plan", { snapshotId });
}

export function applySync(snapshotId: string, files: string[]): Promise<ApplySyncResponse> {
  return invoke<ApplySyncResponse>("apply_sync", { snapshotId, files });
}
