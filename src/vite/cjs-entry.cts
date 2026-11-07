'use strict'

// pointout is ESM-only (spec §1). This file exists so a consumer
// whose Vite config loads as CommonJS is told what to do, rather than shown
// Node's stock ERR_REQUIRE_ESM message.

throw new Error(
  [
    'pointout is ESM-only and cannot be require()d.',
    '',
    'Your Vite config is being loaded as CommonJS. Either make the config ESM',
    '(rename it to vite.config.mjs, or set "type": "module" in package.json),',
    'or keep the CommonJS config and load the plugin with a dynamic import()',
    'from an async config factory:',
    '',
    '    const { defineConfig } = require("vite")',
    '',
    '    module.exports = defineConfig(async () => {',
    '      const { pointout } = await import("@gunnarsturla/pointout/vite")',
    '      return { plugins: [pointout()] }',
    '    })',
    '',
    'defineConfig(async () => …) is what makes the dynamic import() possible:',
    'Vite awaits the returned config, so the plugin can be imported at runtime.',
  ].join('\n'),
)
