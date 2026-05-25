"use client";

import { Icon } from "@iconify/react";
import { ExportDropdown } from "../ExportDropdown";
import { ExportImageDropdown } from "../ExportImageDropdown";
import type { ExportQuality, ExportProgress, ExportRenderMode } from "@/types";
import type { EditorMode } from "@/types/editor-mode.types";
import type { ImageExportFormat } from "@/types/image-project.types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useTranslations } from "next-intl";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import Image from "next/image";
import Link from "next/link";
import { TooltipAction } from "@/components/ui/tooltip-action";
import type { CloudProject } from "@/types/cloud-project.types";

interface ImageExportProgress {
    status: "idle" | "preparing" | "rendering" | "complete" | "error";
    progress: number;
    message: string;
}

interface EditorTopBarProps {
    onExport: (quality: ExportQuality, renderMode?: ExportRenderMode) => void;
    onLegacyExport?: (quality: ExportQuality) => void;
    exportProgress: ExportProgress;
    hasTransparentBackground?: boolean;
    actualCaptureFps?: number | null;
    targetExportFps?: number | null;
    onUndo?: () => void;
    onRedo?: () => void;
    canUndo?: boolean;
    canRedo?: boolean;
    // Photo mode props
    editorMode?: EditorMode;
    onImageExport?: (format: ImageExportFormat, quality: number, scale: number) => void;
    imageExportProgress?: ImageExportProgress;
    canvasWidth?: number;
    canvasHeight?: number;
    activeProjectId?: string | null;
    activeProjectTitle?: string;
    projects?: CloudProject[];
    isLoadingProjects?: boolean;
    onSelectProject?: (projectId: string) => void;
    onCreateProject?: () => void;
    onRenameProject?: (title: string) => Promise<void> | void;
}

