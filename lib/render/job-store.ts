import type {
  RenderJobIssue,
  RenderJobRecord,
  RenderJobStatus,
  RenderJobSubmission,
} from "@/types/render.types";
import fs from "node:fs";
import path from "node:path";

const CACHE_ROOT = path.join(process.cwd(), ".render-cache");
const JOBS_STORE_PATH = path.join(CACHE_ROOT, "jobs-store.json");

function ensureStoreDir() {
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
}

function readStore(): RenderJobRecord[] {
  ensureStoreDir();
  try {
    const raw = fs.readFileSync(JOBS_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RenderJobRecord[]) : [];
  } catch {
    return [];
  }
}

function writeStore(records: RenderJobRecord[]) {
  ensureStoreDir();
  fs.writeFileSync(JOBS_STORE_PATH, JSON.stringify(records, null, 2), "utf8");
}

function summarizeAssets(job: RenderJobSubmission) {
  const total = job.manifest.assets.length;
  const serverReady = job.manifest.assets.filter(
    (asset) => asset.availability === "server"
  ).length;

  return {
    total,
    serverReady,
    clientOnly: total - serverReady,
  };
}

function collectIssues(job: RenderJobSubmission): RenderJobIssue[] {
  const issues: RenderJobIssue[] = [
    {
      severity: "info",
      code: "NATIVE_WORKER_NOT_CONNECTED",
      message:
        "Native render worker is not connected yet; this job is stored as architecture scaffold.",
    },
  ];

  const clientAssets = job.manifest.assets.filter(
    (asset) => asset.availability === "client"
  );
  if (clientAssets.length > 0) {
    issues.push({
      severity: "warning",
      code: "CLIENT_ONLY_ASSETS",
      message: `${clientAssets.length} asset(s) still live only on the client and must be uploaded before native rendering can start.`,
    });
  }

  if (job.output.width >= 3840 && job.output.fps >= 60) {
    issues.push({
      severity: "warning",
      code: "HIGH_COMPUTE_PROFILE",
      message:
        "4K60 output is marked as a high-compute profile and should be queued only on capable workers.",
    });
  }

  if (job.output.transparentBackground && job.output.container === "mp4") {
    issues.push({
      severity: "error",
      code: "INVALID_TRANSPARENT_MP4",
      message: "Transparent output cannot target MP4 in the current render contract.",
    });
  }

  return issues;
}

function deriveStatus(issues: RenderJobIssue[]): RenderJobStatus {
  if (issues.some((issue) => issue.severity === "error")) {
    return "draft";
  }

  if (issues.some((issue) => issue.code === "CLIENT_ONLY_ASSETS")) {
    return "pending_assets";
  }

  return "queued";
}

export function createRenderJob(job: RenderJobSubmission): RenderJobRecord {
  const now = new Date().toISOString();
  const issues = collectIssues(job);
  const record: RenderJobRecord = {
    ...job,
    jobId: `render_${crypto.randomUUID()}`,
    status: deriveStatus(issues),
    createdAt: now,
    updatedAt: now,
    issues,
    assetSummary: summarizeAssets(job),
    worker: {
      processor: "local-native-worker",
      processedAssetIds: [],
      generatedArtifacts: [],
      logs: [],
    },
  };

  const records = readStore();
  records.push(record);
  writeStore(records);
  return record;
}

export function listRenderJobs(): RenderJobRecord[] {
  return readStore().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getRenderJob(jobId: string): RenderJobRecord | null {
  return readStore().find((job) => job.jobId === jobId) ?? null;
}

export function updateRenderJob(
  jobId: string,
  updater: (job: RenderJobRecord) => RenderJobRecord
): RenderJobRecord | null {
  const records = readStore();
  const index = records.findIndex((job) => job.jobId === jobId);
  if (index < 0) return null;

  const next = updater(records[index]);
  next.updatedAt = new Date().toISOString();
  records[index] = next;
  writeStore(records);
  return next;
}

export function isRenderJobSubmission(value: unknown): value is RenderJobSubmission {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<RenderJobSubmission>;
  return Boolean(
    candidate.manifest &&
      candidate.output &&
      candidate.execution &&
      candidate.execution.target === "native-render-worker" &&
      Array.isArray(candidate.manifest.assets) &&
      typeof candidate.manifest.manifestId === "string"
  );
}
