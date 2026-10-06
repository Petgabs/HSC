// Layout mode follows the available CSS viewport, not browser user-agent text.
// This handles iPadOS desktop-mode Safari, split view, rotation, and resizes.
export const INTERFACE_BREAKPOINTS = Object.freeze({ phoneMax: 640, tabletMax: 1280 });

export function interfaceModeForViewport(width) {
  const viewportWidth = Number(width);
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 'desktop';
  if (viewportWidth < INTERFACE_BREAKPOINTS.phoneMax) return 'phone';
  if (viewportWidth < INTERFACE_BREAKPOINTS.tabletMax) return 'tablet';
  return 'desktop';
}
