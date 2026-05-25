import type { AudioTrack, UploadedAudio } from "./audio.types";
import type { BackgroundColorConfig } from "./background.types";
import type { CameraConfig } from "./camera.types";
import type { CanvasElement } from "./canvas-elements.types";
import type { LibraryVideoInfo, ExportQuality, ExportRenderMode, ExportSettings } from "./video.types";
import type { AspectRatio } from "./editor.types";
import type { EditorState, VideoTransform } from "./editor-state.types";
import type { MockupConfig } from "./mockup.types";
import type { Preview3DConfig, ImageMaskConfig } from "./photo.types";
import type { VideoTrackClip } from "./video-track.types";
import type { ZoomFragment } from "./zoom.types";

export type RenderManifestVersion = "1";
export type RenderProjectMode = "video";
export type RenderAssetKind = "video" | "audio" | "image" | "camera-video";
export type RenderAssetAvailability = "server" | "client";
export type RenderJobStatus =
  | "draft"
  | "pending_assets"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";
export type RenderJobIssueSeverity = "info" | "warning" | "error";
export type RenderExecutionTarget = "native-render-worker";
export type RenderContainerFormat = "mp4" | "webm" | "gif";
export type RenderVideoCodec = "h264" | "vp9" | "gif";
export type RenderAudioCodec = "aac" | "opus" | "none";
export type RenderEncoderImplementation = "h264_videotoolbox" | "libx264";

export type RenderAssetSource =
  | {
      type: "supabase-storage";
      bucket: string;
      path: string;
      assetId?: string | null;
    }
  | {
      type: "render-asset-store";
      assetId: string;
      relativePath: string;
    }
  | {
      type: "indexeddb-video";
      libraryVideoId: string;
    }
  | {
      type: "browser-object-url";
      url: string;
    }
  | {
      type: "external-url";
      url: string;
    }
  | {
      type: "public-path";
      path: string;
    }
  | {
      type: "inline-data";
      dataUrl: string;
    };

export interface RenderAssetRef {
  id: string;
  kind: RenderAssetKind;
  availability: RenderAssetAvailability;
  source: RenderAssetSource;
  label?: string;
  mimeType?: string;
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;
    fileSize?: number;
    hasAudio?: boolean;
    originalHasAudio?: boolean;
  };
}

export interface RenderBackgroundSpec {
  tab: EditorState["backgroundTab"];
  selectedWallpaper: number;
  blur: number;
  color: BackgroundColorConfig | null;
  imageAssetId: string | null;
  transparent: boolean;
}

export interface RenderVisualSpec {
  aspectRatio: AspectRatio;
  customDimensions: EditorState["customDimensions"];
  padding: number;
  roundedCorners: number;
  shadows: number;
  cropArea: EditorState["cropArea"];
  mockupId: string;
  mockupConfig: MockupConfig;
  videoTransform: VideoTransform;
  imageTransform: Preview3DConfig;
  apply3DToBackground: boolean;
  imageMaskConfig: ImageMaskConfig;
  videoMaskConfig: ImageMaskConfig;
  canvasElements: CanvasElement[];
  cameraConfig: CameraConfig | null;
  cameraAssetId: string | null;
}

export interface RenderAudioTrackSpec extends AudioTrack {
  assetId: string;
}

export interface RenderVideoClipSpec extends VideoTrackClip {
  assetId: string;
}

export interface RenderTimelineSpec {
  duration: number;
  zoomFragments: ZoomFragment[];
  videoClips: RenderVideoClipSpec[];
  audioTracks: RenderAudioTrackSpec[];
  clipAudioStates?: Record<string, boolean>;
  muteOriginalAudio: boolean;
  masterVolume: number;
  sourceHasAudioTrack: boolean;
}

export interface RenderManifest {
  version: RenderManifestVersion;
  manifestId: string;
  createdAt: string;
  source: "openvid-web-editor";
  mode: RenderProjectMode;
  projectId: string | null;
  projectTitle: string | null;
  trim: NonNullable<ExportSettings["trim"]>;
  outputDuration: number;
  primaryVideoAssetId: string | null;
  background: RenderBackgroundSpec;
  visuals: RenderVisualSpec;
  timeline: RenderTimelineSpec;
  assets: RenderAssetRef[];
}

export interface RenderOutputProfile {
  quality: ExportQuality;
  renderMode: ExportRenderMode;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  container: RenderContainerFormat;
  videoCodec: RenderVideoCodec;
  audioCodec: RenderAudioCodec;
  encoderImplementation: RenderEncoderImplementation;
  x264Crf?: number;
  x264Preset?: "medium" | "slow" | "slower";
  transparentBackground: boolean;
}

export interface RenderJobIssue {
  severity: RenderJobIssueSeverity;
  code: string;
  message: string;
}

export interface RenderJobSubmission {
  manifest: RenderManifest;
  output: RenderOutputProfile;
  execution: {
    target: RenderExecutionTarget;
    fallback: "legacy-browser-export" | "none";
  };
}

export interface RenderJobRecord extends RenderJobSubmission {
  jobId: string;
  status: RenderJobStatus;
  createdAt: string;
  updatedAt: string;
  issues: RenderJobIssue[];
  assetSummary: {
    total: number;
    serverReady: number;
    clientOnly: number;
  };
  worker?: RenderJobWorkerState;
}

export interface CreateRenderManifestInput {
  projectId?: string | null;
  projectTitle?: string | null;
  editorState: EditorState;
  exportSettings: ExportSettings;
  videoDuration: number;
  videoDimensions: { width: number; height: number } | null;
  videoAssets: LibraryVideoInfo[];
  currentVideoAsset?: LibraryVideoInfo | null;
  uploadedAudios: UploadedAudio[];
  videoHasAudioTrack: boolean;
  cameraUrl?: string | null;
  assetOverrides?: Record<string, RenderAssetRef>;
}

export interface RenderProxyProfile {
  id: string;
  kind: "video" | "audio" | "image";
  status: "planned" | "ready" | "failed";
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  bitrate?: number;
  notes?: string;
  relativePath?: string;
  mimeType?: string;
  errorMessage?: string;
}

export interface RenderAssetRecord {
  assetId: string;
  manifestAssetId: string;
  kind: RenderAssetKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
  source: Extract<RenderAssetSource, { type: "render-asset-store" }>;
  metadata: RenderAssetRef["metadata"];
  proxyProfiles: RenderProxyProfile[];
}

export interface RenderJobWorkerLogEntry {
  timestamp: string;
  level: "info" | "warning" | "error";
  message: string;
}

export interface RenderJobGeneratedArtifact {
  id: string;
  kind: "proxy" | "metadata" | "manifest" | "output";
  relativePath: string;
  mimeType: string;
}

export interface RenderJobWorkerState {
  startedAt?: string;
  finishedAt?: string;
  processor: string;
  ffmpegVersion?: string;
  progress?: number;
  stage?: string;
  processedAssetIds: string[];
  generatedArtifacts: RenderJobGeneratedArtifact[];
  logs: RenderJobWorkerLogEntry[];
  summary?: string;
  errorMessage?: string;
}
