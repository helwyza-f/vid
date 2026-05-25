import {
  getRenderAsset,
  getRenderAssetAbsolutePath,
  getRenderAssetDir,
  getRenderCacheRoot,
  updateRenderAsset,
} from "@/lib/render/asset-store";
import { getRenderJob, updateRenderJob } from "@/lib/render/job-store";
import { getWallpaperUrl } from "@/lib/wallpaper.utils";
import { BOTTOM_ONLY_RADIUS_MOCKUPS, VIDEO_Z_INDEX } from "@/lib/constants";
import { getCameraLayout, type CameraShape } from "@/types/camera.types";
import type { CanvasElement, ImageElement, TextElement } from "@/types/canvas-elements.types";
import { speedToTransitionMs, zoomLevelToFactor, type ZoomFragment } from "@/types/zoom.types";
import type {
  RenderAssetRecord,
  RenderJobGeneratedArtifact,
  RenderJobRecord,
  RenderJobIssue,
  RenderOutputProfile,
  RenderJobWorkerLogEntry,
  RenderProxyProfile,
} from "@/types/render.types";
import { deriveSearchBg, hexToRgb } from "@/lib/color.utils";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_COLOR = "#000000";
const NATIVE_SUPPORTED_MOCKUPS = new Set(["macos"]);
const TEXT_KEY_COLOR = "#ff00ff";

function createLog(level: RenderJobWorkerLogEntry["level"], message: string): RenderJobWorkerLogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
}

