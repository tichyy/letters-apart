/** Round a world coordinate to the nearest screen pixel at this zoom. */
export function snapToGrid(value: number, zoom: number): number {
  return Math.round(value * zoom) / zoom;
}

/**
 * Where to draw a follower on the zoomed pixel grid.
 * While it moves with its anchor, snap the gap between them, so camera movement
 * cannot make a steady gap shimmer. While it stands still, snap its own position:
 * snapping the gap would tie it to the anchor's rounding, and an anchor moving
 * around a still follower would shift it by a pixel back and forth.
 */
export function snapFollowerX(x: number, anchorX: number, zoom: number, still = false): number {
  if (still) return snapToGrid(x, zoom);
  return (Math.round(anchorX * zoom) + Math.round((x - anchorX) * zoom)) / zoom;
}
