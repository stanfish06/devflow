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

     terraformVersion = "1.17.2";
      terraformReleases = {
        aarch64-darwin = {
          platform = "darwin_arm64";
          sha256 = "da0c7ef278a911347862758e7573a5907365e66485c2637cf5c217c5e227992e";
        };
        x86_64-linux = {
          platform = "linux_amd64";
          sha256 = "e6f16b2f0b137ee5729caa8c4e79a3bae4ee261acd198a1fcfa8584a6296605b";
        };
        aarch64-linux = {
          platform = "linux_arm64";
          sha256 = "858e08c181a76b6b223e8c767a8e983922eebe2d062db949a2de66ce040c368c";
        };
      };

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});

      terraformBin =
        system: pkgs:
        let
          release = terraformReleases.${system};
        in
        pkgs.stdenvNoCC.mkDerivation {
          pname = "terraform-bin";
          version = terraformVersion;
          src = pkgs.fetchurl {
            url = "https://releases.hashicorp.com/terraform/${terraformVersion}/terraform_${terraformVersion}_${release.platform}.zip";
            inherit (release) sha256;
          };
          nativeBuildInputs = [ pkgs.unzip ];
          dontConfigure = true;
          dontBuild = true;
          unpackPhase = "unzip $src";
          # Static Go binary; no patching needed on Linux.
          installPhase = "install -Dm755 terraform $out/bin/terraform";
        };
    in
    {
      packages = forAllSystems (
        system: pkgs: {
          terraform = terraformBin system pkgs;
        }
      );

      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShellNoCC {
            packages = [
              pkgs.bun
              pkgs.nodejs_24
              pkgs.caddy
              pkgs.git
              pkgs.gh
              pkgs.jq
              pkgs.docker-client
              pkgs.docker-compose
              pkgs.awscli2
              pkgs.ssm-session-manager-plugin
              (terraformBin system pkgs)
            ];
            shellHook = ''
              [ -f "''${DEVFLOW_HOME:-$HOME/.devflow}/config.json" ] || echo "devflow: run 'bun run devflow setup' first"
            '';
          };
        }
      );
    };
}