async function runCommand(file: string, args: string[]) {
  return execFileAsync(file, args, {
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function getFfmpegVersion() {
  const { stdout } = await runCommand("ffmpeg", ["-version"]);
  return stdout.split("\n")[0]?.trim() || "ffmpeg";
}

let drawTextSupportPromise: Promise<boolean> | null = null;

async function supportsDrawTextFilter() {
  if (!drawTextSupportPromise) {
    drawTextSupportPromise = execFileAsync("ffmpeg", ["-hide_banner", "-filters"], {
      maxBuffer: 32 * 1024 * 1024,
    })
      .then(({ stdout, stderr }) => `${stdout}\n${stderr}`.includes(" drawtext "))
      .catch(() => false);
  }

  return drawTextSupportPromise;
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function rasterizeSvgWithQuickLook(inputPath: string, size: number, outputDir: string) {
  await ensureDir(outputDir);
  await runCommand("qlmanage", [
    "-t",
    "-s",
    String(Math.max(64, Math.round(size))),
    "-o",
    outputDir,
    inputPath,
  ]);
  return path.join(outputDir, `${path.basename(inputPath)}.png`);
}

async function probeAudioDuration(inputPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function probeMediaDuration(inputPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeMimeExtension(mimeType: string | undefined) {
  if (!mimeType) {
    return "bin";
  }

  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("svg")) return "svg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";

  return mimeType.split("/").pop()?.replace(/[^a-z0-9]/gi, "") || "bin";
}

async function resolveInputPath(asset: RenderAssetRecord): Promise<string> {
  return getRenderAssetAbsolutePath(asset);
}

async function resolveManifestAssetInputPath(job: RenderJobRecord, manifestAssetId: string) {
  const manifestAsset = job.manifest.assets.find((asset) => asset.id === manifestAssetId);
  if (!manifestAsset) {
    throw new Error(`Manifest asset not found: ${manifestAssetId}`);
  }

  switch (manifestAsset.source.type) {
    case "render-asset-store": {
      const assetRecord = await getRenderAsset(manifestAsset.source.assetId);
      if (!assetRecord) {
        throw new Error(`Render asset record missing: ${manifestAsset.source.assetId}`);
      }
      return {
        manifestAsset,
        assetRecord,
        inputPath: await resolveInputPath(assetRecord),
      };
    }
    case "public-path":
      return {
        manifestAsset,
        assetRecord: null,
        inputPath: path.join(process.cwd(), "public", manifestAsset.source.path.replace(/^\/+/, "")),
      };
    case "external-url":
      return {
        manifestAsset,
        assetRecord: null,
        inputPath: manifestAsset.source.url,
      };
    case "inline-data": {
      const inlineDir = path.join(getRenderCacheRoot(), "jobs", job.jobId, "inline-assets");
      await ensureDir(inlineDir);
      const extension = sanitizeMimeExtension(manifestAsset.mimeType);
      const inlinePath = path.join(inlineDir, `${manifestAsset.id.replace(/[^a-z0-9_-]/gi, "_")}.${extension}`);
      try {
        await fs.access(inlinePath);
      } catch {
        const data = manifestAsset.source.dataUrl.split(",")[1];
        if (!data) {
          throw new Error(`Malformed inline asset for ${manifestAsset.id}`);
        }
        await fs.writeFile(inlinePath, Buffer.from(data, "base64"));
      }
      return {
        manifestAsset,
        assetRecord: null,
        inputPath: inlinePath,
      };
    }
    default:
      throw new Error(`Unsupported asset source for native worker: ${manifestAsset.source.type}`);
  }
}

function proxyPath(asset: RenderAssetRecord, fileName: string) {
  return path.join(getRenderAssetDir(asset.assetId), "proxies", fileName);
}

function artifactRelativePath(absolutePath: string) {
  return path.relative(getRenderCacheRoot(), absolutePath);
}

function getRefSize(width: number, height: number) {
  return Math.min(width, height);
}

function getElementSizePx(element: CanvasElement, width: number, height: number) {
  const refSize = getRefSize(width, height);
  return {
    width: Math.max(1, Math.round((element.width / 100) * refSize)),
    height: Math.max(1, Math.round((element.height / 100) * refSize)),
  };
}

function getElementCenterPx(element: CanvasElement, width: number, height: number) {
  return {
    x: Number(((element.x / 100) * width).toFixed(2)),
    y: Number(((element.y / 100) * height).toFixed(2)),
  };
}

function escapeFilterValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveBackgroundColor(job: RenderJobRecord) {
  const { color } = job.manifest.background;
  if (!color) {
    return DEFAULT_COLOR;
  }

  if (color.type === "solid") {
    return color.config.color || DEFAULT_COLOR;
  }

  return color.config.stops[0]?.color || DEFAULT_COLOR;
}

function getH264EncodingArgs(output: RenderOutputProfile) {
  if (output.encoderImplementation === "libx264") {
    return [
      "-c:v",
      "libx264",
      "-preset",
      output.x264Preset ?? "slow",
      "-crf",
      String(output.x264Crf ?? 18),
      "-maxrate",
      String(output.bitrate),
      "-bufsize",
      String(output.bitrate * 2),
    ];
  }

  return [
    "-c:v",
    "h264_videotoolbox",
    "-b:v",
    String(output.bitrate),
  ];
}

function isNativeSupportedMockup(mockupId: string) {
  return NATIVE_SUPPORTED_MOCKUPS.has(mockupId);
}

function ffmpegColorFromHex(hex: string, alpha = 1) {
  try {
    const [r, g, b] = hexToRgb(hex);
    return `0x${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}@${formatFilterNumber(alpha)}`;
  } catch {
    return `0x000000@${formatFilterNumber(alpha)}`;
  }
}

function formatFilterNumber(value: number) {
  return Number(value.toFixed(6)).toString();
}

function buildRangeFadeFactorExpression(
  positionExpr: string,
  from: number,
  to: number
) {
  const start = Math.max(0, Math.min(1, from));
  const end = Math.max(start + 0.0001, Math.min(1, to));
  return `if(lte(${positionExpr},${formatFilterNumber(start)}),0,if(gte(${positionExpr},${formatFilterNumber(end)}),1,((${positionExpr})-${formatFilterNumber(start)})/${formatFilterNumber(end - start)}))`;
}

function buildMaskFactorExpression(maskConfig: RenderJobRecord["manifest"]["visuals"]["videoMaskConfig"] | RenderJobRecord["manifest"]["visuals"]["imageMaskConfig"]) {
  if (!maskConfig?.enabled) {
    return "1";
  }

  const factors: string[] = [];
  const xNorm = "(X/W)";
  const yNorm = "(Y/H)";

  if (maskConfig.top) {
    factors.push(buildRangeFadeFactorExpression(yNorm, maskConfig.top.from / 100, (maskConfig.top.to ?? 100) / 100));
  }
  if (maskConfig.bottom) {
    factors.push(buildRangeFadeFactorExpression(`(1-(${yNorm}))`, maskConfig.bottom.from / 100, (maskConfig.bottom.to ?? 100) / 100));
  }
  if (maskConfig.left) {
    factors.push(buildRangeFadeFactorExpression(xNorm, maskConfig.left.from / 100, (maskConfig.left.to ?? 100) / 100));
  }
  if (maskConfig.right) {
    factors.push(buildRangeFadeFactorExpression(`(1-(${xNorm}))`, maskConfig.right.from / 100, (maskConfig.right.to ?? 100) / 100));
  }
  if (maskConfig.angle !== undefined) {
    const angleRad = (maskConfig.angle * Math.PI) / 180;
    const projectionExpr = `((((X-W/2)*${formatFilterNumber(Math.cos(angleRad))})+((Y-H/2)*${formatFilterNumber(Math.sin(angleRad))}))/sqrt(W*W+H*H))+0.5`;
    factors.push(buildRangeFadeFactorExpression(projectionExpr, (maskConfig.angleFrom ?? 0) / 100, (maskConfig.angleTo ?? 100) / 100));
  }

  if (factors.length === 0) {
    return "1";
  }

  return factors.map((factor) => `(${factor})`).join("*");
}

function buildRoundedRectFactorExpression(radius: number, bottomOnly = false) {
  if (radius <= 0.5) {
    return "1";
  }

  const r = formatFilterNumber(radius);
  if (bottomOnly) {
    return `if(lte(Y,H-${r}),1,if(between(X,${r},W-${r}),1,if(lte(pow(X-${r},2)+pow(Y-(H-${r}),2),pow(${r},2)),1,if(lte(pow(X-(W-${r}),2)+pow(Y-(H-${r}),2),pow(${r},2)),1,0))))`;
  }

  const dx = `max(max(abs(X-W/2)-(W/2-${r}),0),0)`;
  const dy = `max(max(abs(Y-H/2)-(H/2-${r}),0),0)`;
  return `if(lte(pow(${dx},2)+pow(${dy},2),pow(${r},2)),1,0)`;
}

function buildCameraShapeFactorExpression(shape: CameraShape) {
  if (shape === "square") {
    return "1";
  }

  if (shape === "circle") {
    return `if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),1,0)`;
  }

  return `if(lte(pow(abs((X-W/2)/(W/2)),4)+pow(abs((Y-H/2)/(H/2)),4),1),1,0)`;
}

function clamp01Expression(raw: string) {
  return `max(0,min(1,${raw}))`;
}

function easeOutQuartExpression(progressExpr: string) {
  return `(1-pow(1-(${progressExpr}),4))`;
}

function easeInOutQuartExpression(progressExpr: string) {
  return `if(lte(${progressExpr},0.5),8*pow(${progressExpr},4),1-pow(-2*${progressExpr}+2,4)/2)`;
}

function buildNestedIfExpression(
  segments: Array<{ condition: string; value: string }>,
  fallback: string
) {
  return segments.reduceRight(
    (current, segment) => `if(${segment.condition},${segment.value},${current})`,
    fallback
  );
}

function buildZoomExpressions(zoomFragments: ZoomFragment[]) {
  if (zoomFragments.length === 0) {
    return {
      scale: "1",
      focusX: "50",
      focusY: "50",
      has3D: false,
    };
  }

  const scaleSegments: Array<{ condition: string; value: string }> = [];
  const focusXSegments: Array<{ condition: string; value: string }> = [];
  const focusYSegments: Array<{ condition: string; value: string }> = [];
  let has3D = false;

  const fragments = [...zoomFragments].sort((a, b) => a.startTime - b.startTime);
  for (const fragment of fragments) {
    const start = formatFilterNumber(fragment.startTime);
    const end = formatFilterNumber(fragment.endTime);
    const transitionSeconds = Math.max(0.001, speedToTransitionMs(fragment.speed) / 1000);
    const transition = formatFilterNumber(transitionSeconds);
    const entryEnd = formatFilterNumber(fragment.startTime + transitionSeconds);
    const exitStart = formatFilterNumber(Math.max(fragment.startTime, fragment.endTime - transitionSeconds));
    const targetScale = formatFilterNumber(zoomLevelToFactor(fragment.zoomLevel));
    const focusX = formatFilterNumber(fragment.focusX);
    const focusY = formatFilterNumber(fragment.focusY);
    const movementEndX = formatFilterNumber(fragment.movementEndX ?? fragment.focusX);
    const movementEndY = formatFilterNumber(fragment.movementEndY ?? fragment.focusY);
    const isAdvanced = Boolean(fragment.enable3D || fragment.movementEnabled);

    if (fragment.enable3D) {
      has3D = true;
    }

    if (isAdvanced) {
      const entryProgress = clamp01Expression(`(t-${start})/${transition}`);
      const exitProgress = clamp01Expression(`(t-${exitStart})/${transition}`);
      const entryEase = easeOutQuartExpression(entryProgress);
      const exitEase = easeOutQuartExpression(exitProgress);
      const holdStart = fragment.startTime + transitionSeconds;
      const holdEnd = fragment.endTime - transitionSeconds;
      const holdDuration = Math.max(0, holdEnd - holdStart);
      const moveStartOffset = fragment.movementStartOffset ?? 0;
      const moveEndOffset = fragment.movementEndOffset ?? holdDuration;
      const movementStartTime = formatFilterNumber(holdStart + Math.max(0, Math.min(moveStartOffset, holdDuration)));
      const movementEndTime = formatFilterNumber(holdStart + Math.max(moveStartOffset, Math.min(moveEndOffset, holdDuration)));
      const movementDuration = Math.max(0.001, Number(movementEndTime) - Number(movementStartTime));
      const moveProgress = clamp01Expression(`(t-${movementStartTime})/${formatFilterNumber(movementDuration)}`);
      const moveEase = easeInOutQuartExpression(moveProgress);
      const movingFocusX = `${focusX}+(${movementEndX}-${focusX})*${moveEase}`;
      const movingFocusY = `${focusY}+(${movementEndY}-${focusY})*${moveEase}`;
      const movementFocusXExpr = fragment.movementEnabled
        ? buildNestedIfExpression([
            { condition: `between(t,${movementStartTime},${movementEndTime})`, value: movingFocusX },
            { condition: `gte(t,${movementEndTime})`, value: movementEndX },
          ], focusX)
        : focusX;
      const movementFocusYExpr = fragment.movementEnabled
        ? buildNestedIfExpression([
            { condition: `between(t,${movementStartTime},${movementEndTime})`, value: movingFocusY },
            { condition: `gte(t,${movementEndTime})`, value: movementEndY },
          ], focusY)
        : focusY;

      scaleSegments.push(
        { condition: `between(t,${start},${entryEnd})`, value: `1+(${targetScale}-1)*${entryEase}` },
        { condition: `between(t,${entryEnd},${exitStart})`, value: targetScale },
        { condition: `between(t,${exitStart},${end})`, value: `${targetScale}-(${targetScale}-1)*${exitEase}` },
      );
      focusXSegments.push({
        condition: `between(t,${start},${end})`,
        value: buildNestedIfExpression(
          [{ condition: `between(t,${exitStart},${end})`, value: fragment.movementEnabled ? movementEndX : focusX }],
          movementFocusXExpr
        ),
      });
      focusYSegments.push({
        condition: `between(t,${start},${end})`,
        value: buildNestedIfExpression(
          [{ condition: `between(t,${exitStart},${end})`, value: fragment.movementEnabled ? movementEndY : focusY }],
          movementFocusYExpr
        ),
      });
      continue;
    }

    const entryProgress = clamp01Expression(`(t-${start})/${transition}`);
    const exitProgress = clamp01Expression(`(t-${end})/${transition}`);
    const entryEase = easeOutQuartExpression(entryProgress);
    const exitEase = easeOutQuartExpression(exitProgress);

    scaleSegments.push(
      { condition: `between(t,${start},${entryEnd})`, value: `1+(${targetScale}-1)*${entryEase}` },
      { condition: `between(t,${entryEnd},${end})`, value: targetScale },
      { condition: `between(t,${end},${formatFilterNumber(fragment.endTime + transitionSeconds)})`, value: `${targetScale}-(${targetScale}-1)*${exitEase}` },
    );
    focusXSegments.push({
      condition: `between(t,${start},${formatFilterNumber(fragment.endTime + transitionSeconds)})`,
      value: focusX,
    });
    focusYSegments.push({
      condition: `between(t,${start},${formatFilterNumber(fragment.endTime + transitionSeconds)})`,
      value: focusY,
    });
  }

  return {
    scale: buildNestedIfExpression(scaleSegments, "1"),
    focusX: buildNestedIfExpression(focusXSegments, "50"),
    focusY: buildNestedIfExpression(focusYSegments, "50"),
    has3D,
  };
}

function buildMainVideoFilter(job: RenderJobRecord, innerWidth: number, innerHeight: number) {
  const visuals = job.manifest.visuals;
  const segments: string[] = [];
  let currentLabel = "main_source";
  const rotation =
    Math.abs(visuals.videoTransform.rotation) > 0.01
      ? `,rotate=${Number(((visuals.videoTransform.rotation * Math.PI) / 180).toFixed(6))}:ow=rotw(iw):oh=roth(ih):c=black@0`
      : "";

  const cropArea = visuals.cropArea;
  const hasCrop = Boolean(
    cropArea && (
      cropArea.width < 100 ||
      cropArea.height < 100 ||
      cropArea.x > 0 ||
      cropArea.y > 0
    )
  );
  if (hasCrop && cropArea) {
    const cropWidth = Math.max(2, Math.round((cropArea.width / 100) * job.output.width));
    const cropHeight = Math.max(2, Math.round((cropArea.height / 100) * job.output.height));
    const cropX = Math.max(0, Math.round((cropArea.x / 100) * job.output.width));
    const cropY = Math.max(0, Math.round((cropArea.y / 100) * job.output.height));
    const nextLabel = "main_cropped";
    segments.push(
      `[${currentLabel}]crop=w=${cropWidth}:h=${cropHeight}:x=${cropX}:y=${cropY}[${nextLabel}]`
    );
    currentLabel = nextLabel;
  }

  const zoomExpressions = buildZoomExpressions(job.manifest.timeline.zoomFragments);
  const hasZoom = job.manifest.timeline.zoomFragments.length > 0;
  if (hasZoom) {
    const nextScaled = "main_zoom_scaled";
    const nextCropped = "main_zoom_cropped";
    segments.push(
      `[${currentLabel}]scale=w='trunc(iw*(${zoomExpressions.scale})/2)*2':h='trunc(ih*(${zoomExpressions.scale})/2)*2':eval=frame[${nextScaled}]`
    );
    segments.push(
      `[${nextScaled}]crop=w=${hasCrop && cropArea ? Math.max(2, Math.round((cropArea.width / 100) * job.output.width)) : job.output.width}:h=${hasCrop && cropArea ? Math.max(2, Math.round((cropArea.height / 100) * job.output.height)) : job.output.height}:x='clip(iw*(${zoomExpressions.focusX})/100-(${hasCrop && cropArea ? Math.max(2, Math.round((cropArea.width / 100) * job.output.width)) : job.output.width})/2,0,iw-(${hasCrop && cropArea ? Math.max(2, Math.round((cropArea.width / 100) * job.output.width)) : job.output.width}))':y='clip(ih*(${zoomExpressions.focusY})/100-(${hasCrop && cropArea ? Math.max(2, Math.round((cropArea.height / 100) * job.output.height)) : job.output.height})/2,0,ih-(${hasCrop && cropArea ? Math.max(2, Math.round((cropArea.height / 100) * job.output.height)) : job.output.height}))'[${nextCropped}]`
    );
    currentLabel = nextCropped;
  }

  const finalLabel = "main0";
  segments.push(
    `[${currentLabel}]scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=decrease,pad=${innerWidth}:${innerHeight}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1,format=rgba${rotation}[${finalLabel}]`
  );

  const scaledRadius = Math.max(0, visuals.roundedCorners * (job.output.width / 896));
  const bottomOnlyRadius = visuals.mockupId !== "none" && BOTTOM_ONLY_RADIUS_MOCKUPS.includes(visuals.mockupId);
  const roundedFactor = buildRoundedRectFactorExpression(scaledRadius, bottomOnlyRadius);
  const maskFactor = buildMaskFactorExpression(visuals.videoMaskConfig);
  const combinedAlphaFactor = [roundedFactor, maskFactor]
    .filter((factor) => factor !== "1")
    .map((factor) => `(${factor})`)
    .join("*");

  let outputLabel = finalLabel;
  if (combinedAlphaFactor) {
    outputLabel = "main_alpha";
    segments.push(
      `[${finalLabel}]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${combinedAlphaFactor}'[${outputLabel}]`
    );
  }

  return {
    filter: segments.join(";"),
    outputLabel,
    has3DZoom: zoomExpressions.has3D,
  };
}

function getBackgroundAssetId(job: RenderJobRecord) {
  if (job.manifest.background.imageAssetId) {
    return job.manifest.background.imageAssetId;
  }

  if (job.manifest.background.tab === "wallpaper" && job.manifest.background.selectedWallpaper >= 0) {
    return "__wallpaper__";
  }

  return null;
}

function buildMockupFrameDecorations(params: {
  job: RenderJobRecord;
  inputLabel: string;
  outerX: number;
  outerY: number;
  outerWidth: number;
  outerHeight: number;
  includeUrlText?: boolean;
}) {
  const { job, inputLabel, outerX, outerY, outerWidth, outerHeight, includeUrlText = false } = params;
  const mockupId = job.manifest.visuals.mockupId;
  if (!isNativeSupportedMockup(mockupId)) {
    return null;
  }

  if (mockupId === "macos") {
    const config = job.manifest.visuals.mockupConfig;
    const isDark = config.darkMode;
    const scale = (job.output.width / 1280) * 1.2;
    const shadowStrength = Math.max(0, Math.min(1, job.manifest.visuals.shadows / 20));
    const headerScale = (config.headerScale || 100) / 100;
    const headerOpacity = (config.headerOpacity ?? 100) / 100;
    const headerHeight = 36 * headerScale * scale;
    const buttonSize = 10 * headerScale * scale;
    const buttonGap = 6 * headerScale * scale;
    const buttonLeftPadding = 12 * headerScale * scale;
    const urlBarHeight = 18 * headerScale * scale;
    const maxUrlBarWidth = 576 * headerScale * scale;
    const urlBarWidth = Math.min(outerWidth * 0.5, maxUrlBarWidth);
    const urlBarX = outerX + (outerWidth - urlBarWidth) / 2;
    const urlBarY = outerY + (headerHeight - urlBarHeight) / 2;
    const bgColor = isDark ? "#262626" : "#ffffff";
    const frameColor = config.frameColor || "#f6f6f6";
    const borderColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
    const urlBarBg = deriveSearchBg(frameColor);
    const label = `${inputLabel}_macos_frame`;
    const decorations = [];
    if (shadowStrength > 0) {
      decorations.push(
        `drawbox=x=${formatFilterNumber(outerX + (8 * scale))}:y=${formatFilterNumber(outerY + (18 * scale))}:w=${formatFilterNumber(outerWidth)}:h=${formatFilterNumber(outerHeight)}:color=${ffmpegColorFromHex("#000000", 0.12 * shadowStrength)}:t=fill`,
        `drawbox=x=${formatFilterNumber(outerX + (4 * scale))}:y=${formatFilterNumber(outerY + (10 * scale))}:w=${formatFilterNumber(outerWidth)}:h=${formatFilterNumber(outerHeight)}:color=${ffmpegColorFromHex("#000000", 0.08 * shadowStrength)}:t=fill`
      );
    }

    decorations.push(
      `drawbox=x=${formatFilterNumber(outerX)}:y=${formatFilterNumber(outerY)}:w=${formatFilterNumber(outerWidth)}:h=${formatFilterNumber(outerHeight)}:color=${ffmpegColorFromHex(bgColor)}:t=fill`,
      `drawbox=x=${formatFilterNumber(outerX)}:y=${formatFilterNumber(outerY)}:w=${formatFilterNumber(outerWidth)}:h=${formatFilterNumber(headerHeight)}:color=${ffmpegColorFromHex(frameColor, headerOpacity)}:t=fill`,
      `drawbox=x=${formatFilterNumber(outerX)}:y=${formatFilterNumber(outerY + headerHeight - 1)}:w=${formatFilterNumber(outerWidth)}:h=1:color=${ffmpegColorFromHex(borderColor.startsWith("rgba") ? "#000000" : borderColor, 0.12)}:t=fill`,
      `drawbox=x=${formatFilterNumber(outerX + buttonLeftPadding)}:y=${formatFilterNumber(outerY + (headerHeight - buttonSize) / 2)}:w=${formatFilterNumber(buttonSize)}:h=${formatFilterNumber(buttonSize)}:color=${ffmpegColorFromHex("#FF5F56")}:t=fill`,
      `drawbox=x=${formatFilterNumber(outerX + buttonLeftPadding + buttonSize + buttonGap)}:y=${formatFilterNumber(outerY + (headerHeight - buttonSize) / 2)}:w=${formatFilterNumber(buttonSize)}:h=${formatFilterNumber(buttonSize)}:color=${ffmpegColorFromHex("#FFBD2E")}:t=fill`,
      `drawbox=x=${formatFilterNumber(outerX + buttonLeftPadding + (buttonSize + buttonGap) * 2)}:y=${formatFilterNumber(outerY + (headerHeight - buttonSize) / 2)}:w=${formatFilterNumber(buttonSize)}:h=${formatFilterNumber(buttonSize)}:color=${ffmpegColorFromHex("#27C93F")}:t=fill`,
      `drawbox=x=${formatFilterNumber(urlBarX)}:y=${formatFilterNumber(urlBarY)}:w=${formatFilterNumber(urlBarWidth)}:h=${formatFilterNumber(urlBarHeight)}:color=${ffmpegColorFromHex(urlBarBg, headerOpacity)}:t=fill`
    );
    if (includeUrlText) {
      decorations.push(
        `drawtext=text='${(config.url || "openvid.dev").replace(/^https?:\/\//, "").replace(/:/g, "\\:").replace(/'/g, "\\'").slice(0, 42)}':fontcolor=${ffmpegColorFromHex(isDark ? "#cccccc" : "#555555")}:fontsize=${formatFilterNumber(14 * headerScale * scale)}:x=${formatFilterNumber(urlBarX + (12 * scale))}:y=${formatFilterNumber(urlBarY + (urlBarHeight / 2) + (5 * headerScale * scale))}:box=0`
      );
    } else {
      decorations.push(
        `drawbox=x=${formatFilterNumber(urlBarX + (14 * scale))}:y=${formatFilterNumber(urlBarY + (urlBarHeight / 2) - (1.5 * scale))}:w=${formatFilterNumber(Math.max(40 * scale, Math.min(urlBarWidth * 0.18, 120 * scale)))}:h=${formatFilterNumber(3 * scale)}:color=${ffmpegColorFromHex(isDark ? "#cfcfcf" : "#5a5a5a", 0.72)}:t=fill`,
        `drawbox=x=${formatFilterNumber(urlBarX + (14 * scale) + Math.max(48 * scale, Math.min(urlBarWidth * 0.22, 140 * scale)))}:y=${formatFilterNumber(urlBarY + (urlBarHeight / 2) - (1.5 * scale))}:w=${formatFilterNumber(Math.max(22 * scale, Math.min(urlBarWidth * 0.08, 56 * scale)))}:h=${formatFilterNumber(3 * scale)}:color=${ffmpegColorFromHex(isDark ? "#cfcfcf" : "#5a5a5a", 0.55)}:t=fill`
      );
    }

    return {
      label,
      filter: `[${inputLabel}]${decorations.join(",")}[${label}]`,
      contentX: outerX,
      contentY: outerY + headerHeight,
      contentWidth: outerWidth,
      contentHeight: Math.max(2, outerHeight - headerHeight),
    };
  }

  return null;
}

function hasSupportedCompositing(job: RenderJobRecord) {
  const { visuals, timeline } = job.manifest;
  const hasCrop = Boolean(
    visuals.cropArea &&
      (visuals.cropArea.width < 100 ||
        visuals.cropArea.height < 100 ||
        visuals.cropArea.x > 0 ||
        visuals.cropArea.y > 0)
  );
  return Boolean(
    getBackgroundAssetId(job) ||
      job.manifest.background.color ||
      visuals.padding !== 0 ||
      visuals.roundedCorners > 0 ||
      visuals.shadows > 0 ||
      visuals.mockupId !== "none" ||
      hasCrop ||
      timeline.zoomFragments.length > 0 ||
      visuals.videoTransform.rotation !== 0 ||
      visuals.videoTransform.translateX !== 0 ||
      visuals.videoTransform.translateY !== 0 ||
      visuals.cameraAssetId ||
      visuals.canvasElements.some((element) => element.type === "image" || element.type === "text")
  );
}

function collectCompositionIssues(job: RenderJobRecord) {
  const issues: RenderJobIssue[] = [];
  const { background, visuals, timeline } = job.manifest;

  if (background.color?.type === "gradient") {
    issues.push({
      severity: "warning",
      code: "BACKGROUND_GRADIENT_APPROXIMATED",
      message: "Native worker approximated the gradient background using its leading color stop.",
    });
  }

  if (visuals.shadows > 0) {
    issues.push({
      severity: "warning",
      code: "ROUNDED_CORNERS_AND_SHADOWS_APPROXIMATED",
      message: "Native worker still approximates shadow styling on the main video surface.",
    });
  }

  if (visuals.mockupId !== "none" && !isNativeSupportedMockup(visuals.mockupId)) {
    issues.push({
      severity: "warning",
      code: "MOCKUP_UNSUPPORTED",
      message: "Native worker does not yet apply this mockup frame.",
    });
  }

  if (visuals.imageMaskConfig.enabled) {
    issues.push({
      severity: "warning",
      code: "IMAGE_MASKS_UNSUPPORTED",
      message: "Native worker does not yet apply image-mode mask effects.",
    });
  }

  if (visuals.apply3DToBackground) {
    issues.push({
      severity: "warning",
      code: "BACKGROUND_3D_UNSUPPORTED",
      message: "Native worker does not yet reproduce 3D background transforms.",
    });
  }

  if (timeline.zoomFragments.some((fragment) => fragment.enable3D)) {
    issues.push({
      severity: "warning",
      code: "ZOOM_3D_UNSUPPORTED",
      message: "Native worker currently ignores 3D zoom perspective during final compositing.",
    });
  }

  if (visuals.canvasElements.some((element) => element.type === "svg")) {
    issues.push({
      severity: "warning",
      code: "SVG_ELEMENTS_UNSUPPORTED",
      message: "Native worker currently skips SVG canvas elements during final compositing.",
    });
  }

  if (visuals.canvasElements.some((element) => element.type === "text")) {
    issues.push({
      severity: "warning",
      code: "TEXT_OVERLAYS_UNSUPPORTED",
      message: "Native worker does not yet render text overlays faithfully on this machine.",
    });
  }

  return issues;
}

async function writeWaveformJson(inputPath: string, outputPath: string) {
  const tempRawPath = `${outputPath}.raw`;
  await runCommand("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "120",
    "-f",
    "f32le",
    tempRawPath,
  ]);

  const samplesBuffer = await fs.readFile(tempRawPath);
  const floatArray = new Float32Array(
    samplesBuffer.buffer,
    samplesBuffer.byteOffset,
    Math.floor(samplesBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
  );

  const bucketSize = 128;
  const buckets: number[] = [];
  for (let i = 0; i < floatArray.length; i += bucketSize) {
    let peak = 0;
    for (let j = i; j < Math.min(i + bucketSize, floatArray.length); j++) {
      const value = Math.abs(floatArray[j] ?? 0);
      if (value > peak) peak = value;
    }
    buckets.push(Number(peak.toFixed(4)));
  }

  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        sampleRate: 120,
        bucketSize,
        points: buckets,
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.unlink(tempRawPath).catch(() => undefined);
}

async function processVideoProxy(asset: RenderAssetRecord, profile: RenderProxyProfile) {
  const inputPath = await resolveInputPath(asset);
  const proxiesDir = path.join(getRenderAssetDir(asset.assetId), "proxies");
  await ensureDir(proxiesDir);
  const outputFileName = `${profile.id}.mp4`;
  const outputPath = proxyPath(asset, outputFileName);

  const scaleWidth = profile.width ?? asset.metadata?.width ?? 1280;
  const scaleHeight = profile.height ?? asset.metadata?.height ?? 720;
  const fps = profile.fps ?? 30;
  const bitrate = profile.bitrate ?? 4_000_000;

  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `scale=w=${scaleWidth}:h=${scaleHeight}:force_original_aspect_ratio=decrease,pad=${scaleWidth}:${scaleHeight}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps}`,
    "-c:v",
    "h264_videotoolbox",
    "-b:v",
    String(bitrate),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  profile.status = "ready";
  profile.relativePath = artifactRelativePath(outputPath);
  profile.mimeType = "video/mp4";
  profile.errorMessage = undefined;

  return {
    id: `${asset.assetId}:${profile.id}`,
    kind: "proxy" as const,
    relativePath: profile.relativePath,
    mimeType: profile.mimeType,
  };
}

async function processAudioProxy(asset: RenderAssetRecord, profile: RenderProxyProfile) {
  const inputPath = await resolveInputPath(asset);
  const proxiesDir = path.join(getRenderAssetDir(asset.assetId), "proxies");
  await ensureDir(proxiesDir);

  if (profile.id === "waveform-json") {
    const outputPath = proxyPath(asset, `${profile.id}.json`);
    await writeWaveformJson(inputPath, outputPath);
    profile.status = "ready";
    profile.relativePath = artifactRelativePath(outputPath);
    profile.mimeType = "application/json";
    profile.errorMessage = undefined;
    return {
      id: `${asset.assetId}:${profile.id}`,
      kind: "proxy" as const,
      relativePath: profile.relativePath,
      mimeType: profile.mimeType,
    };
  }

  const outputPath = proxyPath(asset, `${profile.id}.m4a`);
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputPath,
  ]);
  profile.status = "ready";
  profile.relativePath = artifactRelativePath(outputPath);
  profile.mimeType = "audio/mp4";
  profile.errorMessage = undefined;

  if (!asset.metadata?.duration) {
    asset.metadata = {
      ...asset.metadata,
      duration: await probeAudioDuration(outputPath),
    };
  }

  return {
    id: `${asset.assetId}:${profile.id}`,
    kind: "proxy" as const,
    relativePath: profile.relativePath,
    mimeType: profile.mimeType,
  };
}

async function processImageProxy(asset: RenderAssetRecord, profile: RenderProxyProfile) {
  const inputPath = await resolveInputPath(asset);
  const proxiesDir = path.join(getRenderAssetDir(asset.assetId), "proxies");
  await ensureDir(proxiesDir);
  const outputPath = proxyPath(asset, `${profile.id}.webp`);

  await runCommand("ffmpeg", ["-y", "-i", inputPath, outputPath]);
  profile.status = "ready";
  profile.relativePath = artifactRelativePath(outputPath);
  profile.mimeType = "image/webp";
  profile.errorMessage = undefined;

  return {
    id: `${asset.assetId}:${profile.id}`,
    kind: "proxy" as const,
    relativePath: profile.relativePath,
    mimeType: profile.mimeType,
  };
}

async function processAsset(asset: RenderAssetRecord, log: (entry: RenderJobWorkerLogEntry) => void) {
  const artifacts: RenderJobGeneratedArtifact[] = [];

  for (const profile of asset.proxyProfiles) {
    if (profile.status === "ready" && profile.relativePath) {
      continue;
    }

    try {
      log(createLog("info", `Generating ${profile.id} for ${asset.manifestAssetId}`));
      let artifact: RenderJobGeneratedArtifact;
      if (asset.kind === "video" || asset.kind === "camera-video") {
        artifact = await processVideoProxy(asset, profile);
      } else if (asset.kind === "audio") {
        artifact = await processAudioProxy(asset, profile);
      } else {
        artifact = await processImageProxy(asset, profile);
      }
      artifacts.push(artifact);
    } catch (error) {
      profile.status = "failed";
      profile.errorMessage =
        error instanceof Error ? error.message : "Unknown proxy generation error";
      log(
        createLog(
          "error",
          `Failed ${profile.id} for ${asset.manifestAssetId}: ${profile.errorMessage}`
        )
      );
    }
  }

  await updateRenderAsset(asset);
  return artifacts;
}

function hasVisualCompositionRequirements(job: RenderJobRecord) {
  const { background, visuals, timeline } = job.manifest;
  const nonZeroTransform =
    visuals.videoTransform.rotation !== 0 ||
    visuals.videoTransform.translateX !== 0 ||
    visuals.videoTransform.translateY !== 0;
  const nonDefaultImageTransform =
    visuals.imageTransform.rotateX !== 0 ||
    visuals.imageTransform.rotateY !== 0 ||
    visuals.imageTransform.rotateZ !== 0 ||
    visuals.imageTransform.translateY !== 0 ||
    visuals.imageTransform.scale !== 0.9 ||
    visuals.imageTransform.perspective !== 600;

  return Boolean(
    background.imageAssetId ||
      background.color ||
      background.transparent ||
      visuals.padding !== 10 ||
      visuals.cropArea ||
      visuals.mockupId !== "none" ||
      visuals.canvasElements.length > 0 ||
      visuals.cameraAssetId ||
      visuals.apply3DToBackground ||
      visuals.imageMaskConfig.enabled ||
      visuals.videoMaskConfig.enabled ||
      nonZeroTransform ||
      nonDefaultImageTransform ||
      timeline.zoomFragments.length > 0
  );
}

async function resolveCompositionBackgroundInput(job: RenderJobRecord) {
  const backgroundAssetId = getBackgroundAssetId(job);
  if (backgroundAssetId === "__wallpaper__") {
    const wallpaperUrl = getWallpaperUrl(job.manifest.background.selectedWallpaper);
    if (!wallpaperUrl) {
      return null;
    }
    return path.join(process.cwd(), "public", wallpaperUrl.replace(/^\/+/, ""));
  }

  if (!backgroundAssetId) {
    return null;
  }

  const { inputPath } = await resolveManifestAssetInputPath(job, backgroundAssetId);
  return inputPath;
}

async function resolveImageElementInputs(job: RenderJobRecord) {
  const resolved = new Map<string, string>();
  const imageElements = job.manifest.visuals.canvasElements.filter(
    (element): element is ImageElement => element.type === "image" && element.visible !== false
  );

  for (const element of imageElements) {
    const assetId = `image:canvas:${element.id}`;
    try {
      const { inputPath } = await resolveManifestAssetInputPath(job, assetId);
      resolved.set(element.id, inputPath);
    } catch {
      // Missing image overlays are treated as optional in the current worker subset.
    }
  }

  return resolved;
}

async function resolveTextElementInputs(job: RenderJobRecord, width: number, height: number) {
  const resolved = new Map<string, string>();
  const textElements = job.manifest.visuals.canvasElements.filter(
    (element): element is TextElement => element.type === "text" && element.visible !== false
  );

  if (textElements.length === 0) {
    return resolved;
  }

  const textDir = path.join(getRenderCacheRoot(), "jobs", job.jobId, "text-overlays");
  await ensureDir(textDir);

  for (const element of textElements) {
    const { width: overlayWidth, height: overlayHeight } = getElementSizePx(element, width, height);
    const svgWidth = Math.max(64, Math.round(overlayWidth * 2));
    const svgHeight = Math.max(64, Math.round(Math.max(overlayHeight, element.fontSize * 1.8) * 2));
    const svgPath = path.join(textDir, `${element.id.replace(/[^a-z0-9_-]/gi, "_")}.svg`);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="${TEXT_KEY_COLOR}"/>
  <text
    x="50%"
    y="50%"
    text-anchor="middle"
    dominant-baseline="middle"
    font-family="${escapeXml(element.fontFamily || "Arial")}"
    font-size="${Math.max(12, Math.round(element.fontSize * 2))}"
    font-weight="${element.fontWeight}"
    fill="${element.color || "#ffffff"}"
    fill-opacity="${formatFilterNumber(Math.max(0, Math.min(1, element.opacity)))}"
  >${escapeXml(String(element.content || " "))}</text>
</svg>`;
    await fs.writeFile(svgPath, svg, "utf8");
    const pngPath = await rasterizeSvgWithQuickLook(svgPath, Math.max(svgWidth, svgHeight), textDir);
    resolved.set(element.id, pngPath);
  }

  return resolved;
}

async function renderCompositeOutput(params: {
  job: RenderJobRecord;
  baseVideoPath: string;
  outputPath: string;
  log: (entry: RenderJobWorkerLogEntry) => void;
}) {
  const { job, baseVideoPath, outputPath, log } = params;
  if (!hasSupportedCompositing(job)) {
    return {
      applied: false,
      outputPath: baseVideoPath,
    };
  }

  const probedBaseDuration = await probeMediaDuration(baseVideoPath);
  const duration = Number(
    (probedBaseDuration || job.manifest.outputDuration || job.manifest.timeline.duration || 0).toFixed(3)
  );
  const width = job.output.width;
  const height = job.output.height;
  const fps = job.output.fps;
  const expectedFrameCount = Math.max(1, Math.round(duration * fps));
  const visuals = job.manifest.visuals;
  const drawTextSupported = await supportsDrawTextFilter();
  const refSize = getRefSize(width, height);
  const paddingPercent = visuals.padding * 0.5 / 100;
  const padX = Math.max(0, Math.round(width * paddingPercent));
  const padY = Math.max(0, Math.round(height * paddingPercent));
  const frameOuterX = padX;
  const frameOuterY = padY;
  const frameOuterWidth = Math.max(2, width - padX * 2);
  const frameOuterHeight = Math.max(2, height - padY * 2);

  const args: string[] = ["-y", "-i", baseVideoPath];
  const filterParts: string[] = [];
  const imageInputs = await resolveImageElementInputs(job);
  const textInputs = await resolveTextElementInputs(job, width, height);
  const backgroundInputPath = await resolveCompositionBackgroundInput(job);

  let inputIndex = 1;
  let backgroundInputIndex = -1;
  if (backgroundInputPath) {
    backgroundInputIndex = inputIndex;
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(duration), "-i", backgroundInputPath);
    inputIndex += 1;
  } else {
    const color = resolveBackgroundColor(job);
    backgroundInputIndex = inputIndex;
    args.push(
      "-f",
      "lavfi",
      "-t",
      String(duration),
      "-i",
      `color=c=${color}:s=${width}x${height}:r=${fps}`
    );
    inputIndex += 1;
  }

  const overlayInputs: Array<{
    element: ImageElement | TextElement;
    inputIndex: number;
  }> = [];
  for (const element of job.manifest.visuals.canvasElements
    .filter((value): value is ImageElement | TextElement => (
      (value.type === "image" || value.type === "text") && value.visible !== false
    ))
    .sort((a, b) => a.zIndex - b.zIndex)) {
    const inputPath = element.type === "image"
      ? imageInputs.get(element.id)
      : textInputs.get(element.id);
    if (!inputPath) {
      continue;
    }
    overlayInputs.push({ element, inputIndex });
    args.push("-loop", "1", "-framerate", String(fps), "-t", String(duration), "-i", inputPath);
    inputIndex += 1;
  }

  let cameraInputIndex = -1;
  if (visuals.cameraAssetId && visuals.cameraConfig?.enabled) {
    try {
      const { inputPath } = await resolveManifestAssetInputPath(job, visuals.cameraAssetId);
      cameraInputIndex = inputIndex;
      args.push("-stream_loop", "-1", "-i", inputPath);
      inputIndex += 1;
    } catch {
      cameraInputIndex = -1;
    }
  }

  const backgroundLabel = "bg0";
  if (backgroundInputPath) {
    const blur = Math.max(0, Math.round(job.manifest.background.blur * 0.8));
    const blurFilter = blur > 0 ? `,boxblur=${blur}:${Math.max(1, Math.round(blur / 2))}` : "";
    filterParts.push(
      `[${backgroundInputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1${blurFilter}[${backgroundLabel}]`
    );
  } else {
    filterParts.push(`[${backgroundInputIndex}:v]setsar=1[${backgroundLabel}]`);
  }

  let mediaContentX = frameOuterX;
  let mediaContentY = frameOuterY;
  let mediaContentWidth = frameOuterWidth;
  let mediaContentHeight = frameOuterHeight;
  let currentLabelWithFrame = backgroundLabel;
  const mockupFrame = buildMockupFrameDecorations({
    job,
    inputLabel: backgroundLabel,
    outerX: frameOuterX,
    outerY: frameOuterY,
    outerWidth: frameOuterWidth,
    outerHeight: frameOuterHeight,
    includeUrlText: drawTextSupported,
  });
  if (mockupFrame) {
    filterParts.push(mockupFrame.filter);
    currentLabelWithFrame = mockupFrame.label;
    mediaContentX = mockupFrame.contentX;
    mediaContentY = mockupFrame.contentY;
    mediaContentWidth = mockupFrame.contentWidth;
    mediaContentHeight = mockupFrame.contentHeight;
  } else if (visuals.shadows > 0) {
    const shadowStrength = Math.max(0, Math.min(1, visuals.shadows / 20));
    const shadowLabel = "bg_with_surface_shadow";
    filterParts.push(
      `[${currentLabelWithFrame}]drawbox=x=${formatFilterNumber(frameOuterX + 8)}:y=${formatFilterNumber(frameOuterY + 18)}:w=${formatFilterNumber(frameOuterWidth)}:h=${formatFilterNumber(frameOuterHeight)}:color=${ffmpegColorFromHex("#000000", 0.12 * shadowStrength)}:t=fill,drawbox=x=${formatFilterNumber(frameOuterX + 4)}:y=${formatFilterNumber(frameOuterY + 10)}:w=${formatFilterNumber(frameOuterWidth)}:h=${formatFilterNumber(frameOuterHeight)}:color=${ffmpegColorFromHex("#000000", 0.08 * shadowStrength)}:t=fill[${shadowLabel}]`
    );
    currentLabelWithFrame = shadowLabel;
  }
  const translateX = Number((((visuals.videoTransform.translateX / 100) * mediaContentWidth)).toFixed(2));
  const translateY = Number((((visuals.videoTransform.translateY / 100) * mediaContentHeight)).toFixed(2));
  const mainVideoFilter = buildMainVideoFilter(job, mediaContentWidth, mediaContentHeight);

  let currentLabel = currentLabelWithFrame;

  const orderedBehindElements = [
    ...job.manifest.visuals.canvasElements
      .filter((element) => element.visible !== false && element.zIndex < VIDEO_Z_INDEX)
      .sort((a, b) => a.zIndex - b.zIndex),
  ];

  for (const element of orderedBehindElements) {
    if (element.type === "image") {
      const overlay = overlayInputs.find((entry) => entry.element.id === element.id);
      if (!overlay) {
        continue;
      }
      const nextLabel = `v_bg_${element.id.replace(/[^a-z0-9]/gi, "_")}`;
      const { width: overlayWidth, height: overlayHeight } = getElementSizePx(element, width, height);
      const { x, y } = getElementCenterPx(element, width, height);
      const opacity = Math.max(0, Math.min(1, element.opacity));
      const rotation = Math.abs(element.rotation) > 0.01
        ? `,rotate=${Number(((element.rotation * Math.PI) / 180).toFixed(6))}:ow=rotw(iw):oh=roth(ih):c=black@0`
        : "";
      filterParts.push(
        `[${overlay.inputIndex}:v]scale=${overlayWidth}:${overlayHeight},format=rgba,colorchannelmixer=aa=${opacity}${rotation}[img_${element.id.replace(/[^a-z0-9]/gi, "_")}]`
      );
      filterParts.push(
        `[${currentLabel}][img_${element.id.replace(/[^a-z0-9]/gi, "_")}]overlay=x='${x}-w/2':y='${y}-h/2':format=auto[${nextLabel}]`
      );
      currentLabel = nextLabel;
      continue;
    }

    if (element.type === "text") {
      const overlay = overlayInputs.find((entry) => entry.element.id === element.id);
      if (!overlay) {
        continue;
      }
      const nextLabel = `v_bg_text_${element.id.replace(/[^a-z0-9]/gi, "_")}`;
      const { width: overlayWidth, height: overlayHeight } = getElementSizePx(element, width, height);
      const { x, y } = getElementCenterPx(element, width, height);
      const opacity = Math.max(0, Math.min(1, element.opacity));
      const rotation = Math.abs(element.rotation) > 0.01
        ? `,rotate=${Number(((element.rotation * Math.PI) / 180).toFixed(6))}:ow=rotw(iw):oh=roth(ih):c=black@0`
        : "";
      filterParts.push(
        `[${overlay.inputIndex}:v]scale=${overlayWidth}:${overlayHeight}:force_original_aspect_ratio=decrease,colorkey=${TEXT_KEY_COLOR}:0.08:0.02,format=rgba,colorchannelmixer=aa=${opacity}${rotation}[text_${element.id.replace(/[^a-z0-9]/gi, "_")}]`
      );
      filterParts.push(
        `[${currentLabel}][text_${element.id.replace(/[^a-z0-9]/gi, "_")}]overlay=x='${x}-w/2':y='${y}-h/2':format=auto[${nextLabel}]`
      );
      currentLabel = nextLabel;
    }
  }

  if (mainVideoFilter.has3DZoom) {
    log(createLog("warning", "Native worker is rendering zoom timing, but still ignores 3D zoom perspective."));
  }
  filterParts.push(mainVideoFilter.filter);

  const mainCompositeLabel = "with_main";
  filterParts.push(
    `[${currentLabel}][${mainVideoFilter.outputLabel}]overlay=x='${formatFilterNumber(mediaContentX)}+${translateX}':y='${formatFilterNumber(mediaContentY)}+${translateY}':format=auto[${mainCompositeLabel}]`
  );
  currentLabel = mainCompositeLabel;

  const orderedFrontElements = [
    ...job.manifest.visuals.canvasElements
      .filter((element) => element.visible !== false && element.zIndex >= VIDEO_Z_INDEX)
      .sort((a, b) => a.zIndex - b.zIndex),
  ];

  for (const element of orderedFrontElements) {
    if (element.type === "image") {
      const overlay = overlayInputs.find((entry) => entry.element.id === element.id);
      if (!overlay) {
        continue;
      }
      const nextLabel = `v_fg_${element.id.replace(/[^a-z0-9]/gi, "_")}`;
      const { width: overlayWidth, height: overlayHeight } = getElementSizePx(element, width, height);
      const { x, y } = getElementCenterPx(element, width, height);
      const opacity = Math.max(0, Math.min(1, element.opacity));
      const rotation = Math.abs(element.rotation) > 0.01
        ? `,rotate=${Number(((element.rotation * Math.PI) / 180).toFixed(6))}:ow=rotw(iw):oh=roth(ih):c=black@0`
        : "";
      filterParts.push(
        `[${overlay.inputIndex}:v]scale=${overlayWidth}:${overlayHeight},format=rgba,colorchannelmixer=aa=${opacity}${rotation}[img_fg_${element.id.replace(/[^a-z0-9]/gi, "_")}]`
      );
      filterParts.push(
        `[${currentLabel}][img_fg_${element.id.replace(/[^a-z0-9]/gi, "_")}]overlay=x='${x}-w/2':y='${y}-h/2':format=auto[${nextLabel}]`
      );
      currentLabel = nextLabel;
      continue;
    }

    if (element.type === "text") {
      const overlay = overlayInputs.find((entry) => entry.element.id === element.id);
      if (!overlay) {
        continue;
      }
      const nextLabel = `v_fg_text_${element.id.replace(/[^a-z0-9]/gi, "_")}`;
      const { width: overlayWidth, height: overlayHeight } = getElementSizePx(element, width, height);
      const { x, y } = getElementCenterPx(element, width, height);
      const opacity = Math.max(0, Math.min(1, element.opacity));
      const rotation = Math.abs(element.rotation) > 0.01
        ? `,rotate=${Number(((element.rotation * Math.PI) / 180).toFixed(6))}:ow=rotw(iw):oh=roth(ih):c=black@0`
        : "";
      filterParts.push(
        `[${overlay.inputIndex}:v]scale=${overlayWidth}:${overlayHeight}:force_original_aspect_ratio=decrease,colorkey=${TEXT_KEY_COLOR}:0.08:0.02,format=rgba,colorchannelmixer=aa=${opacity}${rotation}[text_fg_${element.id.replace(/[^a-z0-9]/gi, "_")}]`
      );
      filterParts.push(
        `[${currentLabel}][text_fg_${element.id.replace(/[^a-z0-9]/gi, "_")}]overlay=x='${x}-w/2':y='${y}-h/2':format=auto[${nextLabel}]`
      );
      currentLabel = nextLabel;
    }
  }

  if (cameraInputIndex >= 0 && visuals.cameraConfig?.enabled) {
    const nextLabel = "with_camera";
    const { size, left, top } = getCameraLayout(visuals.cameraConfig, width, height);
    const sizePx = Math.max(2, Math.round(size));
    const mirror = visuals.cameraConfig.mirror ? ",hflip" : "";
    const cameraShapeFactor = buildCameraShapeFactorExpression(visuals.cameraConfig.shape);
    filterParts.push(
      `[${cameraInputIndex}:v]scale=${sizePx}:${sizePx}:force_original_aspect_ratio=increase,crop=${sizePx}:${sizePx}${mirror},format=rgba${cameraShapeFactor !== "1" ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${cameraShapeFactor})'` : ""}[camera0]`
    );
    filterParts.push(
      `[${currentLabel}][camera0]overlay=x=${Math.round(left)}:y=${Math.round(top)}:format=auto[${nextLabel}]`
    );
    currentLabel = nextLabel;
  }

  const finalVideoLabel = "final_composite";
  filterParts.push(`[${currentLabel}]fps=${fps}[${finalVideoLabel}]`);

  log(createLog("info", "Applying native compositing pass"));
  await runCommand("ffmpeg", [
    ...args,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    `[${finalVideoLabel}]`,
    "-an",
    ...getH264EncodingArgs(job.output),
    "-frames:v",
    String(expectedFrameCount),
    "-r",
    String(fps),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    String(duration),
    outputPath,
  ]);

  return {
    applied: true,
    outputPath,
  };
}

async function renderClipSegment(params: {
  inputPath: string;
  outputPath: string;
  trimStart: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  output: RenderOutputProfile;
  includeSourceAudio: boolean;
}) {
  const videoFilter = `scale=w=${params.width}:h=${params.height}:force_original_aspect_ratio=decrease,pad=${params.width}:${params.height}:(ow-iw)/2:(oh-ih)/2:black,fps=${params.fps}`;
  const baseArgs = [
    "-y",
    "-ss",
    String(params.trimStart),
    "-t",
    String(params.duration),
    "-i",
    params.inputPath,
  ];

  const outputArgs = [
    "-vf",
    videoFilter,
    ...getH264EncodingArgs(params.output),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(params.fps),
    "-movflags",
    "+faststart",
  ];

  if (params.includeSourceAudio) {
    await runCommand("ffmpeg", [
      ...baseArgs,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...outputArgs,
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-ac",
      "2",
      params.outputPath,
    ]);
    return;
  }

  await runCommand("ffmpeg", [
    ...baseArgs,
    "-f",
    "lavfi",
    "-t",
    String(params.duration),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    ...outputArgs,
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    params.outputPath,
  ]);
}

async function concatSegments(segmentPaths: string[], outputPath: string) {
  const listPath = `${outputPath}.txt`;
  const listContents = segmentPaths.map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listPath, listContents, "utf8");

  await runCommand("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    outputPath,
  ]);

  await fs.unlink(listPath).catch(() => undefined);
}

async function mixTimelineAudio(params: {
  baseVideoPath: string;
  outputPath: string;
  job: RenderJobRecord;
  includeOriginalAudio: boolean;
}) {
  const args: string[] = ["-y", "-i", params.baseVideoPath];
  const filterParts: string[] = [];
  const mixInputs: string[] = [];
  let inputIndex = 1;

  if (params.includeOriginalAudio) {
    filterParts.push(`[0:a]volume=${params.job.manifest.timeline.masterVolume}[a0]`);
    mixInputs.push("[a0]");
  }

  for (const track of params.job.manifest.timeline.audioTracks) {
    try {
      const { inputPath } = await resolveManifestAssetInputPath(params.job, track.assetId);
      if (track.loop) {
        args.push("-stream_loop", "-1");
      }
      args.push("-i", inputPath);
      const trackVolume = Number((track.volume * params.job.manifest.timeline.masterVolume).toFixed(4));
      const delayMs = Math.max(0, Math.round(track.startTime * 1000));
      const trimStart = track.trimStart ?? 0;
      const trimEnd = trimStart + track.duration;
      filterParts.push(
        `[${inputIndex}:a]atrim=${trimStart}:${trimEnd},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},volume=${trackVolume}[a${inputIndex}]`
      );
      mixInputs.push(`[a${inputIndex}]`);
      inputIndex += 1;
    } catch {
      // Skip missing/unsupported audio assets in rough-cut mode.
    }
  }

  if (mixInputs.length === 0) {
    await fs.copyFile(params.baseVideoPath, params.outputPath);
    return;
  }

  filterParts.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0[aout]`);
  await runCommand("ffmpeg", [
    ...args,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    params.outputPath,
  ]);
}

async function renderRoughCut(job: RenderJobRecord, log: (entry: RenderJobWorkerLogEntry) => void) {
  if (job.output.container !== "mp4" || job.output.videoCodec !== "h264") {
    throw new Error(`Rough-cut native render currently supports only MP4/H.264 output, received ${job.output.container}/${job.output.videoCodec}`);
  }

  const clips = [...job.manifest.timeline.videoClips].sort((a, b) => a.startTime - b.startTime);
  if (clips.length === 0 && !job.manifest.primaryVideoAssetId) {
    throw new Error("No video clip assets available for rough-cut render");
  }

  const segmentsDir = path.join(getRenderCacheRoot(), "jobs", job.jobId, "segments");
  const outputsDir = path.join(getRenderCacheRoot(), "jobs", job.jobId, "outputs");
  await ensureDir(segmentsDir);
  await ensureDir(outputsDir);

  const outputWidth = job.output.width;
  const outputHeight = job.output.height;
  const outputFps = job.output.fps;

  const segmentPaths: string[] = [];
  const clipAudioStates = job.manifest.timeline.clipAudioStates ?? {};
  const includeOriginalAudio = !job.manifest.timeline.muteOriginalAudio && job.manifest.timeline.sourceHasAudioTrack;

  const clipsToRender = clips.length > 0
    ? clips
    : [{
        id: "primary",
        assetId: job.manifest.primaryVideoAssetId!,
        startTime: 0,
        duration: job.manifest.outputDuration || job.manifest.timeline.duration,
        trimStart: job.manifest.trim.start,
        trimEnd: job.manifest.trim.end,
        libraryVideoId: job.manifest.primaryVideoAssetId!,
        name: "Primary video",
      }];

  for (let index = 0; index < clipsToRender.length; index += 1) {
    const clip = clipsToRender[index];
    const { inputPath } = await resolveManifestAssetInputPath(job, clip.assetId);
    const duration = clip.trimEnd - clip.trimStart;
    const segmentPath = path.join(segmentsDir, `segment-${String(index).padStart(3, "0")}.mp4`);
    const includeClipAudio = includeOriginalAudio && clipAudioStates[clip.libraryVideoId] !== false;
    log(createLog("info", `Rendering segment ${index + 1}/${clipsToRender.length} from ${clip.assetId}`));
    await renderClipSegment({
      inputPath,
      outputPath: segmentPath,
      trimStart: clip.trimStart,
      duration,
      width: outputWidth,
      height: outputHeight,
      fps: outputFps,
      output: job.output,
      includeSourceAudio: includeClipAudio,
    });
    segmentPaths.push(segmentPath);
  }

  updateRenderJob(job.jobId, (current) => ({
    ...current,
    worker: {
      ...(current.worker ?? {
        processor: "local-native-worker",
        processedAssetIds: [],
        generatedArtifacts: [],
        logs: [],
      }),
      progress: 72,
      stage: "Concatenating rendered segments",
    },
  }));
  const baseConcatPath = path.join(outputsDir, "rough-cut-base.mp4");
  await concatSegments(segmentPaths, baseConcatPath);

  updateRenderJob(job.jobId, (current) => ({
    ...current,
    worker: {
      ...(current.worker ?? {
        processor: "local-native-worker",
        processedAssetIds: [],
        generatedArtifacts: [],
        logs: [],
      }),
      progress: 80,
      stage: "Applying visual compositing",
    },
  }));
  const compositedPath = path.join(outputsDir, "rough-cut-composited.mp4");
  const compositeResult = await renderCompositeOutput({
    job,
    baseVideoPath: baseConcatPath,
    outputPath: compositedPath,
    log,
  });

  updateRenderJob(job.jobId, (current) => ({
    ...current,
    worker: {
      ...(current.worker ?? {
        processor: "local-native-worker",
        processedAssetIds: [],
        generatedArtifacts: [],
        logs: [],
      }),
      progress: 90,
      stage: "Mixing final audio",
    },
  }));
  const finalPath = path.join(outputsDir, "rough-cut-final.mp4");
  await mixTimelineAudio({
    baseVideoPath: compositeResult.outputPath,
    outputPath: finalPath,
    job,
    includeOriginalAudio,
  });

  return {
    artifact: {
      id: `${job.jobId}:rough-cut`,
      kind: "output" as const,
      relativePath: artifactRelativePath(finalPath),
      mimeType: "video/mp4",
    },
    summary: `${compositeResult.applied ? "Composited" : "Rough-cut"} native render generated at ${job.output.width}x${job.output.height} ${job.output.fps}fps.`,
  };
}

async function writeJobManifestSnapshot(job: RenderJobRecord) {
  const jobDir = path.join(getRenderCacheRoot(), "jobs", job.jobId);
  await ensureDir(jobDir);
  const manifestPath = path.join(jobDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(job.manifest, null, 2), "utf8");
  return {
    id: `${job.jobId}:manifest`,
    kind: "manifest" as const,
    relativePath: artifactRelativePath(manifestPath),
    mimeType: "application/json",
  };
}

export async function processRenderJob(jobId: string) {
  const job = getRenderJob(jobId);
  if (!job) {
    throw new Error("Render job not found");
  }
  if (job.status === "processing" || job.status === "completed") {
    return job;
  }

  const initialLogs: RenderJobWorkerLogEntry[] = [];
  const appendLog = (entry: RenderJobWorkerLogEntry) => {
    initialLogs.push(entry);
    updateRenderJob(jobId, (current) => ({
      ...current,
      worker: {
        ...(current.worker ?? {
          processor: "local-native-worker",
          processedAssetIds: [],
          generatedArtifacts: [],
          logs: [],
        }),
        logs: [...(current.worker?.logs ?? []), entry],
      },
    }));
  };
  const updateWorkerStage = (progress: number, stage: string) => {
    updateRenderJob(jobId, (current) => ({
      ...current,
      worker: {
        ...(current.worker ?? {
          processor: "local-native-worker",
          processedAssetIds: [],
          generatedArtifacts: [],
          logs: [],
        }),
        progress,
        stage,
      },
    }));
  };

  const ffmpegVersion = await getFfmpegVersion();
  updateRenderJob(jobId, (current) => ({
    ...current,
    status: "processing",
    worker: {
      ...(current.worker ?? {
        processor: "local-native-worker",
        processedAssetIds: [],
        generatedArtifacts: [],
        logs: [],
      }),
      processor: "local-native-worker",
      startedAt: new Date().toISOString(),
      ffmpegVersion,
      progress: 2,
      stage: "Preparing native worker",
      errorMessage: undefined,
      summary: undefined,
    },
  }));

  appendLog(createLog("info", `Worker started with ${ffmpegVersion}`));

  try {
    const artifacts: RenderJobGeneratedArtifact[] = [];
    artifacts.push(await writeJobManifestSnapshot(job));
    const workerIssues: RenderJobIssue[] = [];
    updateWorkerStage(5, "Manifest snapshot ready");

    const renderStoreAssets = job.manifest.assets.filter(
      (
        asset
      ): asset is typeof asset & {
        source: Extract<typeof asset.source, { type: "render-asset-store" }>;
      } => asset.source.type === "render-asset-store"
    );

    for (let index = 0; index < renderStoreAssets.length; index += 1) {
      const manifestAsset = renderStoreAssets[index];
      updateWorkerStage(
        8 + Math.round(((index + 1) / Math.max(1, renderStoreAssets.length)) * 17),
        `Preparing asset ${index + 1}/${renderStoreAssets.length}`
      );
      const assetRecord = await getRenderAsset(manifestAsset.source.assetId);
      if (!assetRecord) {
        appendLog(createLog("warning", `Asset record missing for ${manifestAsset.id}`));
        continue;
      }

      const generated = await processAsset(assetRecord, appendLog);
      artifacts.push(...generated);
      updateRenderJob(jobId, (current) => ({
        ...current,
        worker: {
          ...(current.worker ?? {
            processor: "local-native-worker",
            processedAssetIds: [],
            generatedArtifacts: [],
            logs: [],
          }),
          processedAssetIds: [...new Set([...(current.worker?.processedAssetIds ?? []), manifestAsset.id])],
          generatedArtifacts: [
            ...(current.worker?.generatedArtifacts ?? []),
            ...generated.filter(
              (artifact) =>
                !(current.worker?.generatedArtifacts ?? []).some(
                  (existing) => existing.id === artifact.id
                )
            ),
          ],
        },
      }));
    }

    if (hasVisualCompositionRequirements(job)) {
      for (const issue of collectCompositionIssues(job)) {
        workerIssues.push(issue);
        appendLog(createLog(issue.severity === "error" ? "error" : "warning", issue.message));
      }
    }

    updateWorkerStage(30, "Rendering native output");
    const roughCut = await renderRoughCut(job, appendLog);
    artifacts.push(roughCut.artifact);
    const summary = `Processed ${renderStoreAssets.length} promoted asset(s); ${roughCut.summary}`;
    appendLog(createLog("info", summary));
    const updated = updateRenderJob(jobId, (current) => ({
      ...current,
      status: "completed",
      issues: [
        ...current.issues.filter((issue) => issue.code !== "NATIVE_WORKER_NOT_CONNECTED"),
        {
          severity: "info",
          code: "PROXY_PREP_COMPLETE",
          message: `Generated proxy artifacts for ${renderStoreAssets.length} promoted asset(s).`,
        },
        ...workerIssues,
      ],
      worker: {
        ...(current.worker ?? {
          processor: "local-native-worker",
          processedAssetIds: [],
          generatedArtifacts: [],
          logs: [],
        }),
        generatedArtifacts: [
          ...(current.worker?.generatedArtifacts ?? []),
          ...artifacts.filter(
            (artifact) =>
              !(current.worker?.generatedArtifacts ?? []).some(
                (existing) => existing.id === artifact.id
              )
          ),
        ],
        finishedAt: new Date().toISOString(),
        progress: 100,
        stage: "Completed",
        summary,
      },
    }));

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    appendLog(createLog("error", message));
    const updated = updateRenderJob(jobId, (current) => ({
      ...current,
      status: "failed",
      worker: {
        ...(current.worker ?? {
          processor: "local-native-worker",
          processedAssetIds: [],
          generatedArtifacts: [],
          logs: [],
        }),
        finishedAt: new Date().toISOString(),
        progress: 100,
        stage: "Failed",
        errorMessage: message,
      },
    }));
    if (!updated) {
      throw error;
    }
    return updated;
  }
}
