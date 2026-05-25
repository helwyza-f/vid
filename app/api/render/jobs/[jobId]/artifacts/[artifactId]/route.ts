import { getRenderCacheRoot } from "@/lib/render/asset-store";
import { getRenderJob } from "@/lib/render/job-store";
import { promises as fs } from "node:fs";
import path from "node:path";

function sanitizeDownloadName(input: string) {
  return input.replace(/[^a-z0-9._-]/gi, "-");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string; artifactId: string }> }
) {
  const { jobId, artifactId } = await context.params;
  const job = getRenderJob(jobId);

  if (!job) {
    return new Response(JSON.stringify({ error: "Render job not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const decodedArtifactId = decodeURIComponent(artifactId);
  const artifact = job.worker?.generatedArtifacts.find(
    (entry) => entry.id === decodedArtifactId
  );

  if (!artifact) {
    return new Response(JSON.stringify({ error: "Artifact not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cacheRoot = getRenderCacheRoot();
  const absolutePath = path.resolve(cacheRoot, artifact.relativePath);
  const relativeToRoot = path.relative(cacheRoot, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return new Response(JSON.stringify({ error: "Invalid artifact path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const buffer = await fs.readFile(absolutePath).catch(() => null);
  if (!buffer) {
    return new Response(JSON.stringify({ error: "Artifact file missing" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fileName = sanitizeDownloadName(path.basename(artifact.relativePath));
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
