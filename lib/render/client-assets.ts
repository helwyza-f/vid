"use client";

import type { RenderAssetRecord, RenderAssetRef } from "@/types/render.types";

export function shouldPromoteClientUrl(url: string | null | undefined): boolean {
  return Boolean(url && (url.startsWith("blob:") || url.startsWith("data:")));
}

export async function uploadRenderAsset(params: {
  manifestAssetId: string;
  kind: "video" | "audio" | "image" | "camera-video";
  file: Blob;
  fileName: string;
  mimeType?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    hasAudio?: boolean;
    originalHasAudio?: boolean;
  };
}): Promise<RenderAssetRecord> {
  const formData = new FormData();
  formData.set("manifestAssetId", params.manifestAssetId);
  formData.set("kind", params.kind);
  formData.set("file", params.file, params.fileName);
  formData.set("fileName", params.fileName);
  formData.set("mimeType", params.mimeType || params.file.type || "application/octet-stream");

  if (params.metadata?.width !== undefined) formData.set("width", String(params.metadata.width));
  if (params.metadata?.height !== undefined) formData.set("height", String(params.metadata.height));
  if (params.metadata?.duration !== undefined) formData.set("duration", String(params.metadata.duration));
  if (params.metadata?.hasAudio !== undefined) formData.set("hasAudio", String(params.metadata.hasAudio));
  if (params.metadata?.originalHasAudio !== undefined) {
    formData.set("originalHasAudio", String(params.metadata.originalHasAudio));
  }

  const response = await fetch("/api/render/assets", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload render asset: ${response.status}`);
  }

  const data = (await response.json()) as { asset: RenderAssetRecord };
  return data.asset;
}

export function createRenderAssetOverride(record: RenderAssetRecord): RenderAssetRef {
  return {
    id: record.manifestAssetId,
    kind: record.kind,
    availability: "server",
    source: record.source,
    label: record.fileName,
    mimeType: record.mimeType,
    metadata: record.metadata,
  };
}
