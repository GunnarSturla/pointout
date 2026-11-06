// Fixture: everything an Excerpt can be lifted from, and the two things that
// must never be lifted at all (spec §13, ticket 07).
//
// Nothing here contains an angle bracket or an ampersand, on purpose: a browser-suite
// journey reads the whole delivered body and asserts that none appears in it,
// which is how *no selector path and no source snippet* is observed.

import { useState } from 'react'

/**
 * Exactly 200 characters, so the 80-character cap on rendered text can be read
 * off the payload rather than guessed at. One space between words and none at
 * either end, so collapsing the whitespace changes nothing.
 */
const PROSE = `${'rendered text the excerpt cuts down to eighty characters. '.repeat(4).slice(0, 199)}x`

/** 1,500 characters, against the 1,000-character cap on a lifted value. */
const LONG_VALUE = 'v'.repeat(1500)

/** Big enough that the whole Pick cannot fit inside the 32 KiB payload cap. */
const HUGE_TITLE = 't'.repeat(40_000)

/** Never travels, in any form. A journey asserts this string is nowhere. */
const SECRET = 'correct-horse-battery-staple'

export function ElementExcerpts() {
  // A field that starts as text and becomes `type="hidden"` while the Panel is
  // open. It is the only way the hidden rule can be exercised through the real
  // gesture: an input of that type is `display: none !important` in all three
  // engines, so the pointer can never reach one.
  const [hidden, setHidden] = useState(false)

  return (
    <section className="fixture" data-fixture="excerpts-section">
      <h2>Excerpts</h2>

      <p
        id="excerpt-prose"
        data-testid="excerpt-prose"
        data-fixture="excerpt-prose"
        role="note"
        aria-label="two hundred characters of rendered text"
        className="c-one c-two c-three c-four c-five"
      >
        {PROSE}
      </p>

      <input
        data-fixture="excerpt-text"
        type="text"
        name="nickname"
        placeholder="what should we call you"
        defaultValue={LONG_VALUE}
        {...(hidden ? { type: 'hidden' } : {})}
      />
      <button type="button" data-fixture="excerpt-hide" onClick={() => setHidden(true)}>
        Hide that field
      </button>

      <input
        data-fixture="excerpt-password"
        type="password"
        name="passphrase"
        defaultValue={SECRET}
      />

      <textarea
        data-fixture="excerpt-textarea"
        name="bio"
        defaultValue="what the textarea holds"
      />

      <select data-fixture="excerpt-select" name="cadence" defaultValue="monthly">
        <option value="daily">Daily</option>
        <option value="monthly">Monthly</option>
      </select>

      <div data-fixture="excerpt-editable" contentEditable suppressContentEditableWarning>
        what the editable region holds
      </div>

      <p data-fixture="excerpt-huge" title={HUGE_TITLE}>
        An element carrying more attribute than the payload cap allows.
      </p>
    </section>
  )
}
