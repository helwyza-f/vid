import { QUALITY_SETTINGS, DEFAULT_EXPORT_FPS } from "@/lib/constants";
import type {
  CreateRenderManifestInput,
  RenderAssetAvailability,
  RenderAssetRef,
  RenderAssetSource,
  RenderJobSubmission,
  RenderOutputProfile,
} from "@/types/render.types";
import type { ExportQuality, ExportRenderMode } from "@/types/video.types";

function createManifestId() {
  return `manifest_${crypto.randomUUID()}`;
}

function resolveRenderMode(quality: ExportQuality, requestedMode?: ExportRenderMode): ExportRenderMode {
  if (quality === "gif" || quality === "webm-alpha") {
    return "fast";
  }

  return requestedMode ?? "fast";
}

function resolveOutputBitrate(quality: ExportQuality, mode: ExportRenderMode, baseBitrate: number) {
  if (mode !== "high") {
    return baseBitrate;
  }

  switch (quality) {
    case "4k":
      return 100_000_000;
    case "2k":
      return 36_000_000;
    case "1080p":
      return 20_000_000;
    case "720p":
      return 12_000_000;
    case "480p":
      return 4_000_000;
    default:
      return baseBitrate;
  }
}

function inferAssetSourceFromUrl(url: string): {
  availability: RenderAssetAvailability;
  source: RenderAssetSource;
} {
  if (url.startsWith("blob:")) {
    return {
      availability: "client",
      source: { type: "browser-object-url", url },
    };
  }

  if (url.startsWith("data:")) {
    return {
      availability: "server",
      source: { type: "inline-data", dataUrl: url },
    };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return {
      availability: "server",
      source: { type: "external-url", url },
    };
  }

  return {
    availability: "server",
    source: { type: "public-path", path: url },
  };
}

function createVideoAssetRef(
  asset: CreateRenderManifestInput["videoAssets"][number],
  overrides?: Record<string, RenderAssetRef>
): RenderAssetRef {
  const manifestAssetId = `video:${asset.id}`;
  const override = overrides?.[manifestAssetId];
  if (override) {
    return override;
  }

  if (asset.storagePath) {
    return {
      id: manifestAssetId,
      kind: "video",
      availability: "server",
      source: {
        type: "supabase-storage",
        bucket: "project-assets",
        path: asset.storagePath,
        assetId: asset.cloudAssetId ?? null,
      },
      label: asset.fileName,
      metadata: {
        width: asset.width,
        height: asset.height,
        duration: asset.duration,
        fileSize: asset.fileSize,
        hasAudio: asset.hasAudio,
        originalHasAudio: asset.originalHasAudio,
      },
    };
  }

  return {
    id: manifestAssetId,
    kind: "video",
    availability: "client",
    source: {
      type: "indexeddb-video",
      libraryVideoId: asset.id,
    },
    label: asset.fileName,
    metadata: {
      width: asset.width,
      height: asset.height,
      duration: asset.duration,
      fileSize: asset.fileSize,
      hasAudio: asset.hasAudio,
      originalHasAudio: asset.originalHasAudio,
    },
  };
}

function createAudioAssetRef(
  audio: CreateRenderManifestInput["uploadedAudios"][number],
  overrides?: Record<string, RenderAssetRef>
): RenderAssetRef {
  const manifestAssetId = `audio:${audio.id}`;
  const override = overrides?.[manifestAssetId];
  if (override) {
    return override;
  }

  const sourceInfo = inferAssetSourceFromUrl(audio.url);
  return {
    id: manifestAssetId,
    kind: "audio",
    availability: sourceInfo.availability,
    source: sourceInfo.source,
    label: audio.name,
    mimeType: audio.mimeType,
    metadata: {
      duration: audio.duration,
      fileSize: audio.fileSize,
    },
  };
}

function createImageAssetRef(
  id: string,
  url: string,
  label: string,
  overrides?: Record<string, RenderAssetRef>
): RenderAssetRef {
  const override = overrides?.[id];
  if (override) {
    return override;
  }

  const sourceInfo = inferAssetSourceFromUrl(url);
  return {
    id,
    kind: "image",
    availability: sourceInfo.availability,
    source: sourceInfo.source,
    label,
  };
}

export function buildRenderOutputProfile(
  exportSettings: CreateRenderManifestInput["exportSettings"]
): RenderOutputProfile {
  const qualitySettings = QUALITY_SETTINGS[exportSettings.quality];
  const fps = exportSettings.fps || qualitySettings.fps || DEFAULT_EXPORT_FPS;
  const renderMode = resolveRenderMode(exportSettings.quality, exportSettings.renderMode);
  const bitrate = resolveOutputBitrate(
    exportSettings.quality,
    renderMode,
    qualitySettings.bitrate
  );
  const transparentBackground =
    exportSettings.transparentBackground ||
    exportSettings.quality === "webm-alpha";

  if (exportSettings.quality === "gif") {
    return {
      quality: exportSettings.quality,
      renderMode,
      width: qualitySettings.width,
      height: qualitySettings.height,
      fps,
      bitrate,
      container: "gif",
      videoCodec: "gif",
      audioCodec: "none",
      encoderImplementation: "libx264",
      transparentBackground: false,
    };
  }

  if (transparentBackground) {
    return {
      quality: exportSettings.quality,
      renderMode,
      width: qualitySettings.width,
      height: qualitySettings.height,
      fps,
      bitrate,
      container: "webm",
      videoCodec: "vp9",
      audioCodec: "opus",
      encoderImplementation: "libx264",
      transparentBackground: true,
    };
  }

  return {
    quality: exportSettings.quality,
    renderMode,
    width: qualitySettings.width,
    height: qualitySettings.height,
    fps,
    bitrate,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    encoderImplementation: renderMode === "high" ? "libx264" : "h264_videotoolbox",
    x264Crf: renderMode === "high" ? (exportSettings.quality === "4k" ? 18 : 19) : undefined,
    x264Preset: renderMode === "high" ? "slow" : undefined,
    transparentBackground: false,
  };
}

