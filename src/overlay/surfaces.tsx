// The Overlay's three standing surfaces — Picker, Panel and Stack — as one React
// tree in the shadow root (spec §3, §7, §8; ADR-0004). The controller in
// `overlay.ts` owns the state that decides what is on screen and pushes it down
// as props on every change; each surface keeps only what is its own — the Note
// being written, the chip words last polled. The Highlight is not here: it is
// placed by hand on every pointer move, and stays imperative.

import { createRoot } from 'react-dom/client'
import { Panel } from './panel.js'
import type { PanelProps } from './panel.js'
import { Picker } from './picker.js'
import type { PickerProps } from './picker.js'
import { part } from './root.js'
import { Stack } from './stack.js'
import type { StackProps } from './stack.js'

export interface SurfacesProps {
  picker: PickerProps
  /**
   * Null while no Pick is open. The key changes with every new Pick, so a new
   * Pick is a new Panel with an empty Note, and a moved Pick is the same Panel
   * re-anchored with the Note it already holds (spec §7).
   */
  panel: { key: string; props: PanelProps } | null
  stack: StackProps
}

export interface Surfaces {
  render(props: SurfacesProps): void
}

/**
 * Mount the tree once. The container is a plain block in the shadow root; every
 * surface inside it is fixed-position, so the container has no layout of its
 * own and takes no pointer, like the host it inherits that from.
 */
export function mountSurfaces(document: Document, shadow: ShadowRoot): Surfaces {
  const container = part(document, 'div', 'surfaces')
  shadow.append(container)
  const root = createRoot(container)
  return {
    render(props) {
      root.render(<SurfacesView {...props} />)
    },
  }
}

// Paint order is DOM order inside the host: the Stack's resting boxes first, so
// nothing draws over a Panel; the Panel last, so it is above the Picker too.
function SurfacesView({ picker, panel, stack }: SurfacesProps) {
  return (
    <>
      <Stack {...stack} />
      <Picker {...picker} />
      {panel && <Panel key={panel.key} {...panel.props} />}
    </>
  )
}
