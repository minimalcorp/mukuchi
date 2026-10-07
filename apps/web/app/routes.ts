import { type RouteConfig, index, route } from "@react-router/dev/routes";

// 日本語は `/` (公開時からの URL)、英語は `/en/`。両方を事前生成する (react-router.config.ts)
export default [index("routes/home.tsx"), route("en", "routes/home.en.tsx")] satisfies RouteConfig;
