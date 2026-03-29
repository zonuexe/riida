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
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            cargo
            clippy
            nodejs_22
            pkg-config
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
          };

          shellHook = ''
            export PROJECT_ROOT="$PWD"
            export DATABASE_URL="sqlite:$PROJECT_ROOT/data/app.db"

            mkdir -p "$PROJECT_ROOT/.cargo"
            mkdir -p "$PROJECT_ROOT/data"

            echo
            echo "riida development shell"
            echo "  Rust : $(rustc --version)"
            echo "  Cargo: $(cargo --version)"
            echo "  Node : $(node --version)"
            echo
            echo "Next steps:"
            echo "  1. cargo install create-tauri-app"
            echo "  2. npm create tauri-app@latest"
            echo "  3. sqlite3 data/app.db '.databases'"
            echo
          '';
        };
      });
}
