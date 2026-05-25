import type {
  RenderAssetKind,
  RenderAssetRecord,
  RenderAssetRef,
  RenderProxyProfile,
} from "@/types/render.types";
import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE_ROOT = path.join(process.cwd(), ".render-cache");
const ASSETS_ROOT = path.join(CACHE_ROOT, "assets");

export function getRenderCacheRoot() {
  return CACHE_ROOT;
}

function assetDir(assetId: string) {
  return path.join(ASSETS_ROOT, assetId);
}

function metadataPath(assetId: string) {
  return path.join(assetDir(assetId), "metadata.json");
}

function sanitizeFileName(fileName: string) {
  const trimmed = fileName.trim() || "asset";
  return trimmed.replace(/[^\w.-]+/g, "-");
}

async function ensureAssetDir(assetId: string) {
  await fs.mkdir(assetDir(assetId), { recursive: true });
}

export function getRenderAssetDir(assetId: string) {
  return assetDir(assetId);
}

export function getRenderAssetAbsolutePath(asset: RenderAssetRecord) {
  return path.join(CACHE_ROOT, asset.source.relativePath);
}

export async function updateRenderAsset(record: RenderAssetRecord): Promise<void> {
  await ensureAssetDir(record.assetId);
  await fs.writeFile(metadataPath(record.assetId), JSON.stringify(record, null, 2), "utf8");
}

function createProxyProfiles(
  kind: RenderAssetKind,
  metadata: RenderAssetRef["metadata"],
  mimeType: string
): RenderProxyProfile[] {
  if (kind === "video" || kind === "camera-video") {
    return [
      {
        id: "preview-720p30",
        kind: "video",
        status: "planned",
        width: 1280,
        height: 720,
        fps: 30,
        codec: "h264",
        bitrate: 3_500_000,
        notes: "Fast editor preview proxy",
      },
      {
        id: "preview-1080p60",
        kind: "video",
        status: "planned",
        width: 1920,
        height: 1080,
        fps: 60,
        codec: "h264",
        bitrate: 8_000_000,
        notes: "High-fidelity preview proxy",
      },
    ];
  }

  if (kind === "audio") {
    return [
      {
        id: "waveform-json",
        kind: "audio",
        status: "planned",
        notes: "Waveform extraction for timeline rendering",
      },
      {
        id: "preview-aac",
        kind: "audio",
        status: "planned",
        codec: mimeType.includes("mpeg") ? "mp3" : "aac",
        notes: "Normalized audio preview asset",
      },
    ];
  }

  if (kind === "image") {
    return [
      {
        id: "preview-webp",
        kind: "image",
        status: "planned",
        width: metadata?.width,
        height: metadata?.height,
        codec: "webp",
        notes: "Decoded preview image for editor and render worker warm-up",
      },
    ];
  }

  return [];
}

export async function saveRenderAsset(params: {
  manifestAssetId: string;
  kind: RenderAssetKind;
  fileName: string;
  mimeType: string;
  fileBuffer: Uint8Array;
  metadata: RenderAssetRef["metadata"];
}): Promise<RenderAssetRecord> {
  const assetId = `asset_${crypto.randomUUID()}`;
  await ensureAssetDir(assetId);

  const safeName = sanitizeFileName(params.fileName);
  const originalPath = path.join(assetDir(assetId), safeName);
  await fs.writeFile(originalPath, params.fileBuffer);

  const record: RenderAssetRecord = {
    assetId,
    manifestAssetId: params.manifestAssetId,
    kind: params.kind,
    fileName: safeName,
    mimeType: params.mimeType,
    fileSize: params.fileBuffer.byteLength,
    createdAt: new Date().toISOString(),
    source: {
      type: "render-asset-store",
      assetId,
      relativePath: path.relative(CACHE_ROOT, originalPath),
    },
    metadata: params.metadata,
    proxyProfiles: createProxyProfiles(params.kind, params.metadata, params.mimeType),
  };

  await fs.writeFile(metadataPath(assetId), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function getRenderAsset(assetId: string): Promise<RenderAssetRecord | null> {
  try {
    const raw = await fs.readFile(metadataPath(assetId), "utf8");
    return JSON.parse(raw) as RenderAssetRecord;
  } catch {
    return null;
  }
}

export async function listRenderAssets(): Promise<RenderAssetRecord[]> {
  try {
    await fs.mkdir(ASSETS_ROOT, { recursive: true });
    const entries = await fs.readdir(ASSETS_ROOT);
    const assets = await Promise.all(entries.map((entry) => getRenderAsset(entry)));
    return assets.filter((asset): asset is RenderAssetRecord => asset !== null);
  } catch {
    return [];
  }
}
