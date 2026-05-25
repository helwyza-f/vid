import { getRenderAsset, listRenderAssets, saveRenderAsset } from "@/lib/render/asset-store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function readNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const assetId = url.searchParams.get("assetId");

  if (assetId) {
    const asset = await getRenderAsset(assetId);
    if (!asset) {
      return NextResponse.json({ error: "Render asset not found" }, { status: 404 });
    }
    return NextResponse.json({ asset });
  }

  return NextResponse.json({ assets: await listRenderAssets() });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  const manifestAssetId = formData.get("manifestAssetId");
  const kind = formData.get("kind");

  if (!(file instanceof File) || typeof manifestAssetId !== "string" || typeof kind !== "string") {
    return NextResponse.json(
      { error: "file, manifestAssetId, and kind are required" },
      { status: 400 }
    );
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const asset = await saveRenderAsset({
    manifestAssetId,
    kind: kind as "video" | "audio" | "image" | "camera-video",
    fileName: typeof formData.get("fileName") === "string" ? String(formData.get("fileName")) : file.name,
    mimeType: typeof formData.get("mimeType") === "string" ? String(formData.get("mimeType")) : file.type,
    fileBuffer: buffer,
    metadata: {
      width: readNumber(formData.get("width")),
      height: readNumber(formData.get("height")),
      duration: readNumber(formData.get("duration")),
      fileSize: buffer.byteLength,
      hasAudio: formData.get("hasAudio") === "true" ? true : formData.get("hasAudio") === "false" ? false : undefined,
      originalHasAudio:
        formData.get("originalHasAudio") === "true"
          ? true
          : formData.get("originalHasAudio") === "false"
            ? false
            : undefined,
    },
  });

  return NextResponse.json({ asset }, { status: 201 });
}
