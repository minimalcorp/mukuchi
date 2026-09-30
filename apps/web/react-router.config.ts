import type { Config } from "@react-router/dev/config";

// 静的サイト (SST StaticSite) として配信する。`/` だけを事前生成し、出力は build/client
export default {
  ssr: false,
  prerender: ["/"],
} satisfies Config;
