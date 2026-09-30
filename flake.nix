{
  description = "mukuchi dev environment (macOS / Apple Silicon)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, rust-overlay, ... }:
    let
      # MLX が Apple Silicon 専用のため aarch64-darwin のみ対象
      system = "aarch64-darwin";
      pkgs = import nixpkgs {
        inherit system;
        overlays = [ rust-overlay.overlays.default ];
      };
      rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

      # darwin stdenv は nixpkgs の libiconv を伝播させるため、そのままでは Rust std の -liconv が
      # /nix/store/...libiconv.2.dylib にリンクされ、配布した .app が他のMacで起動しない。
      # install-name を OS の /usr/lib/libiconv.2.dylib にした .tbd スタブを先に見つけさせて回避する。
      # (シンボルは nixpkgs libiconv (Apple の libiconv ソース) の公開シンボルから生成)
      systemIconvStub = pkgs.runCommandCC "libiconv-system-stub" { } ''
        mkdir -p $out/lib
        syms=$(nm -gUj ${pkgs.libiconv}/lib/libiconv.2.dylib | paste -sd, - | sed 's/,/, /g')
        cat > $out/lib/libiconv.tbd <<EOF
        --- !tapi-tbd
        tbd-version: 4
        targets: [ arm64-macos ]
        install-name: '/usr/lib/libiconv.2.dylib'
        current-version: 7
        compatibility-version: 7
        exports:
          - targets: [ arm64-macos ]
            symbols: [ $syms ]
        ...
        EOF
      '';
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        # stdenv の既定 apple-sdk (nixpkgs の SDK) を使う。
        # DEVELOPER_DIR をホスト Xcode に向けると Xcode 27 でリンクが壊れるため設定しない (no-phux/phux#763)
        packages = [
          rust
          pkgs.nodejs_24
          # JS/TS の依存は pnpm workspace で管理する。ルート package.json の packageManager をこの版に揃える
          # (違う版だと pnpm が指定の版を取りに行くため)
          pkgs.pnpm
          pkgs.uv
          pkgs.python312
          pkgs.process-compose
          # /usr/bin/make は DEVELOPER_DIR(nixpkgs SDK) から gnumake を探して失敗するため同梱する
          pkgs.gnumake
        ];

        # stdenv が入れる nixpkgs libiconv の -L をスタブに差し替える
        # (-L の追加だけでは cc-wrapper の引数順で nixpkgs 側が先に見つかるため置換する)
        # (devShell では host/build 両ロールの flags が cc-wrapper に渡るため両方を置換する)
        shellHook = ''
          for _var in NIX_LDFLAGS NIX_LDFLAGS_FOR_BUILD; do
            _ldflags=""
            for f in ''${!_var-}; do
              [ "$f" = "-L${pkgs.lib.getLib pkgs.libiconv}/lib" ] && f="-L${systemIconvStub}/lib"
              _ldflags="$_ldflags $f"
            done
            export "$_var=$_ldflags"
          done
          unset _var _ldflags f
        '';
      };
    };
}
