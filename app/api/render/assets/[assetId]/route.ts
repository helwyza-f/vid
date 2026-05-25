import { getRenderAsset } from "@/lib/render/asset-store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await context.params;
  const asset = await getRenderAsset(assetId);

  if (!asset) {
    return NextResponse.json({ error: "Render asset not found" }, { status: 404 });
  }

  return NextResponse.json({ asset });
}
