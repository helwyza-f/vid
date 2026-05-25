import { QualitySettings } from '@/types';

export const EXPORT_WIDTH = 1920;
export const EXPORT_HEIGHT = 1080;

export const QUALITY_SETTINGS: Record<string, QualitySettings> = {
    "4k": { width: 3840, height: 2160, bitrate: 60_000_000, fps: 60 },
    "2k": { width: 2560, height: 1440, bitrate: 24_000_000, fps: 60 },
    "1080p": { width: 1920, height: 1080, bitrate: 12_000_000, fps: 60 },
    "720p": { width: 1280, height: 720, bitrate: 8_000_000, fps: 60 },
    "480p": { width: 854, height: 480, bitrate: 2_500_000, fps: 24 },
    "gif": { width: 1280, height: 720, bitrate: 2_500_000, fps: 24 },
    "webm-alpha": { width: 1280, height: 720, bitrate: 2_000_000, fps: 24 },
};

/**
 * FPS por defecto para exportación (fallback)
 */
export const DEFAULT_EXPORT_FPS = 60;

/**
 * Ancho de referencia del contenedor de preview (max-w-4xl en Tailwind)
 */
export const PREVIEW_CONTAINER_WIDTH = 896;

/**
 * Ancho del sidebar de etiquetas en el timeline (px)
 */
export const TIMELINE_LABEL_WIDTH = 80;

/**
 * Duración mínima entre trim handles (segundos)
 */
export const MIN_TRIM_DURATION = 0.5;

/**
 * Tabla de multiplicadores de zoom para el timeline
 * zoom 1× → 1.0 (sin estiramiento), zoom 10× → 2.5 (estiramiento moderado)
 */
export const TIMELINE_ZOOM_SCALE: Record<number, number> = {
    1: 1.0,
    2: 1.2,
    3: 1.4,
    4: 1.6,
    5: 1.8,
    6: 2.0,
    7: 2.1,
    8: 2.2,
    9: 2.35,
    10: 2.5,
};

// Mockups con header → solo esquinas INFERIORES del video redondeadas
export const BOTTOM_ONLY_RADIUS_MOCKUPS = ["macos", "macos-glass", "macos-ghost", "macos-ghost-glass", "vscode", "macos-dark-ide", "macos-ghost-ide", "brave", "brave-glass", "browser-tab-glass", "chrome", "chrome-glass", "s24-ultra", "glass-curve", "glass-full"];

// Mockups glass → manejan su propia sombra, no necesitan el rect sólido previo
export const SELF_SHADOWING_MOCKUPS = ["macos-glass", "macos-ghost-glass", "glass-ui-container", "macos-container-glass", "brave-glass", "browser-tab-glass", "chrome-glass", "iphone-slim", "glass-curve", "glass-full", "s24-ultra", "hard-shell"];

// Z-index del video: elementos con zIndex < VIDEO_Z_INDEX se renderizan detrás del video
export const VIDEO_Z_INDEX = 1000;
