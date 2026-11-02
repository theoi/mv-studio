import { webgl2Available } from '../../shared/capabilities.ts'

/**
 * What the app says where it can't draw: without WebGL 2 there is no preview, export, VJ mode, 3D camera or saved
 * frame. Song analysis, editing and saving still work.
 */
export const NO_GRAPHICS_FIX =
  'Turn on “Use graphics acceleration when available” in your browser’s System settings, then restart the browser. It may not be available in some virtual machines or remote desktops.'

export const NO_GRAPHICS = `MV Studio needs graphics acceleration (WebGL 2) to show and export videos. ${NO_GRAPHICS_FIX}`

/** The same, as the reason a control is unavailable. */
export const NO_GRAPHICS_REASON = 'Needs graphics acceleration (WebGL 2), which this browser doesn’t offer'

/** Why drawing is unavailable in this browser, or undefined where it works (for palette actions and tooltips). */
export function graphicsUnavailable(): string | undefined {
  return webgl2Available() ? undefined : NO_GRAPHICS_REASON
}
