"use client";

import { useState, useRef, useEffect, useCallback, lazy, Suspense, useMemo } from "react";
import { toBlob } from 'html-to-image';
import { Icon } from "@iconify/react";
import { motion, AnimatePresence } from "framer-motion";
import { loadVideoFromIndexedDB, deleteRecordedVideo } from "@/hooks/useScreenRecording";
import { useVideoUpload } from "@/hooks/useVideoUpload";
import { useImageProjects } from "@/hooks/useImageProjects";
import { getUploadedVideo, deleteUploadedVideo } from "@/lib/video-upload-cache";
import { getUploadedImage, deleteUploadedImage } from "@/lib/image-upload-cache";
import { useEditorMode } from "@/hooks/useEditorMode";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import { useVideoExport } from "@/hooks/useVideoExport";
import { useVideoThumbnails, type VideoThumbnail } from "@/hooks/useVideoThumbnails";
import { useUndoRedo } from "@/hooks/useUndoRedo";
import { clearAllThumbnailCache } from "@/lib/thumbnail-cache";
import { addVideoToLibrary, addVideoToLibraryWithMetadata, getLibraryVideoCount, getLibraryVideo, findExistingVideo, findExistingCloudVideo, updateLibraryVideoCloudLink } from "@/lib/videos-library";
import { createProject as createCloudProject, createProjectAsset, downloadProjectAsset, getProject, listProjectAssets, listProjects, updateProject } from "@/lib/cloud-projects";
import type { CloudProject } from "@/types/cloud-project.types";
import { calculateTotalDuration, findNextClipPosition, getClipAtTime, type VideoTrackClip } from "@/types/video-track.types";
import type { ExportQuality, Tool, BackgroundTab, VideoCanvasHandle, BackgroundColorConfig, AspectRatio, CropArea, ZoomFragment, AudioTrack, ImageExportFormat } from "@/types";
import type { TrimRange } from "@/types/timeline.types";
import type { MockupConfig } from "@/types/mockup.types";
import type { EditorState } from "@/types/editor-state.types";
import { createInitialEditorState } from "@/types/editor-state.types";
import { DEFAULT_MOCKUP_CONFIG, getMockupDefaultConfig } from "@/types/mockup.types";
import type { CanvasElement } from "@/types/canvas-elements.types";
import type { CameraConfig } from "@/types/camera.types";
import type { Preview3DConfig, ImageMaskConfig } from "@/types/photo.types";
import { DEFAULT_MASK_CONFIG, PREVIEW_CONFIGS } from "@/types/photo.types";
import { MOCKUPS } from "@/lib/mockup-data";
import { gradientToCss, generateDefaultZoomFragments, createZoomFragment, ASPECT_RATIO_DIMENSIONS } from "@/types";
import { ToolsSidebar } from "@/app/components/ui/editor/ToolsSidebar";
import { MobileToolsMenu } from "@/app/components/ui/editor/MobileToolsMenu";
import { MobileControlPanel } from "@/app/components/ui/editor/MobileControlPanel";
import { EditorTopBar } from "@/app/components/ui/editor/EditorTopBar";
import { VideoCanvas } from "@/app/components/ui/editor/VideoCanvas";
import { PlayerControls } from "@/app/components/ui/editor/PlayerControls";
import { findValidFragmentPosition } from "@/app/components/ui/editor/ZoomFragmentTrackItem";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { TimelineSkeleton } from "@/app/components/ui/Skeleton";
import { AudioTrimModal } from "@/app/components/ui/editor/AudioTrimModal";
import { VIDEO_Z_INDEX } from "@/lib/constants";
import Image from "next/image";
import Link from "next/link";
import { TooltipAction } from "@/components/ui/tooltip-action";
import { useRouter, useSearchParams } from "next/navigation";

const ControlPanel = lazy(() => import("@/app/components/ui/editor/ControlPanel").then(mod => ({ default: mod.ControlPanel })));
const Timeline = lazy(() => import("@/app/components/ui/editor/Timeline").then(mod => ({ default: mod.Timeline })));
const ExportOverlay = lazy(() => import("@/app/components/ui/ExportOverlay").then(mod => ({ default: mod.ExportOverlay })));
const VideoCropperModal = lazy(() => import("@/app/components/ui/editor/VideoCropperModal").then(mod => ({ default: mod.VideoCropperModal })));
const ImageCropperModal = lazy(() => import("@/app/components/ui/editor/ImageCropperModal").then(mod => ({ default: mod.ImageCropperModal })));
const PhotoEditorPlaceholder = lazy(() => import("@/app/components/ui/editor/PhotoEditorPlaceholder").then(mod => ({ default: mod.PhotoEditorPlaceholder })));

const PLAYBACK_UI_UPDATE_INTERVAL_MS = 80;

