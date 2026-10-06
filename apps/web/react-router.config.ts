import type { Config } from "@react-router/dev/config";

// 静的サイト (SST StaticSite) として配信する。各言語のページ (`/`・`/en`) を事前生成し、出力は build/client
// (`/en` は build/client/en/index.html。SST の Router は `/en`・`/en/` をどちらもこれに解決する)
export default {
  ssr: false,
  prerender: ["/", "/en"],
} satisfies Config;
