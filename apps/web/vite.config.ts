import { fileURLToPath } from "node:url";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// desktop (1420) と同時に `make up` で起動するため、重ならない番号に固定する
export const DEV_PORT = 5174;

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  // react-router の Vite プラグインは tsconfig の paths を読まないため、`@/` はここでも定義する
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  // 初回アクセスで lucide-react が見つかると依存の最適化でページが読み直され、開いた直後の操作・テストが空振りするため先に最適化する
  optimizeDeps: {
    include: ["lucide-react"],
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  preview: {
    port: DEV_PORT,
    strictPort: true,
  },
});
