import { webgl2Available } from '../../shared/capabilities.ts'

/**
 * What the app says where it can't draw: without WebGL 2 there is no preview, export, VJ mode, 3D camera, Behind the
 * subject or saved frame. Song analysis, editing and saving still work. The full message shows once per screen (the
 * start and setup screens, the stage, the Export dialog, Settings); elsewhere the short reason.
 */
export const NO_GRAPHICS_FIX =
  'Turn on “Use graphics acceleration when available” at chrome://settings/system (edge://settings/system in Edge), then restart the browser. It may not be available in some virtual machines or remote desktops.'

export const NO_GRAPHICS = `MV Studio needs graphics acceleration (WebGL 2) to preview and export videos. ${NO_GRAPHICS_FIX}`

/** The same, as the reason a control is unavailable. */
export const NO_GRAPHICS_REASON = 'Needs graphics acceleration (WebGL 2), which this browser doesn’t offer'

/** For an Assist tool next to the stage, which shows the full message. */
export const NO_GRAPHICS_TOOL = `${NO_GRAPHICS_REASON}. The preview says how to turn it on.`

/** A toast over the editor short enough to stay clear of the stage; the VJ button's tooltip gives the reason. */
export const NO_GRAPHICS_VJ = 'VJ mode needs graphics acceleration (WebGL 2)'

/** Why drawing is unavailable in this browser, or undefined where it works (for palette actions and tooltips). */
export function graphicsUnavailable(): string | undefined {
  return webgl2Available() ? undefined : NO_GRAPHICS_REASON
}
