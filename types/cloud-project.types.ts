import type { EditorState } from "./editor-state.types";

export type ProjectAssetType = "video" | "audio" | "image";

export interface CloudProject {
  id: string;
  userId: string;
  title: string;
  thumbnailPath: string | null;
  duration: number;
  editorState: Partial<EditorState>;
  createdAt: string;
  updatedAt: string;
}

export interface CloudProjectAsset {
  id: string;
  projectId: string;
  userId: string;
  type: ProjectAssetType;
  fileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  fileSize: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface CreateProjectAssetInput {
  type: ProjectAssetType;
  file: Blob;
  fileName: string;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailPath?: string | null;
}
