/** The postcard's full width in CSS pixels; its text side is laid out at this size. */
export const cardWidth = 636;
/** The largest the card may be pinched, as a multiple of its full width (80px writing). */
export const maxCardZoom = 2.5;

/**
 * The card's width after two fingers that started `from` pixels apart on a card
 * `start` pixels wide are now `to` apart: never narrower than the `view` (the whole
 * card) or wider than the largest zoom.
 */
export function pinchedWidth(start: number, from: number, to: number, view: number): number {
  return Math.max(view, Math.min(start * to / from, maxCardZoom * cardWidth));
}

/**
 * Scroll offset that keeps the content under `point` (pixels from the view's edge)
 * in place when the content grows from `from` to `to` pixels: a pinch zooms around
 * the fingers, not the corner.
 */
export function scrollAround(scroll: number, point: number, from: number, to: number): number {
  return Math.max(0, (scroll + point) * to / from - point);
}
