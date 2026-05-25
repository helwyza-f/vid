import { createRenderJob, isRenderJobSubmission, listRenderJobs } from "@/lib/render/job-store";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    jobs: listRenderJobs(),
  });
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);

  if (!isRenderJobSubmission(payload)) {
    return NextResponse.json(
      {
        error: "Invalid render job payload",
      },
      { status: 400 }
    );
  }

  const job = createRenderJob(payload);
  return NextResponse.json({ job }, { status: 201 });
}
