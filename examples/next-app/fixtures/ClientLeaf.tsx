'use client'

import { useState } from 'react'

// Fixture, Next only: the client component `ServerOwner` owns. It holds state so
// that it really is a client component, and its element is what a Pick points
// at.
export function ClientLeaf({ label }: { label: string }) {
  const [pressed, setPressed] = useState(0)
  return (
    <p>
      <button
        type="button"
        data-fixture="client-leaf"
        onClick={() => setPressed(pressed + 1)}
      >
        {label} Pressed {pressed} times.
      </button>
    </p>
  )
}
