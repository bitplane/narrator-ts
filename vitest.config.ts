import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests read fixtures by repo-relative path.
    root: '.',
  },
})