function formatFps(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "n/a";
    }

    return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function EditorTopBar({
    onExport,
    onLegacyExport,
    exportProgress,
    hasTransparentBackground,
    actualCaptureFps,
    targetExportFps,
    onUndo,
    onRedo,
    canUndo = false,
    canRedo = false,
    editorMode = "video",
    onImageExport,
    imageExportProgress,
    canvasWidth = 1920,
    canvasHeight = 1080,
    activeProjectId,
    activeProjectTitle = "Untitled project",
    projects = [],
    isLoadingProjects = false,
    onSelectProject,
    onCreateProject,
    onRenameProject,
}: EditorTopBarProps) {
    const isPhotoMode = editorMode === "photo";
    const t = useTranslations("editor.topBar");
    const [showAlert, setShowAlert] = useState(false);
    const [prevStatus, setPrevStatus] = useState<string>(exportProgress.status);
    const { user, profile, signOut, loading } = useAuth();
    const [isLoggingOut, setIsLoggingOut] = useState(false);
    const [projectTitleDraft, setProjectTitleDraft] = useState(activeProjectTitle);

    useEffect(() => {
        setProjectTitleDraft(activeProjectTitle);
    }, [activeProjectTitle]);

    const handleSignOut = async () => {
        setIsLoggingOut(true);
        try {
            await signOut();
            window.location.href = "/";
        } catch (error) {
            console.error("Error signing out:", error);
            setIsLoggingOut(false);
        }
    };

    const meta = user?.user_metadata || {};
    const displayName =
        profile?.first_name ||
        profile?.full_name ||
        meta.full_name ||
        meta.name ||
        user?.email?.split("@")[0] ||
        t("auth.defaultUser");

    const avatarUrl =
        profile?.avatar_url ||
        meta.avatar_url ||
        meta.picture ||
        `https://api.dicebear.com/7.x/initials/svg?seed=${displayName}`;

    const provider = profile?.provider || meta.provider || "email";

    if (exportProgress.status !== prevStatus) {
        setPrevStatus(exportProgress.status);
        if (exportProgress.status === "error") {
            setShowAlert(true);
        } else {
            setShowAlert(false);
        }
    }

    useEffect(() => {
        if (showAlert) {
            const timer = setTimeout(() => {
                setShowAlert(false);
            }, 10000);
            return () => clearTimeout(timer);
        }
    }, [showAlert]);

    const handleProjectTitleBlur = async () => {
        const nextTitle = projectTitleDraft.trim() || "Untitled project";
        setProjectTitleDraft(nextTitle);
        if (nextTitle !== activeProjectTitle) {
            await onRenameProject?.(nextTitle);
        }
    };

    return (
        <div className="h-13 border-b border-white/10 flex items-center justify-between px-3 shrink-0 relative">
            {showAlert && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 w-full max-w-md z-200 px-4 animate-in fade-in zoom-in slide-in-from-top-4 duration-300">
                    <Alert variant="info" className="relative border-red-500/50 bg-red-950/95 backdrop-blur-lg shadow-2xl overflow-hidden">
                        <button
                            onClick={() => setShowAlert(false)}
                            className="absolute top-3 right-3 p-1 rounded-md text-white hover:text-red-100 hover:bg-white/10 transition-all duration-200 group"
                            aria-label={t("exportError.close")}
                        >
                            <Icon icon="lucide:x" className="h-4 w-4" />
                        </button>
                        <Icon icon="lucide:alert-circle" className="h-4 w-4 text-red-400" />
                        <div className="pr-6">
                            <AlertTitle className="text-red-100 font-medium">{t("exportError.title")}</AlertTitle>
                            <AlertDescription className="flex flex-col gap-2 mt-1">
                                <span className="text-red-200/90 text-xs">{exportProgress.message}</span>
                                <span className="text-xs leading-tight text-white/90">
                                    {t("exportError.tip")}
                                </span>
                            </AlertDescription>
                        </div>
                    </Alert>
                </div>
            )}

            <div className="flex min-w-0 flex-1 items-center">
                {activeProjectId && (
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                            <button className="flex h-9 min-w-0 max-w-70 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-left text-white/80 transition hover:bg-white/[0.06] hover:text-white">
                                <Icon icon="solar:folder-with-files-outline" className="size-4 shrink-0 text-white/50" />
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">{activeProjectTitle}</span>
                                <Icon icon="lucide:chevron-down" className="size-4 shrink-0 text-white/40" />
                            </button>
                        </DropdownMenu.Trigger>

                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                className="z-9999 w-80 rounded-lg border border-white/15 bg-black p-2 shadow-xl"
                                sideOffset={8}
                                align="start"
                            >
                                <div className="px-2 pb-2">
                                    <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-white/35">
                                        Project name
                                    </label>
                                    <input
                                        value={projectTitleDraft}
                                        onChange={(event) => setProjectTitleDraft(event.target.value)}
                                        onBlur={handleProjectTitleBlur}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                event.currentTarget.blur();
                                            }
                                        }}
                                        className="h-9 w-full rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none transition focus:border-sky-400/60"
                                    />
                                </div>

                                <DropdownMenu.Separator className="my-1 h-px bg-white/10" />

                                <div className="max-h-72 overflow-y-auto py-1">
                                    {isLoadingProjects ? (
                                        <div className="px-3 py-2 text-xs text-white/45">Loading projects...</div>
                                    ) : projects.length === 0 ? (
                                        <div className="px-3 py-2 text-xs text-white/45">No projects yet.</div>
                                    ) : (
                                        projects.map((project) => (
                                            <DropdownMenu.Item
                                                key={project.id}
                                                onSelect={() => onSelectProject?.(project.id)}
                                                className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-white/70 outline-none transition hover:bg-white/5 hover:text-white data-[highlighted]:bg-white/5 data-[highlighted]:text-white"
                                            >
                                                <Icon
                                                    icon={project.id === activeProjectId ? "solar:check-circle-bold" : "solar:video-frame-play-horizontal-outline"}
                                                    className={`size-4 shrink-0 ${project.id === activeProjectId ? "text-sky-400" : "text-white/35"}`}
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate font-medium">{project.title}</div>
                                                    <div className="text-[11px] text-white/35">{project.duration.toFixed(0)}s</div>
                                                </div>
                                            </DropdownMenu.Item>
                                        ))
                                    )}
                                </div>

                                <DropdownMenu.Separator className="my-1 h-px bg-white/10" />

                                <DropdownMenu.Item
                                    onSelect={() => onCreateProject?.()}
                                    className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm text-white/80 outline-none transition hover:bg-white/5 hover:text-white data-[highlighted]:bg-white/5 data-[highlighted]:text-white"
                                >
                                    <Icon icon="solar:add-circle-bold" className="size-4 text-white/60" />
                                    New project
                                </DropdownMenu.Item>
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                )}
            </div>

            <div className="flex items-center ml-auto">
                <div className="flex items-center gap-2 border-r border-white/10 pr-3">
                    <TooltipAction label={canUndo ? t("history.undo") : t("history.noUndo")}>
                        <button
                            onClick={onUndo}
                            disabled={!canUndo}
                            className={`transition-colors ${canUndo ? "hover:text-white text-white/70" : "opacity-30 cursor-not-allowed text-white/30"
                                }`}
                        >
                            <Icon icon="mdi:undo" width="20" />
                        </button>
                    </TooltipAction>
                    <TooltipAction label={canRedo ? t("history.redo") : t("history.noRedo")}>
                        <button
                            onClick={onRedo}
                            disabled={!canRedo}
                            className={`transition-colors ${canRedo ? "hover:text-white text-white/70" : "opacity-30 cursor-not-allowed text-white/60"
                                }`}
                        >
                            <Icon icon="mdi:redo" width="20" />
                        </button>
                    </TooltipAction>
                </div>

                <div className="hidden xl:flex items-center gap-2 px-3 border-r border-white/10">
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">
                        <div className="text-[9px] uppercase tracking-[0.18em] text-white/30">Capture</div>
                        <div className="text-xs font-semibold text-white/80">{formatFps(actualCaptureFps)}fps</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1">
                        <div className="text-[9px] uppercase tracking-[0.18em] text-white/30">Export</div>
                        <div className="text-xs font-semibold text-white/80">{formatFps(targetExportFps)}fps</div>
                    </div>
                </div>

                {isPhotoMode && onImageExport && imageExportProgress ? (
                    <ExportImageDropdown
                        onExport={onImageExport}
                        exportProgress={imageExportProgress}
                        hasTransparentBackground={hasTransparentBackground}
                        canvasWidth={canvasWidth}
                        canvasHeight={canvasHeight}
                    />
                ) : (
                    <ExportDropdown
                        onExport={onExport}
                        onLegacyExport={onLegacyExport}
                        exportProgress={exportProgress}
                        hasTransparentBackground={hasTransparentBackground}
                    />
                )}

                {loading ? (
                    <div className="flex items-center gap-2 pl-3 border-l border-white/10 ml-1">
                        <div className="hidden sm:flex flex-col items-end gap-1.5">
                            <div className="w-16 h-2.5 bg-white/10 rounded-sm animate-pulse"></div>
                            <div className="w-24 h-2 bg-white/10 rounded-sm animate-pulse"></div>
                        </div>
                        <div className="h-8 w-8 rounded-full bg-white/10 animate-pulse border border-white/10 shrink-0"></div>
                    </div>
                ) : !user ? (
                    <div className="pl-3 border-l border-white/10 ml-1 flex items-center h-8">
                        <Link href="/login" className="text-sm font-medium text-white/80 hover:text-white transition-colors">
                            {t("auth.signIn")}
                        </Link>
                    </div>
                ) : (
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                            <button
                                className="flex items-center gap-2 pl-3 border-l border-white/10 ml-1 hover:opacity-80 transition-opacity focus:outline-none"
                                aria-label={t("auth.userMenu")}
                            >
                                <div className="hidden sm:flex flex-col items-end leading-none">
                                    <span className="text-[11px] font-medium text-white max-w-25 truncate">{displayName}</span>
                                    <span className="text-[10px] text-neutral-500 max-w-30 truncate">{user.email}</span>
                                </div>
                                <div className="h-8 w-8 rounded-full border border-white/10 bg-neutral-900 overflow-hidden shrink-0 relative">
                                    <Image src={avatarUrl} alt={displayName} fill sizes="32px" className="object-cover" unoptimized />
                                </div>
                            </button>
                        </DropdownMenu.Trigger>

                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                className="min-w-55 bg-black border border-white/25 rounded-lg shadow-xl p-1 z-9999"
                                sideOffset={5}
                                align="end"
                            >
                                <div className="px-3 py-2 border-b border-white/10">
                                    <p className="text-sm font-medium text-white truncate">{displayName}</p>
                                    <p className="text-xs text-neutral-400 truncate">{user.email}</p>
                                    <p className="text-xs text-neutral-500 mt-1 capitalize">
                                        {t("auth.connectedWith", { provider })}
                                    </p>
                                </div>
                                <DropdownMenu.Item asChild>
                                    <Link
                                        href="/"
                                        className="flex items-center gap-3 px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer outline-none"
                                    >
                                        <Icon icon="hugeicons:home-11" className="size-4" />
                                        {t("auth.home")}
                                    </Link>
                                </DropdownMenu.Item>
                                <DropdownMenu.Item asChild>
                                    <Link
                                        href="/projects"
                                        className="flex items-center gap-3 px-3 py-2 text-sm text-neutral-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors cursor-pointer outline-none"
                                    >
                                        <Icon icon="solar:video-frame-cut-2-linear" className="size-4" />
                                        Projects
                                    </Link>
                                </DropdownMenu.Item>
                                <DropdownMenu.Separator className="h-px bg-white/10 my-1" />
                                <DropdownMenu.Item asChild>
                                    <button
                                        onClick={handleSignOut}
                                        disabled={isLoggingOut}
                                        className="w-full flex items-center gap-3 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <Icon icon="solar:logout-2-linear" className="size-4" />
                                        {isLoggingOut ? t("auth.signingOut") : t("auth.signOut")}
                                    </button>
                                </DropdownMenu.Item>
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                )}
            </div>
        </div>
    );
}
