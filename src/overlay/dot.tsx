// The status dot (docs/overlay-design.md): 8 px across, in the colour of a
// session's health in the Target row and the Session list, and of a submitted
// Pick's in its minimized Panel, where it is the traffic light.

import { partProps } from './root.js'
import type { Light } from './words.js'

/**
 * Green, amber, red, or red and steady; grey when there is no light to show,
 * which is the colour that claims nothing. The dot is never the only signal,
 * so it is hidden from what reads the page aloud: the word beside it, or the
 * title of the light it sits in, says the same.
 */
export function Dot({ light }: { light: Light | null }) {
  return (
    <span {...partProps('dot')} data-status={light ?? undefined} aria-hidden="true" />
  )
}
