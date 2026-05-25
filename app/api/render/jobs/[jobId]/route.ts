import { getRenderJob } from "@/lib/render/job-store";
import { processRenderJob } from "@/lib/render/worker";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await context.params;
  const job = getRenderJob(jobId);

  if (!job) {
    return NextResponse.json(
      {
        error: "Render job not found",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ job });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await context.params;
  const body = await request.json().catch(() => ({}));

  if (body?.action !== "process") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  const job = getRenderJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Render job not found" }, { status: 404 });
  }

  void processRenderJob(jobId).catch((error) => {
    console.error(`Failed to process render job ${jobId}:`, error);
  });

  return NextResponse.json(
    {
      job: getRenderJob(jobId),
      accepted: true,
    },
    { status: 202 }
  );
}
