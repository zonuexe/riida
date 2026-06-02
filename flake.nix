{
  description = "Development environment for a Tauri-based Rust ebook library app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

      in {
        packages.riida-mcp = pkgs.writeShellApplication {
          name = "riida-mcp";
          runtimeInputs = [ pkgs.nodejs_22 ];
          # dist/index.js is a local build artifact; resolve via $PWD so the
          # script works regardless of where nix stored the derivation.
          text = ''
            exec node "$PWD/mcp-server/dist/index.js"
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            cargo
            cargo-audit
            cargo-llvm-cov
            cargo-machete
            cargo-mutants
            cargo-nextest
            clippy
            nodejs_22
            pkg-config
            python3
            python3Packages.pyyaml
            rust-analyzer
            rustc
            rustfmt
            sqlite
          ];

          buildInputs = with pkgs; [
            openssl
          ];

          env = {
            RUST_BACKTRACE = "1";
            CARGO_TERM_COLOR = "always";
            # cargo-llvm-cov needs llvm-cov/llvm-profdata matching rustc's LLVM
            # version (this toolchain reports LLVM 21.1.8). The rustc wrapper
            # does not ship the llvm-tools-preview component, so point the tools
            # at the matching LLVM build explicitly. Bump this alongside any
            # rustc upgrade that changes the major LLVM version.
            LLVM_COV = "${pkgs.llvmPackages_21.llvm}/bin/llvm-cov";
            LLVM_PROFDATA = "${pkgs.llvmPackages_21.llvm}/bin/llvm-profdata";
          };

          shellHook = ''
            export PROJECT_ROOT="$PWD"

            mkdir -p "$PROJECT_ROOT/.cargo"

            echo
            echo "riida development shell"
            echo "  Rust : $(rustc --version)"
            echo "  Cargo: $(cargo --version)"
            echo "  Node : $(node --version)"
            echo
            echo "Next steps:"
            echo "  1. cargo install create-tauri-app"
            echo "  2. npm create tauri-app@latest"
            echo "  3. npm run tauri dev"
            echo
          '';
        };
      });
}
