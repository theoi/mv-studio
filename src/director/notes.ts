/*
 * Notes the director writes into a plan that the panel may word differently later: a plan is made once, but fal.ai can
 * be connected after it. Kept apart from the planner so the panel can read them without loading the director.
 */

/** The brief asked for AI scenes, but the draft could not generate them: fal.ai is not connected, or My clips was chosen. */
export const NO_AI_SCENES =
  'This draft uses your media or visuals. To generate AI scenes, connect fal.ai in Settings and turn on AI shots.'
