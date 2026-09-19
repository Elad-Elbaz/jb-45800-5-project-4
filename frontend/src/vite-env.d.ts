/// <reference types="vite/client" />

/**
 * Vite's own ImportMetaEnv carries an index signature, which makes every
 * custom variable `any`. Declaring the one this app reads restores the type,
 * and makes a typo in the name a compile error rather than `undefined` at
 * runtime.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