export function createRenderManifest(input: CreateRenderManifestInput) {
  const trim = input.exportSettings.trim ?? {
    start: 0,
    end: input.videoDuration,
  };
  const now = new Date().toISOString();

  const assets = new Map<string, RenderAssetRef>();

  for (const asset of input.videoAssets) {
    const ref = createVideoAssetRef(asset, input.assetOverrides);
    assets.set(ref.id, ref);
  }

  for (const audio of input.uploadedAudios) {
    const ref = createAudioAssetRef(audio, input.assetOverrides);
    assets.set(ref.id, ref);
  }

  let backgroundImageAssetId: string | null = null;
  if (input.editorState.selectedImageUrl) {
    backgroundImageAssetId = "image:background";
    assets.set(
      backgroundImageAssetId,
      createImageAssetRef(
        backgroundImageAssetId,
        input.editorState.selectedImageUrl,
        "Background image",
        input.assetOverrides
      )
    );
  }

  const canvasImageElements = input.editorState.canvasElements.filter(
    (element) => element.type === "image"
  );
  for (const element of canvasImageElements) {
    assets.set(
      `image:canvas:${element.id}`,
      createImageAssetRef(
        `image:canvas:${element.id}`,
        element.imagePath,
        element.category || "Canvas image",
        input.assetOverrides
      )
    );
  }

  let cameraAssetId: string | null = null;
  if (input.cameraUrl) {
    cameraAssetId = "camera:overlay";
    const override = input.assetOverrides?.[cameraAssetId];
    if (override) {
      assets.set(cameraAssetId, override);
    } else {
      const sourceInfo = inferAssetSourceFromUrl(input.cameraUrl);
      assets.set(cameraAssetId, {
        id: cameraAssetId,
        kind: "camera-video",
        availability: sourceInfo.availability,
        source: sourceInfo.source,
        label: "Camera overlay recording",
      });
    }
  }

  const videoClips = input.editorState.videoClips.map((clip) => ({
    ...clip,
    assetId: `video:${clip.libraryVideoId}`,
  }));

  const audioTracks = input.editorState.audioTracks
    .map((track) => {
      const assetId = `audio:${track.audioId}`;
      if (!assets.has(assetId)) {
        return null;
      }

      return {
        ...track,
        assetId,
      };
    })
    .filter((track): track is NonNullable<typeof track> => track !== null);

  const currentVideoAssetId = input.currentVideoAsset
    ? `video:${input.currentVideoAsset.id}`
    : videoClips[0]?.assetId ?? null;

  return {
    version: "1" as const,
    manifestId: createManifestId(),
    createdAt: now,
    source: "openvid-web-editor" as const,
    mode: "video" as const,
    projectId: input.projectId ?? null,
    projectTitle: input.projectTitle ?? null,
    trim,
    outputDuration: Math.max(0, trim.end - trim.start),
    primaryVideoAssetId: currentVideoAssetId,
    background: {
      tab: input.editorState.backgroundTab,
      selectedWallpaper: input.editorState.selectedWallpaper,
      blur: input.editorState.backgroundBlur,
      color: input.editorState.backgroundColorConfig,
      imageAssetId: backgroundImageAssetId,
      transparent: Boolean(input.exportSettings.transparentBackground),
    },
    visuals: {
      aspectRatio: input.editorState.aspectRatio,
      customDimensions: input.editorState.customDimensions,
      padding: input.editorState.padding,
      roundedCorners: input.editorState.roundedCorners,
      shadows: input.editorState.shadows,
      cropArea: input.editorState.cropArea,
      mockupId: input.editorState.mockupId,
      mockupConfig: input.editorState.mockupConfig,
      videoTransform: input.editorState.videoTransform,
      imageTransform: input.editorState.imageTransform,
      apply3DToBackground: input.editorState.apply3DToBackground,
      imageMaskConfig: input.editorState.imageMaskConfig,
      videoMaskConfig: input.editorState.videoMaskConfig,
      canvasElements: input.editorState.canvasElements,
      cameraConfig: input.editorState.cameraConfig,
      cameraAssetId,
    },
    timeline: {
      duration: input.videoDuration,
      zoomFragments: input.editorState.zoomFragments,
      videoClips,
      audioTracks,
      clipAudioStates: input.exportSettings.clipAudioStates,
      muteOriginalAudio: input.editorState.muteOriginalAudio,
      masterVolume: input.editorState.masterVolume,
      sourceHasAudioTrack: input.videoHasAudioTrack,
    },
    assets: [...assets.values()],
  };
}

export function createRenderJobSubmission(input: CreateRenderManifestInput): RenderJobSubmission {
  return {
    manifest: createRenderManifest(input),
    output: buildRenderOutputProfile(input.exportSettings),
    execution: {
      target: "native-render-worker",
      fallback: "legacy-browser-export",
    },
  };
}
