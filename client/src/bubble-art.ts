import sheetUrl from '../../assets/player/speech_bubbles.png';

/*
 * assets/player/speech_bubbles.png is a grid of 32 px tiles, 2 px apart. The pieces
 * used here, as (column, row):
 *   (0..2, 0..2)  a bubble: corners, edges and middle, nine-slice
 *   (0, 3) (1, 3) its bottom-left and bottom-right corners, open for a tail
 *   (0, 4) (1, 4) the tails that hang from those openings, tip left and tip right
 */
const tile = 32;
const pitch = 34;
/** The tails' artwork fills the top 18 rows of their tiles. */
export const tailHeight = 18;
/** The tip's centre, from the bubble's edge on the tail's side, in sheet pixels. */
export const tipInset = 12.5;

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = Object.assign(document.createElement('canvas'), { width, height });
  const context = element.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  return [element, context];
}

/** A corner's size and the plain edge between corners, in sheet pixels: corners
 * end on the artwork's 3-pixel grid, and the tiles' last 2 pixels are plain edge. */
const corner = 30;

type Tail = 'left' | 'right';
let art: { bubbles: Record<Tail, HTMLCanvasElement>; tails: Record<Tail, HTMLCanvasElement> } | undefined;

/** A whole bubble with no gaps between tiles, open for a tail in that bottom corner. */
function bubble(sheet: HTMLImageElement, tail: Tail): HTMLCanvasElement {
  const [element, context] = canvas(3 * tile, 3 * tile);
  // The bottom corner tile open for the tail, and the corner it goes in.
  const opening = tail === 'left' ? [0, 3] : [1, 3];
  const tailColumn = tail === 'left' ? 0 : 2;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const [x, y] = row === 2 && column === tailColumn ? opening : [column, row];
      context.drawImage(sheet, x * pitch, y * pitch, tile, tile, column * tile, row * tile, tile, tile);
    }
  }
  return element;
}

function tail(sheet: HTMLImageElement, column: number): HTMLCanvasElement {
  const [element, context] = canvas(tile, tailHeight);
  context.drawImage(sheet, column * pitch, 4 * pitch, tile, tailHeight, 0, 0, tile, tailHeight);
  return element;
}

/** Cut the speech bubble pieces out of the sheet. */
export async function prepareBubbleArt(): Promise<void> {
  const sheet = new Image();
  sheet.src = sheetUrl;
  await sheet.decode();
  art = {
    bubbles: { left: bubble(sheet, 'left'), right: bubble(sheet, 'right') },
    tails: { left: tail(sheet, 0), right: tail(sheet, 1) },
  };
}

/**
 * Draw a bubble `width` by `height` device pixels, with its tail hanging below, into
 * `target`. One whole canvas at the screen's own resolution: drawn as nine separate
 * pieces (CSS border-image), the pieces' edges blurred into faint seams at
 * fractional scales. `unit`: device pixels per font pixel, 3 sheet pixels.
 */
export function paintBubble(target: HTMLCanvasElement, width: number, height: number, unit: number, side: Tail): void {
  const scale = (pixels: number) => Math.round(pixels * unit / 3);
  const tailWidth = scale(tile);
  target.width = width;
  target.height = height + scale(tailHeight);
  const context = target.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  if (!art) return;
  const source = art.bubbles[side];
  const end = 3 * tile - corner;
  const size = scale(corner);
  // Source and target spans: corner, plain edge stretched between, corner.
  const spans = (length: number): [number, number, number, number][] => [
    [0, corner, 0, size], [corner, end - corner, size, length - 2 * size], [end, corner, length - size, size],
  ];
  for (const [sy, sh, dy, dh] of spans(height)) {
    for (const [sx, sw, dx, dw] of spans(width)) {
      if (dw > 0 && dh > 0) context.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    }
  }
  context.drawImage(art.tails[side], side === 'left' ? 0 : width - tailWidth, height, tailWidth, scale(tailHeight));
}
