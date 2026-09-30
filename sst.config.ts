/* eslint-disable-next-line @typescript-eslint/triple-slash-reference -- SST の雛形どおり (型は `sst install` が生成する) */
/// <reference path="./.sst/platform/config.d.ts" />

// LP (apps/web) を AWS へ公開する。本番のデプロイは .github/workflows/release.yml の手動実行 (target=web。手元からは make web-deploy)。
export default $config({
  app(input) {
    return {
      name: "mukuchi",
      home: "aws",
      removal: input?.stage === "production" ? "retain" : "remove",
      // 手元からの誤った `sst remove --stage production` を防ぐ。撤去は .github/workflows/undeploy-web.yml
      // (確認入力つきの手動実行) が SST_ALLOW_REMOVE=true を渡して行うため、ここを書き換える必要はない
      protect: input?.stage === "production" && process.env.SST_ALLOW_REMOVE !== "true",
    };
  },
  async run() {
    const DOMAIN = "mukuchi.minimalcorp.com";
    const isProduction = $app.stage === "production";

    // minimalcorp.com の Route53 は別の AWS アカウントにあり SST から DNS を操作できないため、dns: false +
    // 事前発行した us-east-1 の ACM 証明書を渡す。ARN は GitHub Environment の変数 (機密ではない)。
    // 初回デプロイ後に出る CloudFront のドメインへの CNAME/ALIAS は別アカウントの Route53 に手動で登録する。
    // 本番以外のステージはドメインを付けず CloudFront のドメインで確認する (同じドメインを取り合わないため)
    const certArn = process.env.MUKUCHI_WEB_CERT_ARN;
    if (isProduction && !certArn) {
      throw new Error(
        "MUKUCHI_WEB_CERT_ARN が未設定: production には us-east-1 の ACM 証明書 ARN が必要 (GitHub Environment production-web の変数)",
      );
    }

    const router = new sst.aws.Router("Router", {
      domain: isProduction ? { name: DOMAIN, dns: false, cert: certArn } : undefined,
    });

    new sst.aws.StaticSite("Web", {
      path: "apps/web",
      build: {
        // SST は build.command を path (apps/web) で実行する。依存の解決を workspace に揃えるためルートから呼ぶ
        command: "cd ../.. && pnpm --filter @mukuchi/web build",
        output: "build/client",
      },
      // errorPage は付けない: Router 配下では CloudFront の customErrorResponses がオリジンを動的に選ぶ
      // CloudFront Function を通らず 502 になる (sst/sst#6848、未解決)。未設定なら一致しないパスに
      // indexPage の内容を 200 で返す SPA フォールバックになる。その対象を React Router が生成する
      // __spa-fallback.html (事前生成したページの中身を含まない) にし、クライアント側で 404 画面へ
      // 水和させる (index.html だとトップページの事前生成 HTML と食い違い、本番で表示が崩れる。tech で確認済み)
      indexPage: "__spa-fallback.html",
      router: { instance: router },
    });

    return { url: router.url };
  },
});
