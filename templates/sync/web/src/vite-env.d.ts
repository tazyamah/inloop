/// <reference types="vite/client" />

/** ビルドごとの識別子（vite.config.ts の define）。 */
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** 同期の中継のURL（wss://…）。なければ、同期は使えない。 */
  readonly VITE_SYNC_URL?: string;
}
