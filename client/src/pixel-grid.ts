/** Snap a follower's gap to its anchor, so camera movement cannot make it shimmer. */
export function snapFollowerX(x: number, anchorX: number, zoom: number): number {
  return (Math.round(anchorX * zoom) + Math.round((x - anchorX) * zoom)) / zoom;
}
