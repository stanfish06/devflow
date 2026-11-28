{
  description = "devflow dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  # Rust toolchain for apps/desktop, pinned in rust-toolchain.toml.
  inputs.rust-overlay = {
    url = "github:oxalica/rust-overlay";
    inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    { nixpkgs, rust-overlay, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ rust-overlay.overlays.default ];
            }
          )
        );
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.bun
            pkgs.nodejs_24
            pkgs.caddy
            pkgs.git
            pkgs.gh
            pkgs.jq
            pkgs.lsof
            pkgs.nssTools
            pkgs.openssh
            pkgs.docker-client
            pkgs.docker-compose
            # Agent VMs for projects whose sandbox is `vm` (apps/agent-runner/src/devflow/vm-sandbox.ts).
            pkgs.lima
          ]
          # Desktop client (apps/desktop): macOS only (WKWebView, AppKit); links with the Xcode
          # Command Line Tools.
          ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            (pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml)
            pkgs.sccache
          ];
          RUSTC_WRAPPER = if pkgs.stdenv.isDarwin then "sccache" else "";
          shellHook = ''
            [ -f "''${DEVFLOW_HOME:-$HOME/.devflow}/config.json" ] || echo "devflow: run 'bun run devflow setup' first"
          '';
        };
      });
    };
}
