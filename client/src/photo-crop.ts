import type { Crop } from './protocol';
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

export const defaultCrop = (): Crop => ({ x: 0.5, y: 0.5, zoom: 1 });
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export function validCrop(value: unknown): value is Crop {
  if (!value || typeof value !== 'object') return false;
  const crop = value as Crop;
  return [crop.x, crop.y, crop.zoom].every(Number.isFinite)
    && crop.x >= 0 && crop.x <= 1 && crop.y >= 0 && crop.y <= 1
    && crop.zoom >= 1 && crop.zoom <= 5;
}

export function photoLayout(image: Size, viewport: Size, crop: Crop) {
  const scale = Math.max(viewport.width / image.width, viewport.height / image.height) * crop.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return { width, height, left: -(width - viewport.width) * crop.x, top: -(height - viewport.height) * crop.y };
}

export function panPhoto(image: Size, viewport: Size, crop: Crop, dx: number, dy: number): Crop {
  const layout = photoLayout(image, viewport, crop);
  const overflowX = layout.width - viewport.width;
  const overflowY = layout.height - viewport.height;
  return {
    ...crop,
    x: overflowX > 0.01 ? clamp(crop.x - dx / overflowX) : 0.5,
    y: overflowY > 0.01 ? clamp(crop.y - dy / overflowY) : 0.5,
  };
}

// Keep the point under the cursor/fingers stationary while zooming.
export function zoomPhoto(image: Size, viewport: Size, crop: Crop, zoom: number, anchor: Point): Crop {
  const old = photoLayout(image, viewport, crop);
  const next = photoLayout(image, viewport, { ...crop, zoom: clamp(zoom, 1, 5) });
  const left = anchor.x - (anchor.x - old.left) * next.width / old.width;
  const top = anchor.y - (anchor.y - old.top) * next.height / old.height;
  return {
    zoom: clamp(zoom, 1, 5),
    x: next.width - viewport.width > 0.01 ? clamp(-left / (next.width - viewport.width)) : 0.5,
    y: next.height - viewport.height > 0.01 ? clamp(-top / (next.height - viewport.height)) : 0.5,
  };
}