export default function Editor() {
    // Editor mode (video/photo) from URL params
    const { mode: editorMode, isVideoMode, isPhotoMode } = useEditorMode();
    const router = useRouter();
    const searchParams = useSearchParams();
    const activeProjectId = searchParams.get("projectId");
    const [cloudProjectTitle, setCloudProjectTitle] = useState("Untitled project");
    const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([]);
    const [isCloudProjectsLoading, setIsCloudProjectsLoading] = useState(false);
    const [isCloudProjectLoading, setIsCloudProjectLoading] = useState(false);
    const [cloudProjectError, setCloudProjectError] = useState<string | null>(null);
    const restoringCloudProjectRef = useRef(false);
    const savingCloudProjectRef = useRef<NodeJS.Timeout | null>(null);

    // Undo/Redo system - centralized state management
    const {
        state: editorState,
        setState: setEditorState,
        undo,
        redo,
        canUndo,
        canRedo,
        clearHistory,
    } = useUndoRedo<EditorState>(createInitialEditorState());

    // Image state for photo mode
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const [imageExportProgress, setImageExportProgress] = useState<{
        status: "idle" | "preparing" | "rendering" | "complete" | "error";
        progress: number;
        message: string;
    }>({
        status: "idle",
        progress: 0,
        message: "",
    });

    // Screen capture hook
    const { captureScreen, isCapturing } = useScreenCapture();

    // Image projects system (IndexedDB persistence for photo mode)
    const {
        projects: imageProjects,
        currentProject,
        isLoading: isLoadingProjects,
        isSaving: isSavingProject,
        createProject,
        saveCurrentProject,
        switchToProject,
        removeProject,
    } = useImageProjects();

    // Photo mode 3D preview state
    const [selectedPreviewId, setSelectedPreviewId] = useState<string>("front");
    const [canvasImageUrl, setCanvasImageUrl] = useState<string | null>(null);
    const [imageTransform, setImageTransform] = useState<Preview3DConfig>({
        id: "front",
        label: "Front",
        rotateX: 0,
        rotateY: 0,
        rotateZ: 0,
        translateY: 0,
        scale: 0.9,
        perspective: 600,
    });
    const [apply3DToBackground, setApply3DToBackground] = useState(false);
    const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
    const [imageMaskConfig, setImageMaskConfig] = useState<ImageMaskConfig>(DEFAULT_MASK_CONFIG);
    const [videoMaskConfig, setVideoMaskConfig] = useState<ImageMaskConfig>(DEFAULT_MASK_CONFIG);

    const [activeTool, setActiveTool] = useState<Tool>("screenshot");
    const [elementsTextTabTrigger, setElementsTextTabTrigger] = useState(0);
    const [backgroundTab, setBackgroundTab] = useState<BackgroundTab>("wallpaper");
    const [selectedWallpaper, setSelectedWallpaper] = useState(0);
    const [backgroundBlur, setBackgroundBlur] = useState(0);
    const [padding, setPadding] = useState(10);
    const [roundedCorners, setRoundedCorners] = useState(10);
    const [shadows, setShadows] = useState(10);
    const [isControlPanelOpen, setIsControlPanelOpen] = useState(true);
    const [isMobileControlPanelOpen, setIsMobileControlPanelOpen] = useState(false);

    // Video transform state (rotation and position)
    const [videoTransform, setVideoTransform] = useState<{ rotation: number; translateX: number; translateY: number }>({
        rotation: 0,
        translateX: 0,
        translateY: 0,
    });

    // Custom background images
    const [uploadedImages, setUploadedImages] = useState<string[]>(() => {
        if (typeof window !== 'undefined') {
            const stored = localStorage.getItem("openvid-uploaded-images");
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    if (Array.isArray(parsed)) {
                        return parsed;
                    }
                } catch (error) {
                    console.error("Error loading uploaded images:", error);
                }
            }
        }
        return [];
    });
    const [selectedImageUrl, setSelectedImageUrl] = useState<string>("");
    const [unsplashBgUrl, setUnsplashBgUrl] = useState<string>("");

    // Background color/gradient state
    const [backgroundColorConfig, setBackgroundColorConfig] = useState<BackgroundColorConfig | null>(null);

    // Aspect ratio, fullscreen, and cropper state
    const [aspectRatio, setAspectRatio] = useState<AspectRatio>("auto");
    const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
    const [customDimensions, setCustomDimensions] = useState<{ width: number; height: number } | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isCropperOpen, setIsCropperOpen] = useState(false);
    const [cropArea, setCropArea] = useState<CropArea | undefined>(undefined);

    // Computed: which dimensions to use for the canvas
    const customAspectRatio = aspectRatio === "auto"
        ? (isPhotoMode ? imageDimensions : videoDimensions)
        : (aspectRatio === "custom" ? customDimensions : null);

    // Refs for fullscreen
    const editorAreaRef = useRef<HTMLDivElement>(null);
    const clipSwitchTimeRef = useRef<number | null>(null);
    const isSeekingToClipRef = useRef<boolean>(false);

    // Video state
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [videoId, setVideoId] = useState<string | null>(null);
    const [videoDuration, setVideoDuration] = useState<number>(0);
    const [currentTime, setCurrentTimeState] = useState<number>(0);
    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<VideoCanvasHandle>(null);
    const isSwitchingClipRef = useRef<boolean>(false);
    const currentTimeRef = useRef(0);
    const isPlayingRef = useRef(false);
    const lastCurrentTimeRenderRef = useRef(0);

    useEffect(() => {
        isPlayingRef.current = isPlaying;
    }, [isPlaying]);

    const setCurrentTime = useCallback((time: number, force = false) => {
        currentTimeRef.current = time;

        const now = performance.now();
        const shouldThrottle = isPlayingRef.current && !force;
        if (
            shouldThrottle &&
            now - lastCurrentTimeRenderRef.current < PLAYBACK_UI_UPDATE_INTERVAL_MS
        ) {
            return;
        }

        lastCurrentTimeRenderRef.current = now;
        setCurrentTimeState(prev => (Math.abs(prev - time) < 0.001 ? prev : time));
    }, []);

    // Timeline state
    const [timelineZoom, setTimelineZoom] = useState<number>(1);
    const [isDraggingPlayhead, setIsDraggingPlayhead] = useState<boolean>(false);
    const [trimRange, setTrimRange] = useState<TrimRange>({ start: 0, end: 0 });
    const animationFrameRef = useRef<number | null>(null);
    const justEndedRef = useRef<boolean>(false);
    const wasPlayingBeforeDragRef = useRef<boolean>(false);
    const isExportingRef = useRef(false);
    const [scrubTime, setScrubTime] = useState<number>(0);
    // Ref that is always in sync with scrubTime — avoids stale closure in handlePlayheadDragEnd
    const scrubTimeRef = useRef<number>(0);

    // Zoom fragments state
    const [zoomFragments, setZoomFragments] = useState<ZoomFragment[]>([]);
    const [selectedZoomFragmentId, setSelectedZoomFragmentId] = useState<string | null>(null);

    // Ref to always have the latest zoomFragments value (prevents stale closures)
    const zoomFragmentsRef = useRef<ZoomFragment[]>([]);
    useEffect(() => {
        zoomFragmentsRef.current = zoomFragments;
    }, [zoomFragments]);

    // Mockup state
    const [mockupId, setMockupId] = useState<string>("none");
    const [mockupConfig, setMockupConfig] = useState<MockupConfig>(DEFAULT_MOCKUP_CONFIG);

    // Canvas elements state
    const [canvasElements, setCanvasElements] = useState<CanvasElement[]>([]);
    const [selectedElementId, setSelectedElementId] = useState<string | null>(null);

    // Audio state
    const [uploadedAudios, setUploadedAudios] = useState<import("@/types/audio.types").UploadedAudio[]>([]);
    const [audioTracks, setAudioTracks] = useState<import("@/types/audio.types").AudioTrack[]>([]);
    const [muteOriginalAudio, setMuteOriginalAudio] = useState<boolean>(false);
    const [masterVolume, setMasterVolume] = useState<number>(1);
    const [selectedAudioTrackId, setSelectedAudioTrackId] = useState<string | null>(null);
    // Whether the currently loaded source video file contains an audio stream
    const [videoHasAudioTrack, setVideoHasAudioTrack] = useState<boolean>(true);

    const [isRecordedVideo, setIsRecordedVideo] = useState<boolean>(false);

    // Camera overlay state (from recorded video's camera track, or post-record adjustments)
    const [cameraConfig, setCameraConfig] = useState<CameraConfig | null>(null);
    const [cameraUrl, setCameraUrl] = useState<string | null>(null);

    const handleCameraConfigChange = useCallback((partial: Partial<CameraConfig>) => {
        setCameraConfig((prev) => (prev ? { ...prev, ...partial } : prev));
    }, []);

    const handleCameraClick = useCallback(() => {
        setActiveTool("camera");
    }, []);

    // Auto-save current image project when configurations change
    const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const isRestoringProjectRef = useRef(false);
    const isLoadingFromCacheRef = useRef(false);
    const lastRestoredProjectIdRef = useRef<string | null>(null);

    const autoSaveCurrentProject = useCallback(async () => {
        if (!isPhotoMode || !imageUrl || !currentProject) return;

        // Don't auto-save during project restoration
        if (isRestoringProjectRef.current) return;

        // Debounce saves to avoid excessive writes
        if (autoSaveTimeoutRef.current) {
            clearTimeout(autoSaveTimeoutRef.current);
        }

        autoSaveTimeoutRef.current = setTimeout(async () => {
            try {
                await saveCurrentProject({
                    backgroundTab,
                    selectedWallpaper,
                    backgroundBlur,
                    selectedImageUrl,
                    backgroundColorConfig,
                    padding,
                    roundedCorners,
                    shadows,
                    aspectRatio,
                    customDimensions,
                    cropArea,
                    mockupId,
                    mockupConfig,
                    canvasElements,
                    imageTransform: {
                        rotation: videoTransform.rotation,
                        translateX: videoTransform.translateX,
                        translateY: videoTransform.translateY,
                    },
                    imagePreview3D: imageTransform,
                    apply3DToBackground,
                    imageMaskConfig,
                });
            } catch (error) {
                console.error("Auto-save failed:", error);
            }
        }, 3000); // 3 second debounce
    }, [
        isPhotoMode,
        imageUrl,
        currentProject,
        saveCurrentProject,
        backgroundTab,
        selectedWallpaper,
        backgroundBlur,
        selectedImageUrl,
        backgroundColorConfig,
        padding,
        roundedCorners,
        shadows,
        aspectRatio,
        customDimensions,
        cropArea,
        mockupId,
        mockupConfig,
        canvasElements,
        videoTransform,
        imageTransform,
        apply3DToBackground,
        imageMaskConfig,
    ]);

    useEffect(() => {
        if (currentProject && isPhotoMode && !isRestoringProjectRef.current) {
            autoSaveCurrentProject();
        }
    }, [
        backgroundTab,
        selectedWallpaper,
        backgroundBlur,
        selectedImageUrl,
        backgroundColorConfig,
        padding,
        roundedCorners,
        shadows,
        aspectRatio,
        customDimensions,
        cropArea,
        mockupId,
        mockupConfig,
        canvasElements,
        videoTransform,
        imageTransform,
        apply3DToBackground,
        imageMaskConfig,
        currentProject,
        isPhotoMode,
        autoSaveCurrentProject,
    ]);

    // Restore current project when project ID changes (not on every currentProject update)
    useEffect(() => {
        if (!isPhotoMode || !currentProject) return;

        if (lastRestoredProjectIdRef.current === currentProject.id) return;

        isRestoringProjectRef.current = true;
        lastRestoredProjectIdRef.current = currentProject.id;

        const imageDataUrl = currentProject.imageDataUrl;

        if (!imageDataUrl) {
            console.error("Project missing imageDataUrl");
            isRestoringProjectRef.current = false;
            return;
        }

        // Directly restore all states using the data URL
        setImageUrl(imageDataUrl);
        setBackgroundTab(currentProject.backgroundTab);
        setSelectedWallpaper(currentProject.selectedWallpaper);
        setBackgroundBlur(currentProject.backgroundBlur);
        setSelectedImageUrl(currentProject.selectedImageUrl);
        setBackgroundColorConfig(currentProject.backgroundColorConfig);
        setPadding(currentProject.padding);
        setRoundedCorners(currentProject.roundedCorners);
        setShadows(currentProject.shadows);
        setAspectRatio(currentProject.aspectRatio);
        setCustomDimensions(currentProject.customDimensions);
        setCropArea(currentProject.cropArea);
        setMockupId(currentProject.mockupId);
        setMockupConfig(currentProject.mockupConfig);
        setCanvasElements(currentProject.canvasElements);
        setVideoTransform(currentProject.imageTransform);
        setImageTransform(currentProject.imagePreview3D);
        setApply3DToBackground(currentProject.apply3DToBackground);
        setImageMaskConfig(currentProject.imageMaskConfig);
        setImageDimensions({
            width: currentProject.imageWidth,
            height: currentProject.imageHeight,
        });

        setTimeout(() => {
            isRestoringProjectRef.current = false;
        }, 500); // 
    }, [currentProject, isPhotoMode]);

    // Image project handlers
    const handleSelectImageProject = useCallback(async (projectId: string) => {
        if (!isPhotoMode) return;

        // Save current project before switching
        if (currentProject && imageUrl) {
            await autoSaveCurrentProject();
        }

        // Load the selected project
        await switchToProject(projectId);
    }, [isPhotoMode, currentProject, imageUrl, autoSaveCurrentProject, switchToProject]);

    const handleAddImageToCanvas = useCallback(async (projectId: string) => {
        await handleSelectImageProject(projectId);
    }, [handleSelectImageProject]);

    const handleDeleteImageProject = useCallback(async (projectId: string) => {
        // If deleting the current project, cancel auto-save and clear state immediately
        const isDeletingCurrent = currentProject?.id === projectId;

        if (isDeletingCurrent) {
            // Cancel any pending auto-save to prevent race condition
            if (autoSaveTimeoutRef.current) {
                clearTimeout(autoSaveTimeoutRef.current);
                autoSaveTimeoutRef.current = null;
            }
        }

        await removeProject(projectId);

        // Clear canvas if we deleted the current project
        if (isDeletingCurrent) {
            setImageUrl(null);
            setCanvasImageUrl(null);
            setImageDimensions(null);
            // Reset to default state
            setBackgroundTab("wallpaper");
            setSelectedWallpaper(0);
            setBackgroundBlur(0);
            setPadding(10);
            setRoundedCorners(10);
            setShadows(10);
            setAspectRatio("auto");
            setCustomDimensions(null);
            setCropArea(undefined);
            setMockupId("none");
            setMockupConfig(DEFAULT_MOCKUP_CONFIG);
            setCanvasElements([]);
            setImageTransform({ id: "front", label: "Front", rotateX: 0, rotateY: 0, rotateZ: 0, translateY: 0, scale: 0.9, perspective: 600 });
            setApply3DToBackground(false);
            setImageMaskConfig(DEFAULT_MASK_CONFIG);
        }
    }, [currentProject, removeProject]);

    const handleUploadImageToHistory = useCallback(async (file: File) => {
        // This will create a new project when user uploads from history menu
        try {
            const img = await createImageBitmap(file);
            const project = await createProject(
                file,
                file.name,
                img.width,
                img.height,
                {
                    backgroundTab,
                    selectedWallpaper,
                    backgroundBlur,
                    selectedImageUrl,
                    backgroundColorConfig,
                    padding,
                    roundedCorners,
                    shadows,
                    aspectRatio,
                    customDimensions,
                    cropArea,
                    mockupId,
                    mockupConfig,
                    canvasElements,
                    imageTransform: {
                        rotation: videoTransform.rotation,
                        translateX: videoTransform.translateX,
                        translateY: videoTransform.translateY,
                    },
                    imagePreview3D: imageTransform,
                    apply3DToBackground,
                    imageMaskConfig,
                }
            );

            if (project) {
                setImageUrl(project.imageDataUrl);
                setImageDimensions({ width: img.width, height: img.height });
            }
        } catch (error) {
            console.error("Failed to upload image to history:", error);
        }
    }, [
        createProject,
        backgroundTab,
        selectedWallpaper,
        backgroundBlur,
        selectedImageUrl,
        backgroundColorConfig,
        padding,
        roundedCorners,
        shadows,
        aspectRatio,
        customDimensions,
        cropArea,
        mockupId,
        mockupConfig,
        canvasElements,
        videoTransform,
        imageTransform,
        apply3DToBackground,
        imageMaskConfig,
    ]);

    // Screen capture handler - now creates a project
    const handleScreenCapture = useCallback(async () => {
        const blob = await captureScreen();
        if (blob) {
            try {
                const file = new File([blob], `Screenshot ${new Date().toLocaleString()}.png`, { type: "image/png" });
                const img = await createImageBitmap(blob);

                const project = await createProject(
                    file,
                    file.name,
                    img.width,
                    img.height
                );

                if (project) {
                    setImageUrl(project.imageDataUrl);
                    setImageDimensions({ width: img.width, height: img.height });
                }
            } catch (error) {
                console.error("Failed to create project from screenshot:", error);
            }
        }
    }, [captureScreen, createProject]);

    // Unified image upload handler - always creates a new history entry to preserve existing projects
    const handleImageUploadToCanvas = useCallback(async (file: File) => {
        try {
            const img = await createImageBitmap(file);
            const project = await createProject(
                file,
                file.name,
                img.width,
                img.height,
                {
                    backgroundTab,
                    selectedWallpaper,
                    backgroundBlur,
                    selectedImageUrl,
                    backgroundColorConfig,
                    padding,
                    roundedCorners,
                    shadows,
                    aspectRatio,
                    customDimensions,
                    cropArea,
                    mockupId,
                    mockupConfig,
                    canvasElements,
                    imageTransform: {
                        rotation: videoTransform.rotation,
                        translateX: videoTransform.translateX,
                        translateY: videoTransform.translateY,
                    },
                    imagePreview3D: imageTransform,
                    apply3DToBackground,
                    imageMaskConfig,
                }
            );

            if (project) {
                setImageUrl(project.imageDataUrl);
                setImageDimensions({ width: img.width, height: img.height });
            }
        } catch (error) {
            console.error("Failed to upload image:", error);
        }
    }, [
        createProject,
        backgroundTab,
        selectedWallpaper,
        backgroundBlur,
        selectedImageUrl,
        backgroundColorConfig,
        padding,
        roundedCorners,
        shadows,
        aspectRatio,
        customDimensions,
        cropArea,
        mockupId,
        mockupConfig,
        canvasElements,
        videoTransform,
        imageTransform,
        apply3DToBackground,
        imageMaskConfig,
    ]);

    // Handler for drag & drop images on canvas (photo mode only)
    const handleImageDrop = useCallback(async (files: FileList | File[]) => {
        if (!isPhotoMode) return;

        const fileArray = Array.from(files);
        const imageFile = fileArray.find(f => f.type.startsWith('image/'));

        if (imageFile) {
            await handleImageUploadToCanvas(imageFile);
        }
    }, [isPhotoMode, handleImageUploadToCanvas]);
    const selectCanvasElement = useCallback((id: string | null) => {
        setSelectedElementId(id);
        if (id) {
            setActiveTool("elements");
        }
    }, []);
    // Image export handler - using html-to-image with fixed dimensions
    const handleImageExport = useCallback(async (
        format: ImageExportFormat,
        quality: number,
        scale: number
    ) => {
        if (!canvasRef.current) return;

        try {
            setImageExportProgress({ status: "preparing", progress: 0, message: "Preparing export..." });

            const previewContainer = canvasRef.current.getPreviewContainer();
            if (!previewContainer || !imageUrl) {
                throw new Error("Preview container or image not available");
            }

            const imageElements = previewContainer.querySelectorAll('img');
            const originalSrcs = new Map<HTMLImageElement, string>();

            await Promise.all(Array.from(imageElements).map(async (img) => {
                const src = img.src;
                if (!src.startsWith('blob:') && !src.startsWith('data:')) return;

                try {
                    const response = await fetch(src);
                    const blob = await response.blob();
                    const base64 = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.onerror = reject;
                        reader.readAsDataURL(blob);
                    });
                    originalSrcs.set(img, src);
                    img.src = base64;
                    if (!img.complete) {
                        await new Promise<void>((resolve) => { img.onload = () => resolve(); });
                    }
                } catch (e) {
                    console.warn("Could not convert image src to base64:", src, e);
                }
            }));

            setImageExportProgress({ status: "rendering", progress: 50, message: "Rendering image..." });

            let exportWidth = 1920;
            let exportHeight = 1080;

            if ((aspectRatio === "auto" || aspectRatio === "custom") && customDimensions) {
                exportWidth = customDimensions.width;
                exportHeight = customDimensions.height;
            } else if (aspectRatio === "auto") {
                if (imageDimensions) {
                    exportWidth = imageDimensions.width;
                    exportHeight = imageDimensions.height;
                }
            } else {
                const dims = ASPECT_RATIO_DIMENSIONS[aspectRatio];
                if (dims) { exportWidth = dims.width; exportHeight = dims.height; }
            }

            exportWidth = Math.round(exportWidth * scale);
            exportHeight = Math.round(exportHeight * scale);

            const hasTransparentBackground = selectedWallpaper === -1;

            // Temporarily clear ALL selection indicators (single, multi, and mockup border)
            // so they don't appear in the html-to-image capture
            const prevSingleSelection = selectedElementId;
            selectCanvasElement(null);
            const prevSelectionState = canvasRef.current?.clearAllSelection?.();

            await new Promise(resolve => setTimeout(resolve, 80));

            const blob = await toBlob(previewContainer, {
                quality,
                cacheBust: false,
                ...(hasTransparentBackground ? {} : { backgroundColor: '#09090B' }),
                type: `image/${format}`,
                canvasWidth: exportWidth,
                canvasHeight: exportHeight,
                pixelRatio: 1,
            });

            // Restore all selection state after capture
            if (prevSingleSelection) selectCanvasElement(prevSingleSelection);
            if (prevSelectionState) canvasRef.current?.restoreSelectionState?.(prevSelectionState);

            originalSrcs.forEach((originalSrc, img) => {
                img.src = originalSrc;
            });

            if (!blob) throw new Error("Failed to generate image blob");

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = `openvidshot-${Date.now()}.${format}`;
            link.href = url;
            link.click();
            URL.revokeObjectURL(url);

            setImageExportProgress({ status: "complete", progress: 100, message: "Export complete!" });
            setTimeout(() => setImageExportProgress({ status: "idle", progress: 0, message: "" }), 2000);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            setImageExportProgress({ status: "error", progress: 0, message: `Export failed: ${errorMessage}` });
            setTimeout(() => setImageExportProgress({ status: "idle", progress: 0, message: "" }), 4000);
        }
    }, [imageUrl, imageDimensions, selectedWallpaper, aspectRatio, customDimensions, selectedElementId, selectCanvasElement]);
    // Generate canvas snapshot for photo mode previews
    useEffect(() => {
        if (!isPhotoMode || !imageUrl || !canvasRef.current) {
            setCanvasImageUrl(null);
            return;
        }

        const generateSnapshot = async () => {
            try {
                await canvasRef.current?.drawFrame();
                const exportCanvas = canvasRef.current?.getExportCanvas();
                if (exportCanvas) {
                    const dataUrl = exportCanvas.toDataURL("image/png", 0.8);
                    setCanvasImageUrl(dataUrl);
                }
            } catch (error) {
                console.error("Error generating canvas snapshot:", error);
            }
        };

        const initialTimeout = setTimeout(generateSnapshot, 300);

        return () => {
            clearTimeout(initialTimeout);
        };
    }, [isPhotoMode, imageUrl, backgroundTab, selectedWallpaper, backgroundBlur, padding, roundedCorners, shadows, selectedImageUrl, backgroundColorConfig]);

    // Handle 3D preview selection
    const handleSelectPreview = useCallback((config: Preview3DConfig) => {
        setSelectedPreviewId(config.id);
        setImageTransform(config);
    }, []);

    // Handle 3D background toggle
    const handleToggle3DBackground = useCallback((value: boolean) => {
        setApply3DToBackground(value);
    }, [setApply3DToBackground]);

    // Reset all photo editor visual settings to defaults
    const handleResetPhotoEditor = useCallback(() => {
        const frontConfig = PREVIEW_CONFIGS[0];
        setSelectedPreviewId(frontConfig.id);
        setImageTransform(frontConfig);
        setApply3DToBackground(false);
        setImageMaskConfig(DEFAULT_MASK_CONFIG);
        setVideoTransform({ rotation: 0, translateX: 0, translateY: 0 });
    }, []);

    // Videos library state
    const [newVideosCount, setNewVideosCount] = useState<number>(0);
    const [videosLibraryRefresh, setVideosLibraryRefresh] = useState<number>(0);

    // Video track clips state (multi-video support)
    const [videoClips, setVideoClips] = useState<VideoTrackClip[]>([]);
    // Computed from videoClips - array of library video IDs currently in track
    const videosInTrackIds = useMemo(() =>
        videoClips.map(clip => clip.libraryVideoId),
        [videoClips]);
    // Ref para acceder al valor actual de videoClips en callbacks (evitar closure stale)
    const videoClipsRef = useRef<VideoTrackClip[]>([]);
    useEffect(() => {
        videoClipsRef.current = videoClips;
    }, [videoClips]);
    const [selectedVideoClipId, setSelectedVideoClipId] = useState<string | null>(null);

    // Multi-video playback: store video blobs and URLs indexed by libraryVideoId
    const videoBlobsRef = useRef<Map<string, Blob>>(new Map());
    const videoUrlsRef = useRef<Map<string, string>>(new Map());
    const activeClipIdRef = useRef<string | null>(null);
    const activeClipDataRef = useRef<VideoTrackClip | null>(null);
    const clipAudioStateRef = useRef<Map<string, boolean>>(new Map());
    const muteOriginalAudioRef = useRef<boolean>(false);
    useEffect(() => {
        muteOriginalAudioRef.current = muteOriginalAudio;
    }, [muteOriginalAudio]);
    // Audio trim modal state
    const [autoTrimModalOpen, setAutoTrimModalOpen] = useState(false);
    const [pendingAudioUpload, setPendingAudioUpload] = useState<{
        audio: import("@/types/audio.types").UploadedAudio;
        trackId: string;
    } | null>(null);

    // Audio playback refs - store HTML Audio elements for each track
    const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

    // Initialize audio elements when tracks change
    useEffect(() => {
        const currentElements = audioElementsRef.current;
        const currentTrackIds = new Set(audioTracks.map(t => t.id));

        // Remove audio elements for deleted tracks
        for (const [trackId, audioEl] of currentElements.entries()) {
            if (!currentTrackIds.has(trackId)) {
                audioEl.pause();
                audioEl.src = '';
                currentElements.delete(trackId);
            }
        }

        // Create audio elements for new tracks
        for (const track of audioTracks) {
            if (!currentElements.has(track.id)) {
                const audio = uploadedAudios.find(a => a.id === track.audioId);
                if (audio) {
                    const audioEl = new Audio(audio.url);
                    audioEl.preload = 'auto';
                    audioEl.volume = track.volume * masterVolume;
                    currentElements.set(track.id, audioEl);
                }
            }
        }
    }, [audioTracks, uploadedAudios, masterVolume]);

    // Update audio volumes when master volume or track volumes change
    useEffect(() => {
        const currentElements = audioElementsRef.current;
        for (const track of audioTracks) {
            const audioEl = currentElements.get(track.id);
            if (audioEl) {
                audioEl.volume = track.volume * masterVolume;
            }
        }
    }, [audioTracks, masterVolume]);

    // Sync audio playback with video current time
    const syncAudioPlayback = useCallback((videoTime: number, playing: boolean) => {
        if (isExportingRef.current) return;
        const currentElements = audioElementsRef.current;

        for (const track of audioTracks) {
            const audioEl = currentElements.get(track.id);
            if (!audioEl) continue;

            const trackStart = track.startTime;
            const trackEnd = track.startTime + track.duration;
            const trimStart = track.trimStart ?? 0;

            if (videoTime >= trackStart && videoTime < trackEnd) {
                const audioTime = trimStart + (videoTime - trackStart);

                if (Math.abs(audioEl.currentTime - audioTime) > 0.1) {
                    audioEl.currentTime = audioTime;
                }

                if (playing && audioEl.paused) {
                    audioEl.play().catch(() => { });
                } else if (!playing && !audioEl.paused) {
                    audioEl.pause();
                }
            } else {
                if (!audioEl.paused) {
                    audioEl.pause();
                }
            }
        }
    }, [audioTracks]);

    useEffect(() => {
        const elementsRef = audioElementsRef.current;
        return () => {
            for (const audioEl of elementsRef.values()) {
                audioEl.pause();
                audioEl.src = '';
            }
            elementsRef.clear();
        };
    }, []);

    const updateEditorStateDebounced = useRef<NodeJS.Timeout | null>(null);
    useEffect(() => {
        if (updateEditorStateDebounced.current) {
            clearTimeout(updateEditorStateDebounced.current);
        }
        updateEditorStateDebounced.current = setTimeout(() => {
            setEditorState({
                backgroundTab,
                selectedWallpaper,
                backgroundBlur,
                padding,
                roundedCorners,
                shadows,
                selectedImageUrl,
                backgroundColorConfig,
                aspectRatio,
                customDimensions,
                cropArea,
                trimRange,
                zoomFragments,
                mockupId,
                mockupConfig,
                canvasElements,
                audioTracks,
                muteOriginalAudio,
                masterVolume,
                cameraConfig,
                videoTransform,
                imageTransform,
                apply3DToBackground,
                imageMaskConfig,
                videoMaskConfig,
                videoClips,
            });
        }, 300);
        return () => {
            if (updateEditorStateDebounced.current) {
                clearTimeout(updateEditorStateDebounced.current);
            }
        };
    }, [
        backgroundTab, selectedWallpaper, backgroundBlur, padding,
        roundedCorners, shadows, selectedImageUrl, backgroundColorConfig,
        aspectRatio, customDimensions, cropArea, trimRange,
        zoomFragments, mockupId, mockupConfig, canvasElements,
        audioTracks, muteOriginalAudio, masterVolume, cameraConfig,
        videoTransform, imageTransform, apply3DToBackground, imageMaskConfig, videoMaskConfig, videoClips,
        setEditorState
    ]);

    // Sync editorState → individual states (from undo/redo)
    useEffect(() => {
        setBackgroundTab(editorState.backgroundTab);
        setSelectedWallpaper(editorState.selectedWallpaper);
        setBackgroundBlur(editorState.backgroundBlur);
        setPadding(editorState.padding);
        setRoundedCorners(editorState.roundedCorners);
        setShadows(editorState.shadows);
        setSelectedImageUrl(editorState.selectedImageUrl);
        setBackgroundColorConfig(editorState.backgroundColorConfig);
        setAspectRatio(editorState.aspectRatio);
        setCustomDimensions(editorState.customDimensions);
        setCropArea(editorState.cropArea);
        setTrimRange(editorState.trimRange);
        setZoomFragments(editorState.zoomFragments);
        setMockupId(editorState.mockupId);
        setMockupConfig(editorState.mockupConfig);
        setCanvasElements(editorState.canvasElements);
        setAudioTracks(editorState.audioTracks);
        setMuteOriginalAudio(editorState.muteOriginalAudio);
        setMasterVolume(editorState.masterVolume);
        setCameraConfig(editorState.cameraConfig);
        setVideoTransform(editorState.videoTransform);
        setImageTransform(editorState.imageTransform);
        setApply3DToBackground(editorState.apply3DToBackground);
        setImageMaskConfig(editorState.imageMaskConfig);
        setVideoMaskConfig(editorState.videoMaskConfig);
        setVideoClips(editorState.videoClips);
    }, [editorState]);

    // Handler para cambiar el mockup
    const handleMockupChange = useCallback((newMockupId: string) => {
        setMockupId(newMockupId);
        const newMockup = MOCKUPS.find(m => m.id === newMockupId);
        setMockupConfig(getMockupDefaultConfig(newMockup));
    }, []);

    // Handler para cambiar la configuración del mockup
    const handleMockupConfigChange = useCallback((updates: Partial<MockupConfig>) => {
        setMockupConfig(prev => ({ ...prev, ...updates }));
    }, []);

    // Handler para cambiar las esquinas redondeadas (sincroniza ambos valores)
    const handleRoundedCornersChange = useCallback((value: number) => {
        setRoundedCorners(value); // Para NoneMockup y canvas general
        setMockupConfig(prev => ({ ...prev, cornerRadius: value }));
    }, []);

    // Text tool (Figma-style T key) — activates crosshair + canvas click to place text
    const [textToolActive, setTextToolActive] = useState(false);

    // Canvas elements handlers
    const addCanvasElement = useCallback((element: CanvasElement) => {
        setCanvasElements(prev => [...prev, element]);
        setSelectedElementId(element.id);
    }, []);

    const updateCanvasElement = useCallback((id: string, updates: Partial<CanvasElement>) => {
        setCanvasElements(prev => prev.map(el =>
            el.id === id ? { ...el, ...updates } as CanvasElement : el
        ));
    }, []);

    const deleteCanvasElement = useCallback((idOrIds: string | string[]) => {
        const idsToDelete = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
        const idsSet = new Set(idsToDelete);
        setCanvasElements(prev => prev.filter(el => !idsSet.has(el.id)));
        setSelectedElementId(prev => prev && idsSet.has(prev) ? null : prev);
    }, []);

    const [copiedElement, setCopiedElement] = useState<CanvasElement | null>(null);

    const copySelectedElement = useCallback(() => {
        if (!selectedElementId) return;
        const element = canvasElements.find(el => el.id === selectedElementId);
        if (element) {
            setCopiedElement(element);
        }
    }, [selectedElementId, canvasElements]);

    const pasteElement = useCallback(() => {
        if (!copiedElement) return;

        const newElement = {
            ...copiedElement,
            id: `${copiedElement.type}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            x: copiedElement.x + 5,
            y: copiedElement.y + 5,
            zIndex: VIDEO_Z_INDEX + 1,
        } as CanvasElement;

        setCanvasElements(prev => [...prev, newElement]);
        setSelectedElementId(newElement.id);
        setActiveTool("elements");
    }, [copiedElement]);

    const bringToFront = useCallback((id: string) => {
        // Get elements that are above the video (zIndex >= VIDEO_Z_INDEX)
        const aboveVideoElements = canvasElements.filter(el => el.zIndex >= VIDEO_Z_INDEX);
        const maxAboveVideo = aboveVideoElements.length > 0
            ? Math.max(...aboveVideoElements.map(el => el.zIndex))
            : VIDEO_Z_INDEX - 1;
        // Ensure the element goes above video and all other above-video elements
        updateCanvasElement(id, { zIndex: Math.max(maxAboveVideo + 1, VIDEO_Z_INDEX) });
    }, [canvasElements, updateCanvasElement]);

    const sendToBack = useCallback((id: string) => {
        const element = canvasElements.find(el => el.id === id);
        if (!element) return;

        // If element is above video (zIndex >= VIDEO_Z_INDEX), send it just behind video
        if (element.zIndex >= VIDEO_Z_INDEX) {
            const behindVideoElements = canvasElements.filter(el => el.zIndex < VIDEO_Z_INDEX);
            const minBehindVideo = behindVideoElements.length > 0
                ? Math.min(...behindVideoElements.map(el => el.zIndex))
                : VIDEO_Z_INDEX - 100;
            updateCanvasElement(id, { zIndex: Math.min(minBehindVideo - 1, VIDEO_Z_INDEX - 1) });
        } else {
            const behindVideoElements = canvasElements.filter(el => el.zIndex < VIDEO_Z_INDEX && el.id !== id);
            const minBehindVideo = behindVideoElements.length > 0
                ? Math.min(...behindVideoElements.map(el => el.zIndex))
                : element.zIndex;
            updateCanvasElement(id, { zIndex: minBehindVideo - 1 });
        }
    }, [canvasElements, updateCanvasElement]);

    // Audio handlers
    const handleAudioUpload = useCallback(async (file: File) => {
        try {
            const MAX_AUDIO_TRACKS = 5;
            if (audioTracks.length >= MAX_AUDIO_TRACKS) {
                alert(`Máximo ${MAX_AUDIO_TRACKS} pistas de audio permitidas.`);
                return;
            }

            const url = URL.createObjectURL(file);

            const audio = new Audio(url);
            await new Promise<void>((resolve, reject) => {
                audio.addEventListener('loadedmetadata', () => resolve());
                audio.addEventListener('error', () => reject(new Error('Failed to load audio')));
            });

            const newAudio: import("@/types/audio.types").UploadedAudio = {
                id: `audio-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                name: file.name,
                url,
                duration: audio.duration,
                fileSize: file.size,
                mimeType: file.type,
            };

            setUploadedAudios(prev => [...prev, newAudio]);

            const lastTrackEnd = audioTracks.reduce((max, track) =>
                Math.max(max, track.startTime + track.duration), 0);

            const trackId = `track-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

            if (audio.duration > videoDuration) {
                setPendingAudioUpload({ audio: newAudio, trackId });
                setAutoTrimModalOpen(true);
            } else {
                const newTrack: import("@/types/audio.types").AudioTrack = {
                    id: trackId,
                    audioId: newAudio.id,
                    name: newAudio.name,
                    startTime: lastTrackEnd,
                    duration: newAudio.duration,
                    volume: 1,
                    loop: false,
                };

                setAudioTracks(prev => [...prev, newTrack]);

                if (audioTracks.length === 0) {
                    setMuteOriginalAudio(true);
                }
            }
        } catch (error) {
            console.error('Error uploading audio:', error);
            alert('Error al subir el audio. Por favor intenta de nuevo.');
        }
    }, [audioTracks, videoDuration]);

    const handleAudioDelete = useCallback((audioId: string) => {
        setUploadedAudios(prev => {
            const audio = prev.find(a => a.id === audioId);
            if (audio) {
                URL.revokeObjectURL(audio.url);
            }
            return prev.filter(a => a.id !== audioId);
        });

        setAudioTracks(prev => prev.filter(track => track.audioId !== audioId));
    }, []);

    const handleAddAudioTrack = useCallback((audioId: string) => {
        const audio = uploadedAudios.find(a => a.id === audioId);
        if (!audio) return;

        const MAX_AUDIO_TRACKS = 5;
        if (audioTracks.length >= MAX_AUDIO_TRACKS) {
            alert(`Máximo ${MAX_AUDIO_TRACKS} pistas de audio permitidas.`);
            return;
        }

        if (audioTracks.some(track => track.audioId === audioId)) {
            return;
        }

        // Calculate startTime as end of last track to prevent overlapping
        const lastTrackEnd = audioTracks.reduce((max, track) =>
            Math.max(max, track.startTime + track.duration), 0);

        const newTrack: import("@/types/audio.types").AudioTrack = {
            id: `track-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            audioId,
            name: audio.name,
            startTime: lastTrackEnd,
            duration: audio.duration,
            volume: 1,
            loop: false,
        };

        setAudioTracks(prev => [...prev, newTrack]);
        if (audioTracks.length === 0) {
            setMuteOriginalAudio(true);
        }
    }, [uploadedAudios, audioTracks]);

    const handleUpdateAudioTrack = useCallback((trackId: string, updates: Partial<import("@/types/audio.types").AudioTrack>) => {
        setAudioTracks(prev => prev.map(track =>
            track.id === trackId ? { ...track, ...updates } : track
        ));
    }, []);

    const handleDeleteAudioTrack = useCallback((trackId: string) => {
        setAudioTracks(prev => {
            const remaining = prev.filter(track => track.id !== trackId);
            if (remaining.length === 0) {
                setMuteOriginalAudio(false);
            }
            return remaining;
        });
    }, []);

    const handleToggleMuteOriginalAudio = useCallback(() => {
        setMuteOriginalAudio(prev => !prev);
    }, []);

    const handleMasterVolumeChange = useCallback((volume: number) => {
        setMasterVolume(volume);
    }, []);

    const handleSelectAudioTrack = useCallback((trackId: string | null) => {
        setSelectedAudioTrackId(trackId);
        if (trackId) {
            setSelectedZoomFragmentId(null);
            setSelectedVideoClipId(null);
            setSelectedElementId(null);
            setActiveTool("audio");
        }
    }, []);

    const [thumbnailClipId, setThumbnailClipId] = useState<string | null>(null);

    const thumbnailsCacheRef = useRef<Map<string, VideoThumbnail[]>>(new Map());

    const currentDisplayTime = isDraggingPlayhead ? scrubTime : currentTime;
    useEffect(() => {
        if (videoClips.length <= 1) {
            setThumbnailClipId(null);
            return;
        }
        const clipAtTime = getClipAtTime(videoClips, currentDisplayTime);
        if (clipAtTime) {
            setThumbnailClipId(prev => {
                if (prev !== clipAtTime.libraryVideoId) {
                    return clipAtTime.libraryVideoId;
                }
                return prev;
            });
        }
    }, [currentDisplayTime, videoClips]);

    const thumbnailUrl = useMemo(() => {
        if (videoClips.length <= 1 || !thumbnailClipId) return videoUrl;
        return videoUrlsRef.current.get(thumbnailClipId) || videoUrl;
    }, [videoUrl, videoClips.length, thumbnailClipId]);

    const thumbnailVideoId = useMemo(() => {
        if (videoClips.length <= 1 || !thumbnailClipId) return videoId;
        return thumbnailClipId;
    }, [videoId, videoClips.length, thumbnailClipId]);

    const thumbnailDuration = useMemo(() => {
        if (videoClips.length <= 1 || !thumbnailClipId) return videoDuration;
        const clip = videoClips.find(c => c.libraryVideoId === thumbnailClipId);
        return clip?.duration || videoDuration;
    }, [videoDuration, videoClips, thumbnailClipId]);

    const { getThumbnailForTime: getRawThumbnailForTime, thumbnails: currentThumbnails } = useVideoThumbnails(
        thumbnailUrl,
        thumbnailDuration,
        {
            interval: 0.1,
            quality: "high",
            videoId: thumbnailVideoId || undefined,
        }
    );

    useEffect(() => {
        if (thumbnailVideoId && currentThumbnails.length > 0) {
            thumbnailsCacheRef.current.set(thumbnailVideoId, currentThumbnails);
        }
    }, [thumbnailVideoId, currentThumbnails]);

    const findNearestThumbnail = useCallback((thumbs: VideoThumbnail[], time: number): VideoThumbnail | null => {
        if (thumbs.length === 0) return null;
        let left = 0;
        let right = thumbs.length - 1;
        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (thumbs[mid].time < time) left = mid + 1;
            else right = mid;
        }
        if (left > 0) {
            const prevDiff = Math.abs(thumbs[left - 1].time - time);
            const currDiff = Math.abs(thumbs[left].time - time);
            if (prevDiff < currDiff) return thumbs[left - 1];
        }
        return thumbs[left];
    }, []);

    // Clip-aware getThumbnailForTime: looks up any clip's thumbnails from cache
    const getThumbnailForTime = useCallback((timelineTime: number) => {
        const clips = videoClipsRef.current;
        if (clips.length <= 1) {
            return getRawThumbnailForTime(timelineTime);
        }

        const clipAtTime = getClipAtTime(clips, timelineTime);
        if (!clipAtTime) return null;

        const localTime = clipAtTime.trimStart + (timelineTime - clipAtTime.startTime);

        // If this is the currently generating clip, use the hook directly (most up-to-date)
        if (clipAtTime.libraryVideoId === thumbnailVideoId) {
            return getRawThumbnailForTime(localTime);
        }

        // Otherwise, check the persistent cache
        const cached = thumbnailsCacheRef.current.get(clipAtTime.libraryVideoId);
        if (cached && cached.length > 0) {
            return findNearestThumbnail(cached, localTime);
        }

        return null;
    }, [getRawThumbnailForTime, thumbnailVideoId, findNearestThumbnail]);

    // Find which clip is active at a given timeline time - using standardized function
    const findActiveClipAtTime = useCallback((timelineTime: number): VideoTrackClip | null => {
        const clips = videoClipsRef.current;
        return getClipAtTime(clips, timelineTime);
    }, []);

    // Convert timeline time to clip-local time
    const timelineToClipTime = useCallback((timelineTime: number, clip: VideoTrackClip): number => {
        const offsetInClip = timelineTime - clip.startTime;
        return clip.trimStart + offsetInClip;
    }, []);

    // Pre-load video blobs when clips change
    useEffect(() => {
        const loadClipBlobs = async () => {
            const currentBlobs = videoBlobsRef.current;
            const currentUrls = videoUrlsRef.current;
            const neededIds = new Set(videoClips.map(c => c.libraryVideoId));

            for (const [id, url] of currentUrls.entries()) {
                if (!neededIds.has(id)) {
                    URL.revokeObjectURL(url);
                    currentUrls.delete(id);
                    currentBlobs.delete(id);
                }
            }

            for (const clip of videoClips) {
                if (!currentBlobs.has(clip.libraryVideoId)) {
                    try {
                        const libraryVideo = await getLibraryVideo(clip.libraryVideoId);
                        if (libraryVideo) {
                            currentBlobs.set(clip.libraryVideoId, libraryVideo.blob);
                            const url = URL.createObjectURL(libraryVideo.blob);
                            currentUrls.set(clip.libraryVideoId, url);
                        }
                    } catch (e) {
                        console.warn("Failed to load video blob for clip:", clip.id, e);
                    }
                }
            }
        };

        if (videoClips.length > 0) {
            loadClipBlobs();
        }
    }, [videoClips]);

    const { exportVideo, cancelExport, exportProgress } = useVideoExport(videoRef, canvasRef);
    const { uploadVideo, loadUploadedVideo, isUploading } = useVideoUpload();
    const [videoBlob, setVideoBlob] = useState<Blob | null>(null);

    const handleExport = (quality: ExportQuality) => {
        isExportingRef.current = true;
        for (const audioEl of audioElementsRef.current.values()) {
            audioEl.pause();
        }

        exportVideo({
            quality,
            videoBlob: videoBlob ?? undefined,
            transparentBackground: selectedWallpaper === -1,
            trim: trimRange.end > trimRange.start ? { start: trimRange.start, end: trimRange.end } : undefined,
            muteOriginalAudio,
            videoHasAudioTrack: videoHasAudioTrack,
            audioTracks: audioTracks.map(track => {
                const audio = uploadedAudios.find(a => a.id === track.audioId);
                return {
                    audioUrl: audio?.url || '',
                    startTime: track.startTime,
                    duration: track.duration,
                    trimStart: track.trimStart ?? 0,
                    volume: track.volume,
                    loop: track.loop,
                };
            }),
            masterVolume,
            videoClips: videoClips.length > 0 ? videoClips : undefined,
            videoClipBlobs: videoClips.length > 1 ? videoBlobsRef.current : undefined,
            clipAudioStates: Object.fromEntries(clipAudioStateRef.current),
        }).finally(() => {
        });
    };

    // Handler para subir video (desde ToolsSidebar)
    const handleVideoUpload = useCallback(async (file: File) => {
        const hasExistingClips = videoClipsRef.current.length > 0;

        // Add video to library first
        let libraryVideo: Awaited<ReturnType<typeof addVideoToLibrary>> | null = null;
        try {
            libraryVideo = await addVideoToLibrary(file, { projectId: activeProjectId });
            if (activeProjectId) {
                const asset = await createProjectAsset(activeProjectId, {
                    type: "video",
                    file,
                    fileName: file.name,
                    duration: libraryVideo.duration,
                    width: libraryVideo.width,
                    height: libraryVideo.height,
                });
                libraryVideo = await updateLibraryVideoCloudLink(libraryVideo.id, {
                    projectId: activeProjectId,
                    cloudAssetId: asset.id,
                    storagePath: asset.storagePath,
                }) ?? { ...libraryVideo, cloudAssetId: asset.id, storagePath: asset.storagePath, projectId: activeProjectId };
            }
            const count = await getLibraryVideoCount();
            setNewVideosCount(hasExistingClips ? count : 0);
            setVideosLibraryRefresh(prev => prev + 1);
        } catch (error) {
            console.warn("Failed to add video to library:", error);
            return;
        }

        if (hasExistingClips) {
            setActiveTool("videos");
            return;
        }

        // First video - add to track
        for (const [, url] of videoUrlsRef.current.entries()) {
            URL.revokeObjectURL(url);
        }
        videoBlobsRef.current.clear();
        videoUrlsRef.current.clear();
        activeClipIdRef.current = null;
        activeClipDataRef.current = null;
        setVideoBlob(file);
        if (libraryVideo) {
            const originalHasAudio = libraryVideo.originalHasAudio !== false;
            setVideoHasAudioTrack(originalHasAudio);
            if (!originalHasAudio) setMuteOriginalAudio(true);
            clipAudioStateRef.current.set(libraryVideo.id, libraryVideo.hasAudio !== false);
        }

        try {
            await clearAllThumbnailCache();
        } catch (error) {
            console.warn("Failed to clear thumbnails:", error);
        }

        const uploadedData = await uploadVideo(file);
        if (uploadedData && libraryVideo) {
            lastLoadedVideoIdRef.current = uploadedData.videoId;

            setVideoUrl(uploadedData.url);
            setVideoId(uploadedData.videoId);
            setVideoDuration(uploadedData.duration);
            setTrimRange({ start: 0, end: uploadedData.duration });
            setAspectRatio(uploadedData.aspectRatio);
            setVideoDimensions({ width: uploadedData.width, height: uploadedData.height });

            const newClip: VideoTrackClip = {
                id: crypto.randomUUID(),
                libraryVideoId: libraryVideo.id,
                cloudAssetId: libraryVideo.cloudAssetId ?? null,
                name: file.name,
                startTime: 0,
                duration: uploadedData.duration,
                trimStart: 0,
                trimEnd: uploadedData.duration,
                thumbnailUrl: libraryVideo.thumbnailUrl,
            };
            clipAudioStateRef.current.set(libraryVideo.id, libraryVideo.hasAudio !== false);
            activeClipIdRef.current = newClip.id;
            activeClipDataRef.current = newClip;
            setVideoClips([newClip]);
            setSelectedVideoClipId(newClip.id);

            const defaultFragments = generateDefaultZoomFragments(uploadedData.duration);
            setZoomFragments(defaultFragments);

            setCurrentTime(0, true);
            setIsPlaying(false);
            setTimeout(() => clearHistory(), 200);
        }
    }, [activeProjectId, uploadVideo, clearHistory, setCurrentTime]);

    // Handler para subir video solo a la librería (desde VideosMenu)
    const handleVideoUploadToLibrary = useCallback(async (file: File) => {
        try {
            let libraryVideo = await addVideoToLibrary(file, { projectId: activeProjectId });
            if (activeProjectId) {
                const asset = await createProjectAsset(activeProjectId, {
                    type: "video",
                    file,
                    fileName: file.name,
                    duration: libraryVideo.duration,
                    width: libraryVideo.width,
                    height: libraryVideo.height,
                });
                libraryVideo = await updateLibraryVideoCloudLink(libraryVideo.id, {
                    projectId: activeProjectId,
                    cloudAssetId: asset.id,
                    storagePath: asset.storagePath,
                }) ?? libraryVideo;
            }
            const count = await getLibraryVideoCount();
            setNewVideosCount(count);
            setVideosLibraryRefresh(prev => prev + 1);
        } catch (error) {
            console.warn("Failed to add video to library:", error);
        }
    }, [activeProjectId]);

    // Handler para agregar video desde la librería al track (concatenar)
    const handleAddVideoToTrack = useCallback(async (videoId: string, blob: Blob, duration: number) => {
        // Get video info from library
        const libraryVideo = await import("@/lib/videos-library").then(m => m.getLibraryVideo(videoId));
        if (!libraryVideo) return;

        // Cache the per-clip audio state (hasAudio defaults to true if undefined)
        clipAudioStateRef.current.set(videoId, libraryVideo.hasAudio !== false);

        // Store blob in ref for multi-video playback
        if (!videoBlobsRef.current.has(videoId)) {
            videoBlobsRef.current.set(videoId, blob);
            const blobUrl = URL.createObjectURL(blob);
            videoUrlsRef.current.set(videoId, blobUrl);
        }

        // Usar functional update para tener siempre el estado más reciente
        setVideoClips(prevClips => {
            const startTime = findNextClipPosition(prevClips);

            const newClip: VideoTrackClip = {
                id: crypto.randomUUID(),
                libraryVideoId: videoId,
                cloudAssetId: libraryVideo.cloudAssetId ?? null,
                name: libraryVideo.fileName,
                startTime,
                duration,
                trimStart: 0,
                trimEnd: duration,
                thumbnailUrl: libraryVideo.thumbnailUrl,
            };

            const updatedClips = [...prevClips, newClip];

            setTimeout(() => {
                const newTotalDuration = calculateTotalDuration(updatedClips);
                setVideoDuration(newTotalDuration);
                setTrimRange({ start: 0, end: newTotalDuration });

                if (prevClips.length === 0) {
                    activeClipIdRef.current = newClip.id;
                    activeClipDataRef.current = newClip;
                    const url = videoUrlsRef.current.get(videoId) || URL.createObjectURL(blob);
                    setVideoBlob(blob);
                    setVideoUrl(url);
                    setVideoId(videoId);

                    const video = document.createElement('video');
                    video.preload = 'metadata';
                    const metadataUrl = URL.createObjectURL(blob);
                    video.onloadedmetadata = () => {
                        setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
                        setAspectRatio("auto");
                        URL.revokeObjectURL(metadataUrl);
                    };
                    video.src = metadataUrl;

                    const defaultFragments = generateDefaultZoomFragments(duration);
                    setZoomFragments(defaultFragments);

                    setCurrentTime(0, true);
                    setIsPlaying(false);
                }

                setNewVideosCount(0);
                clearHistory();
            }, 0);

            return updatedClips;
        });
    }, [clearHistory, setCurrentTime]);

    // Handlers for video clip management
    const handleSelectVideoClip = useCallback((clipId: string | null) => {
        setSelectedVideoClipId(clipId);
        // Clear other selections when selecting video clip (mutual exclusivity)
        if (clipId) {
            setSelectedZoomFragmentId(null);
            setSelectedAudioTrackId(null);
            setSelectedElementId(null);
            setActiveTool("videos");
        }
    }, []);

    const handleUpdateVideoClip = useCallback((clipId: string, updates: Partial<VideoTrackClip>) => {
        setVideoClips(prev => {
            const newClips = prev.map(clip =>
                clip.id === clipId ? { ...clip, ...updates } : clip
            );
            if (updates.startTime !== undefined || updates.trimEnd !== undefined || updates.trimStart !== undefined) {
                const newDuration = calculateTotalDuration(newClips);
                setVideoDuration(newDuration);
                setTrimRange({ start: 0, end: newDuration });
            }
            return newClips;
        });
    }, []);

    const handleDeleteVideoClip = useCallback((clipId: string) => {
        setVideoClips(prev => {
            const newClips = prev.filter(clip => clip.id !== clipId);
            if (newClips.length > 0) {
                const newDuration = calculateTotalDuration(newClips);
                setVideoDuration(newDuration);
                setTrimRange({ start: 0, end: newDuration });

                if (activeClipIdRef.current === clipId) {
                    const firstClip = [...newClips].sort((a, b) => a.startTime - b.startTime)[0];
                    activeClipIdRef.current = firstClip.id;
                    activeClipDataRef.current = firstClip;
                    const url = videoUrlsRef.current.get(firstClip.libraryVideoId);
                    if (url && videoRef.current) {
                        videoRef.current.src = url;
                        videoRef.current.currentTime = firstClip.trimStart;
                    }
                    setCurrentTime(firstClip.startTime, true);
                }
            } else {
                setVideoUrl(null);
                setVideoId(null);
                setVideoDuration(0);
                setTrimRange({ start: 0, end: 0 });
                activeClipIdRef.current = null;
                activeClipDataRef.current = null;
                if (videoRef.current) {
                    videoRef.current.removeAttribute('src');
                }
            }
            return newClips;
        });
        if (selectedVideoClipId === clipId) {
            setSelectedVideoClipId(null);
        }
    }, [selectedVideoClipId, setCurrentTime]);

    // Handler para eliminar video de track cuando se elimina de la librería (cascade delete)
    const handleDeleteVideoFromLibrary = useCallback((libraryVideoId: string) => {
        setVideoClips(prev => {
            const newClips = prev.filter(clip => clip.libraryVideoId !== libraryVideoId);
            if (newClips.length > 0) {
                const newDuration = calculateTotalDuration(newClips);
                setVideoDuration(newDuration);
                setTrimRange({ start: 0, end: newDuration });
            } else {
                setVideoUrl(null);
                setVideoId(null);
                setVideoDuration(0);
                setTrimRange({ start: 0, end: 0 });
                activeClipIdRef.current = null;
                activeClipDataRef.current = null;
                if (videoRef.current) {
                    videoRef.current.removeAttribute('src');
                    videoRef.current.load();
                }
                lastLoadedVideoIdRef.current = null;
                deleteRecordedVideo().catch(() => { });
                deleteUploadedVideo().catch(() => { });
            }
            return newClips;
        });
        // Clean up blob/URL refs
        if (videoBlobsRef.current.has(libraryVideoId)) {
            videoBlobsRef.current.delete(libraryVideoId);
        }
        if (videoUrlsRef.current.has(libraryVideoId)) {
            const url = videoUrlsRef.current.get(libraryVideoId);
            if (url) URL.revokeObjectURL(url);
            videoUrlsRef.current.delete(libraryVideoId);
        }
    }, []);

    // Handler for per-clip audio toggle from VideosMenu
    const handleVideoAudioToggle = useCallback((videoId: string, hasAudio: boolean) => {
        clipAudioStateRef.current.set(videoId, hasAudio);

        const activeClip = activeClipDataRef.current;
        if (activeClip && activeClip.libraryVideoId === videoId && videoRef.current) {
            videoRef.current.muted = muteOriginalAudioRef.current || !hasAudio;
        }
    }, []);

    // Handler para quitar video del track (toggle) - solo remueve el clip, no la librería
    const handleRemoveVideoFromTrack = useCallback((libraryVideoId: string) => {
        setVideoClips(prev => {
            const newClips = prev.filter(clip => clip.libraryVideoId !== libraryVideoId);
            if (newClips.length > 0) {
                const newDuration = calculateTotalDuration(newClips);
                setVideoDuration(newDuration);
                setTrimRange({ start: 0, end: newDuration });
                const currentActiveId = activeClipIdRef.current;
                if (currentActiveId && !newClips.find(c => c.id === currentActiveId)) {
                    activeClipIdRef.current = newClips[0].id;
                }
            } else {
                setVideoUrl(null);
                setVideoId(null);
                setVideoDuration(0);
                setTrimRange({ start: 0, end: 0 });
                activeClipIdRef.current = null;
                activeClipDataRef.current = null;
            }
            return newClips;
        });
    }, []);

    useEffect(() => {
        if (activeTool === "videos") {
            setNewVideosCount(0);
        }
    }, [activeTool]);

    const lastLoadedVideoIdRef = useRef<string | null>(null);

    const resetProjectMediaState = useCallback(() => {
        for (const [, url] of videoUrlsRef.current.entries()) {
            URL.revokeObjectURL(url);
        }

        videoBlobsRef.current.clear();
        videoUrlsRef.current.clear();
        clipAudioStateRef.current.clear();
        activeClipIdRef.current = null;
        activeClipDataRef.current = null;
        lastLoadedVideoIdRef.current = null;

        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.removeAttribute("src");
            videoRef.current.load();
        }

        setIsPlaying(false);
        setVideoBlob(null);
        setVideoUrl(null);
        setVideoId(null);
        setVideoDuration(0);
        setVideoDimensions(null);
        setVideoHasAudioTrack(true);
        setVideoClips([]);
        setSelectedVideoClipId(null);
        setTrimRange({ start: 0, end: 0 });
        setZoomFragments([]);
        setCameraUrl(null);
        setCameraConfig(null);
        setIsRecordedVideo(false);
        setCurrentTime(0, true);
        setScrubTime(0);
    }, [setCurrentTime]);

    const restoreProjectClips = useCallback(async (storedClips: VideoTrackClip[]) => {
        if (!activeProjectId || storedClips.length === 0) {
            resetProjectMediaState();
            return;
        }

        const assets = await listProjectAssets(activeProjectId);
        const videoAssets = assets.filter((asset) => asset.type === "video");
        const localByCloudAssetId = new Map<string, NonNullable<Awaited<ReturnType<typeof getLibraryVideo>>>>();

        for (const asset of videoAssets) {
            let localVideo = await findExistingCloudVideo(asset.id);
            if (!localVideo) {
                const blob = await downloadProjectAsset(asset);
                localVideo = await addVideoToLibraryWithMetadata({
                    blob,
                    fileName: asset.fileName,
                    duration: asset.duration ?? 0,
                    width: asset.width ?? 1920,
                    height: asset.height ?? 1080,
                    projectId: activeProjectId,
                    cloudAssetId: asset.id,
                    storagePath: asset.storagePath,
                });
            }
            localByCloudAssetId.set(asset.id, localVideo);
            videoBlobsRef.current.set(localVideo.id, localVideo.blob);
            videoUrlsRef.current.set(localVideo.id, URL.createObjectURL(localVideo.blob));
            clipAudioStateRef.current.set(localVideo.id, localVideo.hasAudio !== false);
        }

        const remappedClips: VideoTrackClip[] = [];
        for (const clip of storedClips) {
                const cloudAssetId = clip.cloudAssetId ?? null;
                const localVideo = cloudAssetId ? localByCloudAssetId.get(cloudAssetId) : null;
                if (!localVideo) continue;
                remappedClips.push({
                    ...clip,
                    libraryVideoId: localVideo.id,
                    cloudAssetId,
                    thumbnailUrl: localVideo.thumbnailUrl,
                });
        }

        setVideoClips(remappedClips);
        setVideosLibraryRefresh((prev) => prev + 1);

        if (remappedClips.length > 0) {
            const firstClip = [...remappedClips].sort((a, b) => a.startTime - b.startTime)[0];
            const localVideo = await getLibraryVideo(firstClip.libraryVideoId);
            const url = videoUrlsRef.current.get(firstClip.libraryVideoId);
            if (localVideo && url) {
                const totalDuration = calculateTotalDuration(remappedClips);
                activeClipIdRef.current = firstClip.id;
                activeClipDataRef.current = firstClip;
                setVideoBlob(localVideo.blob);
                setVideoUrl(url);
                setVideoId(localVideo.id);
                setVideoHasAudioTrack(localVideo.originalHasAudio !== false);
                setVideoDuration(totalDuration);
                setVideoDimensions({ width: localVideo.width, height: localVideo.height });
                setTrimRange({ start: 0, end: totalDuration });
            }
        }
    }, [activeProjectId, resetProjectMediaState]);

    const refreshCloudProjects = useCallback(async () => {
        if (!activeProjectId) return;

        setIsCloudProjectsLoading(true);
        try {
            setCloudProjects(await listProjects());
        } catch (error) {
            console.warn("Failed to load cloud projects:", error);
        } finally {
            setIsCloudProjectsLoading(false);
        }
    }, [activeProjectId]);

    const handleSelectCloudProject = useCallback((projectId: string) => {
        if (projectId === activeProjectId) return;
        router.push(`/editor?projectId=${projectId}`);
    }, [activeProjectId, router]);

    const handleCreateCloudProject = useCallback(async () => {
        try {
            const project = await createCloudProject("Untitled project");
            router.push(`/editor?projectId=${project.id}`);
        } catch (error) {
            setCloudProjectError(error instanceof Error ? error.message : "Could not create project");
        }
    }, [router]);

    const handleRenameCloudProject = useCallback(async (title: string) => {
        if (!activeProjectId) return;

        const nextTitle = title.trim() || "Untitled project";
        setCloudProjectTitle(nextTitle);

        try {
            const project = await updateProject(activeProjectId, { title: nextTitle });
            setCloudProjectTitle(project.title);
            setCloudProjects((prev) => prev.map((item) => (
                item.id === project.id ? project : item
            )));
        } catch (error) {
            setCloudProjectError(error instanceof Error ? error.message : "Could not rename project");
        }
    }, [activeProjectId]);

    useEffect(() => {
        if (!activeProjectId) {
            if (isVideoMode) router.replace("/projects");
            return;
        }

        let cancelled = false;

        const loadCloudProject = async () => {
            setIsCloudProjectLoading(true);
            setCloudProjectError(null);
            restoringCloudProjectRef.current = true;
            resetProjectMediaState();

            try {
                const project = await getProject(activeProjectId);
                if (!project) {
                    router.replace("/projects");
                    return;
                }
                if (cancelled) return;

                const state = project.editorState;
                setCloudProjectTitle(project.title);
                setBackgroundTab(state.backgroundTab ?? "wallpaper");
                setSelectedWallpaper(state.selectedWallpaper ?? 0);
                setBackgroundBlur(state.backgroundBlur ?? 0);
                setPadding(state.padding ?? 10);
                setRoundedCorners(state.roundedCorners ?? 10);
                setShadows(state.shadows ?? 10);
                setSelectedImageUrl(state.selectedImageUrl ?? "");
                setBackgroundColorConfig(state.backgroundColorConfig ?? null);
                setAspectRatio(state.aspectRatio ?? "auto");
                setCustomDimensions(state.customDimensions ?? null);
                setCropArea(state.cropArea);
                setTrimRange(state.trimRange ?? { start: 0, end: 0 });
                setZoomFragments(state.zoomFragments ?? []);
                setMockupId(state.mockupId ?? "none");
                setMockupConfig(state.mockupConfig ?? DEFAULT_MOCKUP_CONFIG);
                setCanvasElements(state.canvasElements ?? []);
                setAudioTracks(state.audioTracks ?? []);
                setMuteOriginalAudio(state.muteOriginalAudio ?? false);
                setMasterVolume(state.masterVolume ?? 1);
                setCameraConfig(state.cameraConfig ?? null);
                setVideoTransform(state.videoTransform ?? { rotation: 0, translateX: 0, translateY: 0 });
                setImageTransform(state.imageTransform ?? PREVIEW_CONFIGS[0]);
                setApply3DToBackground(state.apply3DToBackground ?? false);
                setImageMaskConfig(state.imageMaskConfig ?? DEFAULT_MASK_CONFIG);
                setVideoMaskConfig(state.videoMaskConfig ?? DEFAULT_MASK_CONFIG);

                await restoreProjectClips(state.videoClips ?? []);
                setTimeout(() => clearHistory(), 200);
            } catch (error) {
                if (!cancelled) {
                    setCloudProjectError(error instanceof Error ? error.message : "Could not load project");
                }
            } finally {
                if (!cancelled) {
                    setIsCloudProjectLoading(false);
                    restoringCloudProjectRef.current = false;
                }
            }
        };

        loadCloudProject();

        return () => {
            cancelled = true;
        };
    }, [activeProjectId, clearHistory, isVideoMode, resetProjectMediaState, restoreProjectClips, router]);

    useEffect(() => {
        refreshCloudProjects();
    }, [refreshCloudProjects]);

    useEffect(() => {
        if (!activeProjectId || !isVideoMode) return;

        let cancelled = false;

        const ingestPendingRecording = async () => {
            try {
                const recordedData = await loadVideoFromIndexedDB();
                if (!recordedData?.blob || recordedData.blob.size === 0) return;
                if (lastLoadedVideoIdRef.current === recordedData.videoId) return;

                lastLoadedVideoIdRef.current = recordedData.videoId;

                const fileName = `Recording-${recordedData.videoId}.webm`;
                let libraryVideo = await addVideoToLibraryWithMetadata({
                    blob: recordedData.blob,
                    fileName,
                    duration: recordedData.duration,
                    width: 1920,
                    height: 1080,
                    projectId: activeProjectId,
                });

                const asset = await createProjectAsset(activeProjectId, {
                    type: "video",
                    file: recordedData.blob,
                    fileName,
                    duration: recordedData.duration,
                    width: 1920,
                    height: 1080,
                });

                libraryVideo = await updateLibraryVideoCloudLink(libraryVideo.id, {
                    projectId: activeProjectId,
                    cloudAssetId: asset.id,
                    storagePath: asset.storagePath,
                }) ?? { ...libraryVideo, projectId: activeProjectId, cloudAssetId: asset.id, storagePath: asset.storagePath };

                if (cancelled) return;

                const url = URL.createObjectURL(recordedData.blob);
                videoBlobsRef.current.set(libraryVideo.id, recordedData.blob);
                videoUrlsRef.current.set(libraryVideo.id, url);
                clipAudioStateRef.current.set(libraryVideo.id, libraryVideo.hasAudio !== false);

                setVideoBlob(recordedData.blob);
                setVideoUrl(url);
                setVideoId(libraryVideo.id);
                setVideoDuration(recordedData.duration);
                setTrimRange({ start: 0, end: recordedData.duration });
                setVideoDimensions({ width: libraryVideo.width, height: libraryVideo.height });
                setVideoHasAudioTrack(libraryVideo.originalHasAudio !== false);

                const newClip: VideoTrackClip = {
                    id: crypto.randomUUID(),
                    libraryVideoId: libraryVideo.id,
                    cloudAssetId: asset.id,
                    name: libraryVideo.fileName,
                    startTime: 0,
                    duration: recordedData.duration,
                    trimStart: 0,
                    trimEnd: recordedData.duration,
                    thumbnailUrl: libraryVideo.thumbnailUrl,
                    hasCamera: !!recordedData.cameraUrl,
                };

                activeClipIdRef.current = newClip.id;
                activeClipDataRef.current = newClip;
                setVideoClips([newClip]);
                setSelectedVideoClipId(newClip.id);
                setZoomFragments(generateDefaultZoomFragments(recordedData.duration));
                setCurrentTime(0, true);
                setIsRecordedVideo(Boolean(recordedData.isRecordedVideo));
                setCameraUrl(recordedData.cameraUrl ?? null);
                setCameraConfig(recordedData.cameraConfig ?? null);
                setVideosLibraryRefresh((prev) => prev + 1);
                await deleteRecordedVideo();
                setTimeout(() => clearHistory(), 200);
            } catch (error) {
                console.error("Error ingesting project recording:", error);
                setCloudProjectError(error instanceof Error ? error.message : "Could not attach recording to project");
            }
        };

        ingestPendingRecording();

        return () => {
            cancelled = true;
        };
    }, [activeProjectId, clearHistory, isVideoMode, setCurrentTime]);

    // Load image from cache when in photo mode and create project if not exists
    useEffect(() => {
        if (!isPhotoMode) return;
        if (currentProject) return;
        if (isLoadingFromCacheRef.current) return;
        isLoadingFromCacheRef.current = true;

        const loadImage = async () => {
            try {
                const cachedImage = await getUploadedImage();
                if (cachedImage) {
                    await deleteUploadedImage();

                    const blob = cachedImage.blob;
                    const img = await createImageBitmap(blob);

                    const project = await createProject(
                        blob,
                        cachedImage.fileName || "Uploaded Image",
                        img.width,
                        img.height
                    );

                    if (project) {
                        setImageUrl(project.imageDataUrl);
                        setImageDimensions({ width: img.width, height: img.height });
                    }
                }
            } catch (error) {
                console.error("Error loading image from cache:", error);
            } finally {
                isLoadingFromCacheRef.current = false;
            }
        };

        loadImage();
    }, [isPhotoMode, currentProject, createProject]);

    useEffect(() => {
        if (activeProjectId) return;
        const loadVideo = async () => {
            try {
                const [uploadedData, recordedData, cachedUpload] = await Promise.all([
                    loadUploadedVideo(),
                    loadVideoFromIndexedDB(),
                    getUploadedVideo(),
                ]);

                let videoToLoad: typeof uploadedData | typeof recordedData = null;
                let videoBlob: Blob | null = null;

                if (uploadedData && recordedData) {
                    videoToLoad = uploadedData.timestamp > recordedData.timestamp ? uploadedData : recordedData;
                    if (uploadedData.timestamp > recordedData.timestamp && cachedUpload) {
                        videoBlob = cachedUpload.blob;
                    } else if ('blob' in recordedData && recordedData.blob) {
                        videoBlob = recordedData.blob;
                    }
                } else if (uploadedData) {
                    videoToLoad = uploadedData;
                    if (cachedUpload) {
                        videoBlob = cachedUpload.blob;
                    }
                } else if (recordedData) {
                    videoToLoad = recordedData;
                    if ('blob' in recordedData && recordedData.blob) {
                        videoBlob = recordedData.blob;
                    }
                }

                if (videoToLoad) {
                    if (lastLoadedVideoIdRef.current !== videoToLoad.videoId && videoClipsRef.current.length === 0) {
                        lastLoadedVideoIdRef.current = videoToLoad.videoId;

                        setVideoUrl(videoToLoad.url);
                        setVideoId(videoToLoad.videoId);
                        if (videoRef.current) {
                            videoRef.current.src = videoToLoad.url;
                        }
                        setVideoDuration(videoToLoad.duration);
                        setTrimRange({ start: 0, end: videoToLoad.duration });
                        const defaultFragments = generateDefaultZoomFragments(videoToLoad.duration);
                        setZoomFragments(defaultFragments);

                        if ('aspectRatio' in videoToLoad) {
                            setAspectRatio(videoToLoad.aspectRatio || "auto");
                            if (videoToLoad.width && videoToLoad.height) {
                                setVideoDimensions({ width: videoToLoad.width, height: videoToLoad.height });
                            }
                        }

                        if (videoBlob && videoBlob.size > 0) {
                            setVideoBlob(videoBlob);

                            const fileName = 'fileName' in videoToLoad
                                ? (videoToLoad.fileName as string)
                                : `Recording-${videoToLoad.videoId}.webm`;
                            const width = 'width' in videoToLoad ? (videoToLoad.width as number) : 1920;
                            const height = 'height' in videoToLoad ? (videoToLoad.height as number) : 1080;

                            try {
                                let libraryVideo = await findExistingVideo(fileName, videoBlob.size);

                                if (!libraryVideo) {
                                    libraryVideo = await addVideoToLibraryWithMetadata({
                                        blob: videoBlob,
                                        fileName,
                                        duration: videoToLoad.duration,
                                        width,
                                        height,
                                    });
                                }

                                videoBlobsRef.current.set(libraryVideo.id, videoBlob);
                                videoUrlsRef.current.set(libraryVideo.id, videoToLoad.url);
                                const originalHasAudio = libraryVideo.originalHasAudio !== false;
                                clipAudioStateRef.current.set(libraryVideo.id, libraryVideo.hasAudio !== false);
                                setVideoHasAudioTrack(originalHasAudio);
                                if (!originalHasAudio) setMuteOriginalAudio(true);

                                const newClip: VideoTrackClip = {
                                    id: crypto.randomUUID(),
                                    libraryVideoId: libraryVideo.id,
                                    name: libraryVideo.fileName,
                                    startTime: 0,
                                    duration: libraryVideo.duration,
                                    trimStart: 0,
                                    trimEnd: libraryVideo.duration,
                                    thumbnailUrl: libraryVideo.thumbnailUrl,
                                    hasCamera: 'cameraUrl' in videoToLoad && !!videoToLoad.cameraUrl,
                                };

                                activeClipIdRef.current = newClip.id;
                                activeClipDataRef.current = newClip;

                                setVideoClips([newClip]);
                                setVideosLibraryRefresh(prev => prev + 1);
                            } catch (e) {
                                console.warn("Failed to add video to library:", e);
                            }
                        }

                        if ('isRecordedVideo' in videoToLoad && videoToLoad.isRecordedVideo) {
                            setIsRecordedVideo(true);
                        } else {
                            setIsRecordedVideo(false);
                        }

                        if ('cameraUrl' in videoToLoad && videoToLoad.cameraUrl) {
                            setCameraUrl(videoToLoad.cameraUrl);
                        } else {
                            setCameraUrl(null);
                        }
                        if ('cameraConfig' in videoToLoad && videoToLoad.cameraConfig) {
                            setCameraConfig(videoToLoad.cameraConfig);
                        } else {
                            setCameraConfig(null);
                        }

                        setTimeout(() => {
                            clearHistory();
                        }, 200);
                    }
                }

            } catch (error) {
                console.error("Error loading video:", error);
            }
        };

        loadVideo();

        // Re-check when page becomes visible (user navigates back or uploads new video)
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                loadVideo();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, [activeProjectId, loadUploadedVideo, clearHistory]);

    useEffect(() => {
        if (uploadedImages.length > 0) {
            localStorage.setItem("openvid-uploaded-images", JSON.stringify(uploadedImages));
        }
    }, [uploadedImages]);

    useEffect(() => {
        if (videoRef.current) {
            videoRef.current.muted = muteOriginalAudio;
        }
    }, [muteOriginalAudio]);

    // Keyboard shortcuts for undo/redo
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            const isInputFocused = target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable;

            if (isInputFocused) return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (canUndo) {
                    undo();
                }
            }

            if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
                ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
                e.preventDefault();
                if (canRedo) {
                    redo();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [undo, redo, canUndo, canRedo]);

    // Keyboard listener for Ctrl+V image paste (photo mode only)
    useEffect(() => {
        if (!isPhotoMode) return;

        const handlePaste = async (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            for (const item of Array.from(items)) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) {
                        handleImageUploadToCanvas(file);
                    }
                    break;
                }
            }
        };

        window.addEventListener('paste', handlePaste);
        return () => window.removeEventListener('paste', handlePaste);
    }, [isPhotoMode, handleImageUploadToCanvas]);

    const togglePlayPause = useCallback(() => {
        if (videoRef.current) {
            if (isPlaying) {
                videoRef.current.pause();
                const clips = videoClipsRef.current;
                if (clips.length > 0 && activeClipDataRef.current) {
                    const activeClip = activeClipDataRef.current;
                    const offsetInClip = videoRef.current.currentTime - activeClip.trimStart;
                    const timelineTime = activeClip.startTime + offsetInClip;
                    setCurrentTime(timelineTime, true);
                    syncAudioPlayback(timelineTime, false);
                } else {
                    syncAudioPlayback(currentTimeRef.current, false);
                }
            } else {
                const clips = videoClipsRef.current;
                let startTime = currentTimeRef.current;

                if (trimRange.end > 0) {
                    if (startTime < trimRange.start || startTime >= trimRange.end) {
                        startTime = trimRange.start;
                        setCurrentTime(startTime, true);
                    }
                }

                if (clips.length > 0) {
                    const clipAtTime = findActiveClipAtTime(startTime);
                    if (clipAtTime) {
                        if (clipAtTime.id !== activeClipIdRef.current) {
                            const url = videoUrlsRef.current.get(clipAtTime.libraryVideoId);
                            if (url && videoRef.current) {
                                activeClipIdRef.current = clipAtTime.id;
                                activeClipDataRef.current = clipAtTime;
                                videoRef.current.src = url;

                                const clipTime = timelineToClipTime(startTime, clipAtTime);
                                const onCanPlay = () => {
                                    if (videoRef.current) {
                                        videoRef.current.playbackRate = 1.0;
                                        videoRef.current.currentTime = clipTime;
                                        const clipHasAudio = clipAudioStateRef.current.get(clipAtTime.libraryVideoId);
                                        videoRef.current.muted = muteOriginalAudioRef.current || clipHasAudio === false;
                                        videoRef.current.play().catch(() => { });
                                        syncAudioPlayback(startTime, true);
                                    }
                                    videoRef.current?.removeEventListener('canplay', onCanPlay);
                                };
                                videoRef.current.addEventListener('canplay', onCanPlay);
                                setIsPlaying(true);
                                return;
                            }
                        } else {
                            activeClipIdRef.current = clipAtTime.id;
                            activeClipDataRef.current = clipAtTime;
                            const clipTime = timelineToClipTime(startTime, clipAtTime);
                            videoRef.current.currentTime = clipTime;
                        }
                    } else if (clips.length === 1) {
                        const clip = clips[0];
                        activeClipIdRef.current = clip.id;
                        activeClipDataRef.current = clip;
                        videoRef.current.currentTime = clip.trimStart;
                        setCurrentTime(clip.startTime, true);
                    }
                } else {
                    videoRef.current.currentTime = startTime;
                }

                const playPromise = videoRef.current.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        if (error.name !== 'AbortError') {
                            console.warn('Play interrupted:', error);
                        }
                    });
                }
                syncAudioPlayback(startTime, true);
            }
            setIsPlaying(!isPlaying);
        }
    }, [isPlaying, trimRange.start, trimRange.end, setCurrentTime, syncAudioPlayback, findActiveClipAtTime, timelineToClipTime]);

    const updateTimeSmoothRef = useRef<() => void>(() => { });

    useEffect(() => {
        updateTimeSmoothRef.current = () => {
            if (justEndedRef.current) return;
            if (isSwitchingClipRef.current) {
                if (isPlaying && !isDraggingPlayhead) {
                    animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
                }
                return;
            }

            if (videoRef.current && !isDraggingPlayhead) {
                const clips = videoClipsRef.current;

                if (clips.length > 0) {
                    const currentVideoTime = videoRef.current.currentTime;

                    let activeClip: VideoTrackClip | null = null;

                    if (activeClipDataRef.current && activeClipDataRef.current.id === activeClipIdRef.current) {
                        activeClip = activeClipDataRef.current;
                    } else {
                        const foundByIdActiveClip = clips.find(c => c.id === activeClipIdRef.current);

                        if (foundByIdActiveClip) {
                            activeClip = foundByIdActiveClip;
                        } else if (clips.length === 1) {
                            activeClip = clips[0];
                        } else {
                            activeClip = clips[0];
                        }
                    }

                    if (!activeClip) {
                        if (isPlaying && !isDraggingPlayhead) {
                            animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
                        }
                        return;
                    }

                    if (!isSwitchingClipRef.current && activeClipIdRef.current !== activeClip.id) {
                        activeClipIdRef.current = activeClip.id;
                        activeClipDataRef.current = activeClip;
                    }

                    if (clipSwitchTimeRef.current !== null) {
                        setCurrentTime(clipSwitchTimeRef.current, true);
                        if (isPlaying && !isDraggingPlayhead) {
                            animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
                        }
                        return;
                    }

                    if (activeClip) {
                        const offsetInClip = currentVideoTime - activeClip.trimStart;
                        const timelineTime = activeClip.startTime + offsetInClip;
                        const clipDuration = activeClip.trimEnd - activeClip.trimStart;
                        const clipEndOnTimeline = activeClip.startTime + clipDuration;

                        const reachedEndByTime = currentVideoTime >= activeClip.trimEnd;
                        const reachedEndByTimeline = timelineTime >= clipEndOnTimeline;

                        if (reachedEndByTime || reachedEndByTimeline) {
                            const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime);
                            const currentIndex = sortedClips.findIndex(c => c.id === activeClip!.id);
                            const nextClip = sortedClips[currentIndex + 1];

                            if (nextClip) {
                                const nextUrl = videoUrlsRef.current.get(nextClip.libraryVideoId);
                                const nextBlob = videoBlobsRef.current.get(nextClip.libraryVideoId);

                                if (nextUrl && videoRef.current) {
                                    const nextClipSnapshot = { ...nextClip };

                                    activeClipIdRef.current = nextClipSnapshot.id;
                                    activeClipDataRef.current = nextClipSnapshot;
                                    clipSwitchTimeRef.current = nextClipSnapshot.startTime;
                                    isSwitchingClipRef.current = true;

                                    const currentVideo = videoRef.current;
                                    currentVideo.pause();
                                    currentVideo.src = nextUrl;

                                    const startPlayback = () => {
                                        clipSwitchTimeRef.current = null;
                                        isSwitchingClipRef.current = false;
                                        justEndedRef.current = false;
                                        currentVideo.playbackRate = 1.0;
                                        const nextClipHasAudio = clipAudioStateRef.current.get(nextClipSnapshot.libraryVideoId);
                                        currentVideo.muted = muteOriginalAudioRef.current || nextClipHasAudio === false;
                                        currentVideo.play().catch(e => {
                                            if (e.name !== 'AbortError') console.warn('Play interrupted:', e);
                                        });
                                        setIsPlaying(true);
                                        animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
                                    };

                                    const onCanPlay = () => {
                                        if (currentVideo) {
                                            const targetTime = nextClipSnapshot.trimStart;
                                            if (targetTime < 0.01) {
                                                currentVideo.currentTime = 0;
                                                startPlayback();
                                            } else {
                                                const onSeeked = () => {
                                                    startPlayback();
                                                    currentVideo.removeEventListener('seeked', onSeeked);
                                                };
                                                currentVideo.addEventListener('seeked', onSeeked);
                                                currentVideo.currentTime = targetTime;
                                            }
                                        }
                                        currentVideo?.removeEventListener('canplay', onCanPlay);
                                    };
                                    currentVideo.addEventListener('canplay', onCanPlay);

                                    setCurrentTime(nextClipSnapshot.startTime, true);
                                    animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
                                    return;
                                }
                            } else {
                                videoRef.current.pause();
                                syncAudioPlayback(clipEndOnTimeline, false);
                                setIsPlaying(false);
                                justEndedRef.current = true;
                                setCurrentTime(clipEndOnTimeline, true);
                                setTimeout(() => { justEndedRef.current = false; }, 300);
                                return;
                            }
                        }

                        if (trimRange.end > 0 && timelineTime >= trimRange.end) {
                            videoRef.current.pause();
                            syncAudioPlayback(timelineTime, false);
                            setIsPlaying(false);
                            justEndedRef.current = true;
                            setCurrentTime(trimRange.end, true);
                            setTimeout(() => { justEndedRef.current = false; }, 300);
                            return;
                        }

                        setCurrentTime(timelineTime);
                        syncAudioPlayback(timelineTime, true);
                    }
                } else {
                    const currentVideoTime = videoRef.current.currentTime;

                    if (trimRange.end > 0 && currentVideoTime >= trimRange.end) {
                        videoRef.current.pause();
                        syncAudioPlayback(currentVideoTime, false);
                        setIsPlaying(false);
                        justEndedRef.current = true;
                        setCurrentTime(trimRange.end, true);
                        setTimeout(() => { justEndedRef.current = false; }, 300);
                        return;
                    }

                    setCurrentTime(currentVideoTime);
                    syncAudioPlayback(currentVideoTime, true);
                }
            }
            if (isPlaying && !isDraggingPlayhead) {
                animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
            }
        };
    }, [isPlaying, isDraggingPlayhead, trimRange.end, setCurrentTime, syncAudioPlayback]);

    // Start/stop animation frame loop based on playing state
    useEffect(() => {
        if (isPlaying && !isDraggingPlayhead) {
            animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
        } else {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
        }

        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [isPlaying, isDraggingPlayhead]);

    const handleTimeUpdate = () => {
        if (videoRef.current && !isPlaying && !justEndedRef.current && !isSeekingToClipRef.current) {
            const clips = videoClipsRef.current;
            if (clips.length > 0 && activeClipDataRef.current) {
                const activeClip = activeClipDataRef.current;
                const offsetInClip = videoRef.current.currentTime - activeClip.trimStart;
                const timelineTime = activeClip.startTime + offsetInClip;
                setCurrentTime(timelineTime, true);
            } else {
                setCurrentTime(videoRef.current.currentTime, true);
            }
        }
    };

    const handlePlayheadDragStart = useCallback(() => {
        setIsDraggingPlayhead(true);
        // Pause video during scrubbing for smoother experience
        if (videoRef.current && !videoRef.current.paused) {
            wasPlayingBeforeDragRef.current = true;
            videoRef.current.pause();
        } else {
            wasPlayingBeforeDragRef.current = false;
        }
    }, []);

    const handlePlayheadDragEnd = useCallback(() => {
        setIsDraggingPlayhead(false);

        // Always read from ref — scrubTime state may still be stale at this point
        const finalTime = scrubTimeRef.current;

        // Set playhead position immediately (prevents visual jump)
        setCurrentTime(finalTime, true);

        if (videoRef.current) {
            const clips = videoClipsRef.current;

            if (clips.length > 0) {
                const clipAtTime = findActiveClipAtTime(finalTime);

                if (clipAtTime) {
                    const clipTime = timelineToClipTime(finalTime, clipAtTime);

                    if (clipAtTime.id !== activeClipIdRef.current) {
                        const url = videoUrlsRef.current.get(clipAtTime.libraryVideoId);
                        if (url) {
                            activeClipIdRef.current = clipAtTime.id;
                            activeClipDataRef.current = clipAtTime;
                            isSeekingToClipRef.current = true;
                            const currentVideo = videoRef.current;
                            currentVideo.src = url;

                            const shouldPlay = wasPlayingBeforeDragRef.current;
                            const onCanPlay = () => {
                                if (currentVideo) {
                                    currentVideo.playbackRate = 1.0;
                                    currentVideo.currentTime = clipTime;
                                    const clipHasAudio = clipAudioStateRef.current.get(clipAtTime.libraryVideoId);
                                    currentVideo.muted = muteOriginalAudioRef.current || clipHasAudio === false;
                                    isSeekingToClipRef.current = false;
                                    if (shouldPlay) {
                                        currentVideo.play().catch(e => {
                                            if (e.name !== 'AbortError') console.warn('Play interrupted:', e);
                                        });
                                        setIsPlaying(true);
                                        syncAudioPlayback(finalTime, true);
                                    } else {
                                        syncAudioPlayback(finalTime, false);
                                    }
                                }
                                currentVideo?.removeEventListener('canplay', onCanPlay);
                            };
                            currentVideo.addEventListener('canplay', onCanPlay);
                            return;
                        }
                    } else {
                        videoRef.current.currentTime = clipTime;
                    }
                }
            } else {
                videoRef.current.currentTime = finalTime;
            }
        }

        if (wasPlayingBeforeDragRef.current && videoRef.current) {
            const playPromise = videoRef.current.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    if (error.name !== 'AbortError') {
                        console.warn('Play interrupted:', error);
                    }
                });
            }
            setIsPlaying(true);
            syncAudioPlayback(finalTime, true);
        } else {
            syncAudioPlayback(finalTime, false);
        }
    }, [setCurrentTime, syncAudioPlayback, findActiveClipAtTime, timelineToClipTime]);

    const handleZoomChange = useCallback((zoom: number) => {
        setTimelineZoom(zoom);
    }, []);

    const handleLoadedMetadata = useCallback(() => {
        if (videoRef.current) {
            videoRef.current.playbackRate = 1.0;

            const duration = videoRef.current.duration;
            if (isFinite(duration) && duration > 0) {
                const currentClips = videoClipsRef.current;
                if (currentClips.length <= 1) {
                    setVideoDuration(duration);
                    setTrimRange(prev => prev.end === 0 ? { start: 0, end: duration } : prev);
                }
            }
        }
    }, []);

    const skipBackward = useCallback(() => {
        if (videoRef.current) {
            const newTime = Math.max(trimRange.start, videoRef.current.currentTime - 5);
            videoRef.current.currentTime = newTime;
            setCurrentTime(newTime, true);
            syncAudioPlayback(newTime, isPlaying);
        }
    }, [trimRange.start, isPlaying, setCurrentTime, syncAudioPlayback]);

    const skipForward = useCallback(() => {
        if (videoRef.current) {
            const newTime = Math.min(trimRange.end, videoRef.current.currentTime + 5);
            videoRef.current.currentTime = newTime;
            setCurrentTime(newTime, true);
            syncAudioPlayback(newTime, isPlaying);

            if (newTime >= trimRange.end) {
                videoRef.current.pause();
                setIsPlaying(false);
                syncAudioPlayback(newTime, false);
            }
        }
    }, [trimRange.end, isPlaying, setCurrentTime, syncAudioPlayback]);

    const handleSeek = useCallback((time: number) => {
        scrubTimeRef.current = time;
        setScrubTime(time);
        setCurrentTime(time, true);

        if (videoRef.current && !isDraggingPlayhead) {
            const clips = videoClipsRef.current;

            if (clips.length > 0) {
                const clipAtTime = findActiveClipAtTime(time);

                if (clipAtTime) {
                    const clipTime = timelineToClipTime(time, clipAtTime);
                    const currentUrl = videoRef.current.src;
                    const targetUrl = videoUrlsRef.current.get(clipAtTime.libraryVideoId);
                    const needsClipSwitch = clipAtTime.id !== activeClipIdRef.current
                        || (targetUrl && currentUrl !== targetUrl);

                    if (needsClipSwitch && targetUrl) {
                        const wasPlaying = isPlaying;

                        if (videoRef.current && !videoRef.current.paused) {
                            videoRef.current.pause();
                        }
                        if (animationFrameRef.current) {
                            cancelAnimationFrame(animationFrameRef.current);
                            animationFrameRef.current = null;
                        }

                        activeClipIdRef.current = clipAtTime.id;
                        activeClipDataRef.current = clipAtTime;
                        isSeekingToClipRef.current = true;
                        isSwitchingClipRef.current = true;

                        const currentVideo = videoRef.current;
                        currentVideo.src = targetUrl;

                        const onCanPlay = () => {
                            if (currentVideo) {
                                currentVideo.playbackRate = 1.0;
                                currentVideo.currentTime = clipTime;
                                const clipHasAudio = clipAudioStateRef.current.get(clipAtTime.libraryVideoId);
                                currentVideo.muted = muteOriginalAudioRef.current || clipHasAudio === false;
                                isSeekingToClipRef.current = false;
                                isSwitchingClipRef.current = false;
                                clipSwitchTimeRef.current = null;

                                if (wasPlaying) {
                                    currentVideo.play().catch(e => {
                                        if (e.name !== 'AbortError') console.warn('Play interrupted:', e);
                                    });
                                    animationFrameRef.current = requestAnimationFrame(updateTimeSmoothRef.current);
                                }
                            }
                            currentVideo?.removeEventListener('canplay', onCanPlay);
                        };
                        currentVideo.addEventListener('canplay', onCanPlay);
                        syncAudioPlayback(time, false);
                        return;
                    } else {
                        if ('fastSeek' in videoRef.current && typeof videoRef.current.fastSeek === 'function') {
                            videoRef.current.fastSeek(clipTime);
                        } else {
                            videoRef.current.currentTime = clipTime;
                        }
                    }
                }
            } else {
                if ('fastSeek' in videoRef.current && typeof videoRef.current.fastSeek === 'function') {
                    videoRef.current.fastSeek(time);
                } else {
                    videoRef.current.currentTime = time;
                }
            }
            syncAudioPlayback(time, isPlaying);
        }
    }, [isDraggingPlayhead, isPlaying, setCurrentTime, syncAudioPlayback, findActiveClipAtTime, timelineToClipTime]);

    // Handler for background image upload (for ControlPanel)
    const handleImageUpload = useCallback(async (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            if (dataUrl) {
                setUploadedImages(prev => [dataUrl, ...prev]);
                setSelectedImageUrl(dataUrl);
            }
        };
        reader.readAsDataURL(file);
    }, []);

    const handleImageSelect = (url: string) => {
        if (backgroundTab === "wallpaper") {
            setUnsplashBgUrl(url);
        } else {
            setSelectedImageUrl(url);
        }
    };

    const handleWallpaperSelect = (index: number) => {
        setSelectedWallpaper(index);
        setUnsplashBgUrl("");
    };

    const handleImageRemove = (url: string) => {
        setUploadedImages(prev => prev.filter(img => img !== url));
        if (selectedImageUrl === url) {
            setSelectedImageUrl("");
        }
    };

    // Background tab change handler
    const handleBackgroundTabChange = (tab: BackgroundTab) => {
        setBackgroundTab(tab);
    };

    // Handler para cambio de color/gradiente
    const handleBackgroundColorChange = (config: BackgroundColorConfig) => {
        setBackgroundColorConfig(config);
    };

    // Zoom fragment handlers
    const handleSelectZoomFragment = useCallback((fragmentId: string | null) => {
        setSelectedZoomFragmentId(fragmentId);
        if (fragmentId) {
            setSelectedAudioTrackId(null);
            setSelectedVideoClipId(null);
            setSelectedElementId(null);
        }
    }, []);

    const handleActivateZoomTool = useCallback(() => {
        setActiveTool("zoom");
    }, []);

    // Default duration for new zoom fragments
    const DEFAULT_ZOOM_FRAGMENT_DURATION = 2;

    const handleAddZoomFragment = useCallback((startTime: number) => {
        // Find valid position avoiding overlaps - use ref to get latest fragments
        const validPosition = findValidFragmentPosition(
            startTime,
            DEFAULT_ZOOM_FRAGMENT_DURATION,
            zoomFragmentsRef.current,
            videoDuration
        );

        if (!validPosition) {
            return;
        }

        const newFragment = createZoomFragment(validPosition.startTime, validPosition.endTime);
        setZoomFragments(prev => [...prev, newFragment].sort((a, b) => a.startTime - b.startTime));
        setSelectedZoomFragmentId(newFragment.id);
        setActiveTool("zoom");
    }, [videoDuration]);

    const handleUpdateZoomFragment = useCallback((fragmentId: string, updates: Partial<ZoomFragment>) => {
        setZoomFragments(prev => prev.map(f =>
            f.id === fragmentId ? { ...f, ...updates } : f
        ).sort((a, b) => a.startTime - b.startTime));
    }, []);

    const handleDeleteZoomFragment = useCallback((fragmentId: string) => {
        setZoomFragments(prev => prev.filter(f => f.id !== fragmentId));
        if (selectedZoomFragmentId === fragmentId) {
            setSelectedZoomFragmentId(null);
        }
    }, [selectedZoomFragmentId]);

    // Get currently selected zoom fragment - memoized
    const selectedZoomFragment = useMemo(() =>
        zoomFragments.find(f => f.id === selectedZoomFragmentId) || null,
        [zoomFragments, selectedZoomFragmentId]
    );

    // Calcular el CSS del background actual - memoized
    const backgroundColorCss = useMemo((): string | undefined => {
        if (backgroundTab === "color" && backgroundColorConfig) {
            if (backgroundColorConfig.type === "solid") {
                return backgroundColorConfig.config.color;
            } else {
                return gradientToCss(backgroundColorConfig.config);
            }
        }
        return undefined;
    }, [backgroundTab, backgroundColorConfig]);

    // Fullscreen toggle handler
    const toggleFullscreen = useCallback(async () => {
        if (!editorAreaRef.current) return;

        try {
            if (!document.fullscreenElement) {
                await editorAreaRef.current.requestFullscreen();
                setIsFullscreen(true);
            } else {
                await document.exitFullscreen();
                setIsFullscreen(false);
            }
        } catch (error) {
            console.error("Error toggling fullscreen:", error);
        }
    }, []);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };

        document.addEventListener("fullscreenchange", handleFullscreenChange);
        return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
    }, []);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            // Also skip if inside a contenteditable element
            if ((e.target as HTMLElement)?.isContentEditable) return;

            // T key — Figma-style text tool: activate crosshair cursor to place text on canvas
            if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                setTextToolActive(true);
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedElementId) {
                e.preventDefault();
                copySelectedElement();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
                if (isPhotoMode && !copiedElement) {
                    return;
                }
                e.preventDefault();
                pasteElement();
                return;
            }

            if ((e.key === "Delete" || e.key === "Backspace") && selectedElementId) {
                e.preventDefault();
                deleteCanvasElement(selectedElementId);
                return;
            }

            if ((e.key === "Delete" || e.key === "Backspace") && selectedVideoClipId) {
                e.preventDefault();
                handleDeleteVideoClip(selectedVideoClipId);
                return;
            }

            if ((e.key === "Delete" || e.key === "Backspace") && selectedAudioTrackId) {
                e.preventDefault();
                handleDeleteAudioTrack(selectedAudioTrackId);
                setSelectedAudioTrackId(null);
                return;
            }

            if ((e.key === "Delete" || e.key === "Backspace") && selectedZoomFragmentId) {
                e.preventDefault();
                handleDeleteZoomFragment(selectedZoomFragmentId);
            }

            if (e.key === "Escape") {
                e.preventDefault();
                if (textToolActive) {
                    setTextToolActive(false);
                    return;
                }
                if (selectedElementId) {
                    setSelectedElementId(null);
                } else if (selectedVideoClipId) {
                    setSelectedVideoClipId(null);
                } else if (selectedAudioTrackId) {
                    setSelectedAudioTrackId(null);
                } else if (selectedZoomFragmentId) {
                    setSelectedZoomFragmentId(null);
                }
            }

        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [selectedElementId, selectedZoomFragmentId, selectedAudioTrackId, selectedVideoClipId, deleteCanvasElement, handleDeleteZoomFragment, handleDeleteAudioTrack, handleDeleteVideoClip, copySelectedElement, pasteElement, isPhotoMode, copiedElement, textToolActive]);

    useEffect(() => {
        const checkMobile = () => {
            if (window.innerWidth < 768) {
                setIsControlPanelOpen(false);
            }
        };
        checkMobile();
        window.addEventListener("resize", checkMobile);
        return () => window.removeEventListener("resize", checkMobile);
    }, []);

    const handleAspectRatioChange = useCallback((ratio: AspectRatio) => {
        setAspectRatio(ratio);
    }, []);

    const handleCustomDimensionsChange = useCallback((dimensions: { width: number; height: number }) => {
        setCustomDimensions(dimensions);
    }, []);

    const handleOpenCropper = useCallback(() => {
        setIsCropperOpen(true);
    }, []);

    const handleCloseCropper = useCallback(() => {
        setIsCropperOpen(false);
    }, []);

    const handleCropApply = useCallback((crop: CropArea) => {
        setCropArea(crop);
    }, []);

    // Only show camera if the active clip has camera support
    const activeClip = findActiveClipAtTime(currentTime);
    const shouldShowCamera = activeClip?.hasCamera === true;
    const effectiveCameraUrl = shouldShowCamera ? cameraUrl : null;
    const cloudEditorState = useMemo<Partial<EditorState>>(() => ({
        backgroundTab,
        selectedWallpaper,
        backgroundBlur,
        padding,
        roundedCorners,
        shadows,
        selectedImageUrl,
        backgroundColorConfig,
        aspectRatio,
        customDimensions,
        cropArea,
        trimRange,
        zoomFragments,
        mockupId,
        mockupConfig,
        canvasElements,
        audioTracks,
        muteOriginalAudio,
        masterVolume,
        cameraConfig,
        videoTransform,
        imageTransform,
        apply3DToBackground,
        imageMaskConfig,
        videoMaskConfig,
        videoClips,
    }), [
        backgroundTab,
        selectedWallpaper,
        backgroundBlur,
        padding,
        roundedCorners,
        shadows,
        selectedImageUrl,
        backgroundColorConfig,
        aspectRatio,
        customDimensions,
        cropArea,
        trimRange,
        zoomFragments,
        mockupId,
        mockupConfig,
        canvasElements,
        audioTracks,
        muteOriginalAudio,
        masterVolume,
        cameraConfig,
        videoTransform,
        imageTransform,
        apply3DToBackground,
        imageMaskConfig,
        videoMaskConfig,
        videoClips,
    ]);

    useEffect(() => {
        if (!activeProjectId || restoringCloudProjectRef.current) return;

        if (savingCloudProjectRef.current) {
            clearTimeout(savingCloudProjectRef.current);
        }

        savingCloudProjectRef.current = setTimeout(() => {
            updateProject(activeProjectId, {
                duration: videoDuration,
                editorState: cloudEditorState,
            }).catch((error) => {
                console.warn("Failed to save cloud project:", error);
            });
        }, 1200);

        return () => {
            if (savingCloudProjectRef.current) {
                clearTimeout(savingCloudProjectRef.current);
            }
        };
    }, [activeProjectId, cloudEditorState, videoDuration]);

    return (
        <div className="flex flex-col h-screen w-full bg-[#0E0E12] text-white/60 font-sans overflow-hidden select-none">
            {(isCloudProjectLoading || cloudProjectError) && (
                <div className="absolute left-1/2 top-4 z-[200] -translate-x-1/2 rounded-lg border border-white/10 bg-black/80 px-4 py-2 text-xs text-white shadow-xl backdrop-blur">
                    {cloudProjectError ? cloudProjectError : `Loading ${cloudProjectTitle}...`}
                </div>
            )}
            <div className="flex flex-1 overflow-hidden">
                <div className="hidden lg:flex">
                    <ToolsSidebar
                        activeTool={activeTool}
                        onToolChange={setActiveTool}
                        onVideoUpload={handleVideoUpload}
                        isUploading={isUploading}
                        selectedZoomFragmentId={selectedZoomFragmentId}
                        selectedAudioTrackId={selectedAudioTrackId}
                        selectedVideoClipId={selectedVideoClipId}
                        selectedElementId={selectedElementId}
                        newVideosCount={newVideosCount}
                        editorMode={editorMode}
                        onImageUpload={handleImageUploadToCanvas}
                        onScreenCapture={handleScreenCapture}
                        isCapturing={isCapturing}
                    />
                </div>

                <div className="hidden lg:block">
                    <AnimatePresence mode="wait">
                        {isControlPanelOpen && (
                            <motion.div
                                key="control-panel"
                                initial={{ x: -320, opacity: 0 }}
                                animate={{ x: 0, opacity: 1 }}
                                exit={{ x: -320, opacity: 0 }}
                                transition={{ duration: 0.3, ease: "easeInOut" }}
                            >
                                <Suspense fallback={
                                    <div className="w-[320px] h-screen bg-[#141417] border-r border-white/10 flex items-center justify-center">
                                        <LoadingSpinner message="Cargando panel..." />
                                    </div>
                                }>
                                    <ControlPanel
                                        activeTool={activeTool}
                                        backgroundTab={backgroundTab}
                                        onVideoAudioToggle={handleVideoAudioToggle}
                                        onBackgroundTabChange={handleBackgroundTabChange}
                                        selectedWallpaper={selectedWallpaper}
                                        onWallpaperSelect={handleWallpaperSelect}
                                        backgroundBlur={backgroundBlur}
                                        onBackgroundBlurChange={setBackgroundBlur}
                                        padding={padding}
                                        onPaddingChange={setPadding}
                                        roundedCorners={roundedCorners}
                                        onRoundedCornersChange={handleRoundedCornersChange}
                                        shadows={shadows}
                                        onShadowsChange={setShadows}
                                        uploadedImages={uploadedImages}
                                        selectedImageUrl={selectedImageUrl}
                                        onImageUpload={handleImageUpload}
                                        onImageSelect={handleImageSelect}
                                        onImageRemove={handleImageRemove}
                                        backgroundColorConfig={backgroundColorConfig}
                                        onBackgroundColorChange={handleBackgroundColorChange}
                                        onTogglePanel={() => setIsControlPanelOpen(!isControlPanelOpen)}
                                        isOpen={isControlPanelOpen}
                                        zoomFragments={zoomFragments}
                                        selectedZoomFragment={selectedZoomFragment}
                                        onSelectZoomFragment={handleSelectZoomFragment}
                                        onAddZoomFragment={() => handleAddZoomFragment(currentTime)}
                                        onUpdateZoomFragment={handleUpdateZoomFragment}
                                        onDeleteZoomFragment={handleDeleteZoomFragment}
                                        videoUrl={videoUrl}
                                        videoThumbnail={selectedZoomFragment ? getThumbnailForTime(selectedZoomFragment.startTime)?.dataUrl ?? null : null}
                                        currentTime={currentTime}
                                        getThumbnailForTime={getThumbnailForTime}
                                        videoDimensions={customAspectRatio}
                                        mockupId={mockupId}
                                        mockupConfig={mockupConfig}
                                        onMockupChange={handleMockupChange}
                                        onMockupConfigChange={handleMockupConfigChange}
                                        onAddCanvasElement={addCanvasElement}
                                        selectedCanvasElement={canvasElements.find(el => el.id === selectedElementId) || null}
                                        onUpdateCanvasElement={updateCanvasElement}
                                        onDeleteCanvasElement={deleteCanvasElement}
                                        onBringToFront={bringToFront}
                                        onSendToBack={sendToBack}
                                        uploadedAudios={uploadedAudios}
                                        audioTracks={audioTracks}
                                        muteOriginalAudio={muteOriginalAudio}
                                        masterVolume={masterVolume}
                                        onAudioUpload={handleAudioUpload}
                                        onAudioDelete={handleAudioDelete}
                                        onAddAudioTrack={handleAddAudioTrack}
                                        onUpdateAudioTrack={handleUpdateAudioTrack}
                                        onDeleteAudioTrack={handleDeleteAudioTrack}
                                        onToggleMuteOriginalAudio={handleToggleMuteOriginalAudio}
                                        onMasterVolumeChange={handleMasterVolumeChange}
                                        videoDuration={videoDuration}
                                        projectId={activeProjectId}
                                        onAddVideoToTrack={handleAddVideoToTrack}
                                        onRemoveVideoFromTrack={handleRemoveVideoFromTrack}
                                        onVideoUploadToLibrary={handleVideoUploadToLibrary}
                                        onVideoDeleteFromTrack={handleDeleteVideoFromLibrary}
                                        videosInTrackIds={videosInTrackIds}
                                        videosLibraryRefresh={videosLibraryRefresh}
                                        isVideoUploading={isUploading}
                                        cameraUrl={cameraUrl}
                                        cameraConfig={cameraConfig}
                                        onCameraConfigChange={handleCameraConfigChange}
                                        imageProjects={imageProjects}
                                        currentImageProjectId={currentProject?.id || null}
                                        isLoadingProjects={isLoadingProjects}
                                        onSelectImageProject={handleSelectImageProject}
                                        onAddImageToCanvas={handleAddImageToCanvas}
                                        onDeleteImageProject={handleDeleteImageProject}
                                        onUploadImageToHistory={handleUploadImageToHistory}
                                        elementsTextTabTrigger={elementsTextTabTrigger}
                                    />
                                </Suspense>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                <div
                    ref={editorAreaRef}
                    className="flex-1 bg-[#09090B] flex flex-col relative overflow-hidden min-w-0"
                >
                    <AnimatePresence>
                        {!isControlPanelOpen && (
                            <TooltipAction label="Abrir panel de control" side="right">
                                <motion.button
                                    initial={{ x: -100, opacity: 0 }}
                                    animate={{ x: 0, opacity: 1 }}
                                    exit={{ x: -100, opacity: 0 }}
                                    transition={{ duration: 0.3, ease: "easeInOut", delay: 0.15 }}
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.9 }}
                                    onClick={() => setIsControlPanelOpen(true)}
                                    className="absolute top-2 left-4 z-50 p-2 flex items-center gap-2 squircle-element bg-[#18181b] border border-white/10 text-white hover:bg-[#252529] transition-all duration-200 shadow-lg"
                                >
                                    <Link href="/" className="block sm:hidden"><Image src="/svg/logo-openvid.svg" alt="Logo" width={24} height={24} className="hover:opacity-80 transition-opacity" /></Link>
                                    <Icon icon="lucide:sidebar-open" width="20" className="hidden sm:block"
                                    />
                                </motion.button>
                            </TooltipAction>
                        )}
                    </AnimatePresence>

                    <VideoCanvas
                        layersPanelToolbar={
                            <EditorTopBar
                                onExport={handleExport}
                                exportProgress={exportProgress}
                                hasTransparentBackground={selectedWallpaper === -1}
                                onUndo={undo}
                                onRedo={redo}
                                canUndo={canUndo}
                                canRedo={canRedo}
                                editorMode={editorMode}
                                onImageExport={handleImageExport}
                                imageExportProgress={imageExportProgress}
                                canvasWidth={customAspectRatio?.width || 1920}
                                canvasHeight={customAspectRatio?.height || 1080}
                                activeProjectId={activeProjectId}
                                activeProjectTitle={cloudProjectTitle}
                                projects={cloudProjects}
                                isLoadingProjects={isCloudProjectsLoading}
                                onSelectProject={handleSelectCloudProject}
                                onCreateProject={handleCreateCloudProject}
                                onRenameProject={handleRenameCloudProject}
                            />
                        }
                        ref={canvasRef}
                        videoUrl={videoUrl}
                        videoRef={videoRef}
                        mediaType={isPhotoMode ? "image" : "video"}
                        imageUrl={imageUrl}
                        imageRef={imageRef}
                        imageTransform={imageTransform}
                        apply3DToBackground={apply3DToBackground}
                        imageMaskConfig={imageMaskConfig}
                        videoMaskConfig={videoMaskConfig}
                        onVideoMaskConfigChange={setVideoMaskConfig}
                        padding={padding}
                        roundedCorners={roundedCorners}
                        shadows={shadows}
                        aspectRatio={aspectRatio}
                        customAspectRatio={customAspectRatio}
                        cropArea={cropArea}
                        backgroundTab={backgroundTab}
                        selectedWallpaper={selectedWallpaper}
                        backgroundBlur={backgroundBlur}
                        selectedImageUrl={selectedImageUrl}
                        unsplashOverrideUrl={unsplashBgUrl}
                        backgroundColorCss={backgroundColorCss}
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={handleLoadedMetadata}
                        isScrubbing={isDraggingPlayhead}
                        scrubTime={scrubTime}
                        getThumbnailForTime={getThumbnailForTime}
                        zoomFragments={zoomFragments}
                        currentTime={currentTime}
                        mockupId={mockupId}
                        mockupConfig={mockupConfig ?? DEFAULT_MOCKUP_CONFIG}
                        onVideoUpload={handleVideoUpload}
                        onImageUpload={handleImageUploadToCanvas}
                        onImageDrop={handleImageDrop}
                        isUploading={isUploading}
                        videoTransform={videoTransform}
                        onVideoTransformChange={setVideoTransform}
                        canvasElements={canvasElements}
                        selectedElementId={selectedElementId}
                        onElementUpdate={updateCanvasElement}
                        onElementSelect={selectCanvasElement}
                        onElementDelete={deleteCanvasElement}
                        onAddElement={addCanvasElement}
                        textToolActive={textToolActive}
                        onTextToolDeactivate={() => setTextToolActive(false)}
                        cameraUrl={effectiveCameraUrl}
                        cameraConfig={cameraConfig}
                        onCameraConfigChange={handleCameraConfigChange}
                        onCameraClick={handleCameraClick}
                        onEnded={() => {
                            const clips = videoClipsRef.current;
                            if (clips.length > 1) {
                                const sortedClips = [...clips].sort((a, b) => a.startTime - b.startTime);
                                const currentIndex = sortedClips.findIndex(c => c.id === activeClipIdRef.current);
                                if (currentIndex >= 0 && currentIndex < sortedClips.length - 1) {
                                    return;
                                }
                            }

                            setIsPlaying(false);
                            justEndedRef.current = true;
                            const endTime = trimRange.end > 0 ? trimRange.end : videoDuration;
                            setCurrentTime(endTime, true);
                            setTimeout(() => {
                                justEndedRef.current = false;
                            }, 300);
                        }}
                    />

                    {/* Video mode: Show player controls and timeline */}
                    {isVideoMode && (
                        <>
                            <PlayerControls
                                isPlaying={isPlaying}
                                currentTime={currentTime}
                                videoDuration={videoDuration}
                                aspectRatio={aspectRatio}
                                customAspectRatio={aspectRatio === "custom" ? customDimensions : videoDimensions}
                                isFullscreen={isFullscreen}
                                zoomLevel={timelineZoom}
                                onTogglePlayPause={togglePlayPause}
                                onSkipBackward={skipBackward}
                                onSkipForward={skipForward}
                                onToggleFullscreen={toggleFullscreen}
                                onAspectRatioChange={handleAspectRatioChange}
                                onCustomAspectRatioChange={handleCustomDimensionsChange}
                                onOpenCropper={handleOpenCropper}
                                onZoomChange={handleZoomChange}
                                videoMaskConfig={videoMaskConfig}
                                onVideoMaskConfigChange={setVideoMaskConfig}
                                videoPreviewImageUrl={getThumbnailForTime(currentDisplayTime)?.dataUrl ?? null}
                            />

                            <Suspense fallback={<TimelineSkeleton />}>
                                <Timeline
                                    videoDuration={videoDuration}
                                    currentTime={currentTime}
                                    onSeek={handleSeek}
                                    videoUrl={videoUrl}
                                    zoomLevel={timelineZoom}
                                    isDraggingPlayhead={isDraggingPlayhead}
                                    onDragStart={handlePlayheadDragStart}
                                    onDragEnd={handlePlayheadDragEnd}
                                    trimRange={trimRange}
                                    onTrimChange={setTrimRange}
                                    videoClips={videoClips}
                                    selectedVideoClipId={selectedVideoClipId}
                                    onSelectVideoClip={handleSelectVideoClip}
                                    onUpdateVideoClip={handleUpdateVideoClip}
                                    onDeleteVideoClip={handleDeleteVideoClip}
                                    zoomFragments={zoomFragments}
                                    selectedZoomFragmentId={selectedZoomFragmentId}
                                    onSelectZoomFragment={handleSelectZoomFragment}
                                    onAddZoomFragment={handleAddZoomFragment}
                                    onUpdateZoomFragment={handleUpdateZoomFragment}
                                    onActivateZoomTool={handleActivateZoomTool}
                                    audioTracks={audioTracks}
                                    uploadedAudios={uploadedAudios}
                                    selectedAudioTrackId={selectedAudioTrackId}
                                    onSelectAudioTrack={handleSelectAudioTrack}
                                    onUpdateAudioTrack={handleUpdateAudioTrack}
                                />
                            </Suspense>
                        </>
                    )}

                    {/* Photo mode: Show placeholder instead of timeline */}
                    {isPhotoMode && (
                        <Suspense fallback={<TimelineSkeleton />}>
                            <PhotoEditorPlaceholder
                                canvasImageUrl={canvasImageUrl}
                                staticImageUrl={imageUrl}
                                onSelectPreview={handleSelectPreview}
                                selectedPreviewId={selectedPreviewId}
                                aspectRatio={aspectRatio}
                                onAspectRatioChange={handleAspectRatioChange}
                                customAspectRatio={customAspectRatio}
                                onCustomAspectRatioChange={handleCustomDimensionsChange}
                                onOpenCropper={handleOpenCropper}
                                apply3DToBackground={apply3DToBackground}
                                onToggle3DBackground={handleToggle3DBackground}
                                imageMaskConfig={imageMaskConfig}
                                onImageMaskConfigChange={setImageMaskConfig}
                                imageTransform={imageTransform}
                                onReset={handleResetPhotoEditor}
                            />
                        </Suspense>
                    )}

                </div>

            </div>

            <MobileToolsMenu
                activeTool={activeTool}
                onToolChange={setActiveTool}
                onVideoUpload={handleVideoUpload}
                isUploading={isUploading}
                onOpenToolPanel={() => setIsMobileControlPanelOpen(true)}
            />

            <MobileControlPanel
                isOpen={isMobileControlPanelOpen}
                onClose={() => setIsMobileControlPanelOpen(false)}
                activeTool={activeTool}
                backgroundTab={backgroundTab}
                onBackgroundTabChange={handleBackgroundTabChange}
                selectedWallpaper={selectedWallpaper}
                onWallpaperSelect={handleWallpaperSelect}
                backgroundBlur={backgroundBlur}
                onBackgroundBlurChange={setBackgroundBlur}
                padding={padding}
                onPaddingChange={setPadding}
                roundedCorners={roundedCorners}
                onRoundedCornersChange={handleRoundedCornersChange}
                shadows={shadows}
                onShadowsChange={setShadows}
                uploadedImages={uploadedImages}
                selectedImageUrl={selectedImageUrl}
                onImageUpload={handleImageUpload}
                onImageSelect={handleImageSelect}
                onImageRemove={handleImageRemove}
                backgroundColorConfig={backgroundColorConfig}
                onBackgroundColorChange={handleBackgroundColorChange}
                zoomFragments={zoomFragments}
                selectedZoomFragment={selectedZoomFragment}
                onSelectZoomFragment={handleSelectZoomFragment}
                onAddZoomFragment={() => handleAddZoomFragment(currentTime)}
                onUpdateZoomFragment={handleUpdateZoomFragment}
                onDeleteZoomFragment={handleDeleteZoomFragment}
                videoUrl={videoUrl}
                videoThumbnail={selectedZoomFragment ? getThumbnailForTime(selectedZoomFragment.startTime)?.dataUrl ?? null : null}
                currentTime={currentTime}
                getThumbnailForTime={getThumbnailForTime}
                videoDimensions={videoDimensions}
                mockupId={mockupId}
                mockupConfig={mockupConfig}
                onMockupChange={handleMockupChange}
                onMockupConfigChange={handleMockupConfigChange}
                onAddCanvasElement={addCanvasElement}
                selectedCanvasElement={canvasElements.find(el => el.id === selectedElementId) || null}
                onUpdateCanvasElement={updateCanvasElement}
                onDeleteCanvasElement={deleteCanvasElement}
                onBringToFront={bringToFront}
                onSendToBack={sendToBack}
                uploadedAudios={uploadedAudios}
                audioTracks={audioTracks}
                muteOriginalAudio={muteOriginalAudio}
                masterVolume={masterVolume}
                onAudioUpload={handleAudioUpload}
                onAudioDelete={handleAudioDelete}
                onAddAudioTrack={handleAddAudioTrack}
                onUpdateAudioTrack={handleUpdateAudioTrack}
                onDeleteAudioTrack={handleDeleteAudioTrack}
                onToggleMuteOriginalAudio={handleToggleMuteOriginalAudio}
                onMasterVolumeChange={handleMasterVolumeChange}
                videoDuration={videoDuration}
            />

            <Suspense fallback={null}>
                <ExportOverlay
                    exportProgress={exportProgress}
                    onCancel={cancelExport}
                    isTransparentExport={selectedWallpaper === -1}
                />
            </Suspense>
            <Suspense fallback={null}>
                {isVideoMode ? (
                    <VideoCropperModal
                        isOpen={isCropperOpen}
                        onClose={handleCloseCropper}
                        videoUrl={videoUrl}
                        onCropApply={handleCropApply}
                        initialCrop={cropArea}
                    />
                ) : (
                    <ImageCropperModal
                        isOpen={isCropperOpen}
                        onClose={handleCloseCropper}
                        imageUrl={imageUrl}
                        onCropApply={handleCropApply}
                        initialCrop={cropArea}
                    />
                )}
            </Suspense>

            {autoTrimModalOpen && pendingAudioUpload && (
                <AudioTrimModal
                    key={pendingAudioUpload.audio.id}
                    isOpen={autoTrimModalOpen}
                    audioName={pendingAudioUpload.audio.name}
                    audioUrl={pendingAudioUpload.audio.url}
                    audioDuration={pendingAudioUpload.audio.duration}
                    initialTrimStart={0}
                    initialTrimEnd={Math.min(pendingAudioUpload.audio.duration, videoDuration)}
                    onConfirm={(trimStart, trimEnd) => {
                        if (pendingAudioUpload) {
                            const lastTrackEnd = audioTracks.reduce((max, track) =>
                                Math.max(max, track.startTime + track.duration), 0);

                            const newTrack: AudioTrack = {
                                id: pendingAudioUpload.trackId,
                                audioId: pendingAudioUpload.audio.id,
                                name: pendingAudioUpload.audio.name,
                                startTime: lastTrackEnd,
                                duration: trimEnd - trimStart,
                                trimStart: trimStart,
                                volume: 1,
                                loop: false,
                            };

                            setAudioTracks(prev => [...prev, newTrack]);

                            if (audioTracks.length === 0) {
                                setMuteOriginalAudio(true);
                            }
                        }
                        setAutoTrimModalOpen(false);
                        setPendingAudioUpload(null);
                    }}
                    onCancel={() => {
                        if (pendingAudioUpload) {
                            setUploadedAudios(prev => prev.filter(a => a.id !== pendingAudioUpload.audio.id));
                            URL.revokeObjectURL(pendingAudioUpload.audio.url);
                        }
                        setAutoTrimModalOpen(false);
                        setPendingAudioUpload(null);
                    }}
                />
            )}
        </div>
    );
}
