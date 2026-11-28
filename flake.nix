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
      devShells = forAllSystems (pkgs: let
        # Libraries the Linux desktop client loads at run time rather than links: GPUI's renderer
        # (wgpu → Vulkan), its X11/Wayland clients and keymaps, and WebKitGTK's GL.
        linuxRuntimeLibs = pkgs.lib.optionals pkgs.stdenv.isLinux [
          pkgs.vulkan-loader
          pkgs.libGL
          pkgs.libxkbcommon
          pkgs.wayland
          pkgs.xorg.libX11
          pkgs.xorg.libxcb
          pkgs.xorg.libXcursor
          pkgs.xorg.libXi
          pkgs.xorg.libXrandr
        ];
      in {
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
          # Desktop client (apps/desktop). macOS embeds WKWebView through AppKit and links with the
          # Xcode Command Line Tools; Linux embeds WebKitGTK in an X11 child window.
          ++ [
            (pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml)
            pkgs.sccache
          ]
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux (
            [
              pkgs.stdenv.cc
              pkgs.pkg-config
              pkgs.openssl
              pkgs.fontconfig
              pkgs.freetype
              pkgs.gtk3
              pkgs.webkitgtk_4_1
              pkgs.libsoup_3
              pkgs.glib-networking # TLS for WebKitGTK's network process
            ]
            ++ linuxRuntimeLibs
          );
          RUSTC_WRAPPER = "sccache";
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath linuxRuntimeLibs;
          # WebKitGTK finds glib-networking's TLS module through GIO_EXTRA_MODULES.
          GIO_EXTRA_MODULES = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.glib-networking}/lib/gio/modules";
          shellHook = ''
            [ -f "''${DEVFLOW_HOME:-$HOME/.devflow}/config.json" ] || echo "devflow: run 'bun run devflow setup' first"
          '';
        };
      });
    };
}
