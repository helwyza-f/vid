"use client";

import { Button } from "@/components/ui/button";
import { Icon } from "@iconify/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ExportQuality, ExportRenderMode } from "@/types";
import { useState } from "react";
import { useTranslations } from "next-intl";

interface ExportProgress {
  status: "idle" | "preparing" | "encoding" | "finalizing" | "complete" | "error";
  progress: number;
  message: string;
}

interface ExportDropdownProps {
  onExport: (quality: ExportQuality, renderMode?: ExportRenderMode) => void;
  onLegacyExport?: (quality: ExportQuality) => void;
  exportProgress: ExportProgress;
  hasTransparentBackground?: boolean;
}

export function ExportDropdown({ onExport, onLegacyExport, exportProgress, hasTransparentBackground }: ExportDropdownProps) {
  const t = useTranslations("editor.export");
  const [isOpen, setIsOpen] = useState(false);

  const isExporting = exportProgress.status !== "idle" && 
                      exportProgress.status !== "complete" && 
                      exportProgress.status !== "error";
  
  const isTransparent = !!hasTransparentBackground;

  const handleExport = (quality: ExportQuality, renderMode?: ExportRenderMode) => {
    setIsOpen(false);
    onExport(quality, renderMode);
  };

  const handleLegacyExport = (quality: ExportQuality) => {
    setIsOpen(false);
    onLegacyExport?.(quality);
  };

  const renderQualityItem = (
    id: ExportQuality,
    resolution: string,
    isRecommended = false,
    renderMode?: ExportRenderMode
  ) => {
    const isGif = id === "gif";
    const modeLabel = renderMode === "high" ? t("modeHigh") : renderMode === "fast" ? t("modeFast") : null;
    const modeDescription = renderMode === "high" ? t("modeHighDesc") : renderMode === "fast" ? t("modeFastDesc") : null;
    
    return (
      <button 
        className={`group flex flex-col items-start gap-1.5 p-4 transition-all text-left border-b border-white/10 ${
          isGif ? (isTransparent ? "opacity-80 hover:bg-orange-500/5" : "hover:bg-orange-500/5") : 
          (isTransparent ? "hover:bg-cyan-500/5" : "hover:bg-white/5")
        }`} 
        onClick={() => handleExport(id, renderMode)}
        aria-label={`Export as ${id.toUpperCase()} ${resolution}${modeLabel ? ` ${modeLabel}` : ""}`}
      >
        <div className="flex items-center justify-between w-full">
          <span className={`text-sm font-medium transition-colors flex items-center gap-2 ${
            isGif ? "text-orange-400 group-hover:text-orange-300" : 
            "text-white group-hover:text-blue-400"
          }`}>
            <span>
              {isTransparent && !isGif ? (
                <>{id.toUpperCase()} WebM · <span className="text-cyan-400 group-hover:text-cyan-300">{t("noBackground")}</span></>
              ) : (
                t(`qualities.${id}.label`)
              )}
            </span>
            {modeLabel && !isTransparent && !isGif && (
              <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.18em] ${
                renderMode === "high"
                  ? "border-fuchsia-500/30 text-fuchsia-300"
                  : "border-emerald-500/30 text-emerald-300"
              }`}>
                {modeLabel}
              </span>
            )}
          </span>
          {isRecommended && !isTransparent && (
            <span className="border border-blue-500/30 text-blue-400 text-[9px] px-2 py-0.5 rounded-full font-bold tracking-tight">
              {t("recommended")}
            </span>
          )}
          {isGif && isTransparent && (
            <span className="text-[9px] text-red-400/80 font-bold bg-red-500/10 px-2 py-0.5 rounded-full border border-red-500/20">
              {t("solidBackground")}
            </span>
          )}
        </div>
        <span className={`text-[11px] font-mono ${isGif ? "text-orange-400/70" : "text-white/50"}`}>
          {isTransparent ? (
            <>{resolution} · <span className="text-cyan-400/70">{isGif ? t("gifNotice") : "VP9 Alpha"}</span></>
          ) : (
            <>
              {t(`qualities.${id}.desc`)}
              {modeDescription ? ` · ${modeDescription}` : ""}
            </>
          )}
        </span>
      </button>
    );
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button 
          variant="primary" 
          className="px-3 py-2 text-sm gap-2 min-w-27.5" 
          size="sm" 
          disabled={isExporting}
          aria-label={t("button")}
        >
          <Icon icon="icon-park-outline:export" width="18" aria-hidden="true" />
          {t("button")}
          <Icon icon="mdi:chevron-down" width="16" className="opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 bg-[#1C1C1F] border-white/10 text-white shadow-2xl p-0 overflow-hidden">
        <div className="flex flex-col bg-black border border-white/10 rounded-xl overflow-hidden shadow-2xl">
          <div className="px-4 py-3 border-b border-white/10 bg-white/5">
            <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-white/50">
              {t("title")}
            </span>
          </div>
          <div className="flex flex-col max-h-120 overflow-y-auto custom-scrollbar">
            {renderQualityItem("4k", "3840 × 2160", false, "fast")}
            {renderQualityItem("4k", "3840 × 2160", false, "high")}
            {renderQualityItem("2k", "2560 × 1440")}
            {renderQualityItem("1080p", "1920 × 1080", true, "fast")}
            {renderQualityItem("1080p", "1920 × 1080", false, "high")}
            {renderQualityItem("720p", "1280 × 720")}
            {renderQualityItem("480p", "854 × 480")}
            {renderQualityItem("gif", "1280 × 720")}
          </div>
          {onLegacyExport && (
            <div className="border-t border-white/10 bg-white/[0.03] p-3">
              <button
                onClick={() => handleLegacyExport("1080p")}
                className="w-full rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-left text-xs text-amber-200 transition hover:bg-amber-500/10"
              >
                <span className="block font-medium">Legacy browser fallback</span>
                <span className="mt-1 block text-[11px] text-amber-200/70">Use the old in-browser exporter for manual debugging.</span>
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
