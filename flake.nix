{
  description = "devflow dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
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
          ];
          shellHook = ''
            [ -f "''${DEVFLOW_HOME:-$HOME/.devflow}/config.json" ] || echo "devflow: run 'bun run devflow setup' first"
          '';
        };
      });
    };
}
