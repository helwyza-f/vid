"use client";

import { createClient } from "@/utils/supabase/client";
import type {
  CloudProject,
  CloudProjectAsset,
  CreateProjectAssetInput,
} from "@/types/cloud-project.types";
import type { EditorState } from "@/types/editor-state.types";

const PROJECT_ASSETS_BUCKET = "project-assets";

type ProjectRow = {
  id: string;
  user_id: string;
  title: string;
  thumbnail_path: string | null;
  duration: number;
  editor_state: Partial<EditorState> | null;
  created_at: string;
  updated_at: string;
};

type AssetRow = {
  id: string;
  project_id: string;
  user_id: string;
  type: "video" | "audio" | "image";
  file_name: string;
  storage_path: string;
  thumbnail_path: string | null;
  file_size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
};

function mapProject(row: ProjectRow): CloudProject {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    thumbnailPath: row.thumbnail_path,
    duration: row.duration,
    editorState: row.editor_state ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row: AssetRow): CloudProjectAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    type: row.type,
    fileName: row.file_name,
    storagePath: row.storage_path,
    thumbnailPath: row.thumbnail_path,
    fileSize: row.file_size,
    duration: row.duration,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

async function requireUserId() {
  const supabase = createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error("You must sign in to use cloud projects.");
  }

  return { supabase, userId: user.id };
}

export async function listProjects(): Promise<CloudProject[]> {
  const { supabase } = await requireUserId();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as ProjectRow[]).map(mapProject);
}

export async function createProject(title = "Untitled project"): Promise<CloudProject> {
  const { supabase, userId } = await requireUserId();
  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: userId,
      title,
      editor_state: {},
    })
    .select("*")
    .single();

  if (error) throw error;
  return mapProject(data as ProjectRow);
}

export async function getProject(projectId: string): Promise<CloudProject | null> {
  const { supabase } = await requireUserId();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapProject(data as ProjectRow) : null;
}

export async function updateProject(
  projectId: string,
  updates: {
    title?: string;
    duration?: number;
    editorState?: Partial<EditorState>;
    thumbnailPath?: string | null;
  }
): Promise<CloudProject> {
  const { supabase } = await requireUserId();
  const payload: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.duration !== undefined) payload.duration = updates.duration;
  if (updates.editorState !== undefined) payload.editor_state = updates.editorState;
  if (updates.thumbnailPath !== undefined) payload.thumbnail_path = updates.thumbnailPath;

  const { data, error } = await supabase
    .from("projects")
    .update(payload)
    .eq("id", projectId)
    .select("*")
    .single();

  if (error) throw error;
  return mapProject(data as ProjectRow);
}

export async function deleteProject(projectId: string): Promise<void> {
  const { supabase } = await requireUserId();
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;
}

export async function listProjectAssets(projectId: string): Promise<CloudProjectAsset[]> {
  const { supabase } = await requireUserId();
  const { data, error } = await supabase
    .from("project_assets")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as AssetRow[]).map(mapAsset);
}

export async function createProjectAsset(
  projectId: string,
  input: CreateProjectAssetInput
): Promise<CloudProjectAsset> {
  const { supabase, userId } = await requireUserId();
  const assetId = crypto.randomUUID();
  const safeFileName = input.fileName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  const storagePath = `${userId}/${projectId}/${assetId}/${safeFileName || "asset"}`;

  const { error: uploadError } = await supabase.storage
    .from(PROJECT_ASSETS_BUCKET)
    .upload(storagePath, input.file, {
      cacheControl: "31536000",
      upsert: false,
      contentType: input.file.type || undefined,
    });

  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .from("project_assets")
    .insert({
      id: assetId,
      project_id: projectId,
      user_id: userId,
      type: input.type,
      file_name: input.fileName,
      storage_path: storagePath,
      thumbnail_path: input.thumbnailPath ?? null,
      file_size: input.file.size,
      duration: input.duration ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
    })
    .select("*")
    .single();

  if (error) throw error;
  return mapAsset(data as AssetRow);
}

export async function downloadProjectAsset(asset: CloudProjectAsset): Promise<Blob> {
  const { supabase } = await requireUserId();
  const { data, error } = await supabase.storage
    .from(PROJECT_ASSETS_BUCKET)
    .download(asset.storagePath);

  if (error) throw error;
  return data;
}
