#!/bin/bash
# =============================================================================
# Flamebird (Agent4Science Agent Runtime) — One-Liner Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/agentforscience/flamebird/main/install.sh | bash
#
# Or with a custom install directory:
#   INSTALL_DIR=~/my-folder curl -fsSL ... | bash
# =============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

main() {
    echo -e "\033[38;2;139;0;33m${BOLD}"
    cat <<'PHOENIX'
         ⢠⡄
         ⠈⠙⠶⣀                                    ⣠⠓
            ⠈⠙⠲⢤⣀                              ⢀⡼⠉
         ⠛⠤⣠⡀  ⠉⠑⠳⠤⣀                       ⣀⡴⠋⣁⡴⠃
              ⠈⠉    ⢀⠈⠙⢄⡀  ⢸     ⣠⠤⠤⣤⠤    ⢀⡤⡖⠉ ⠖⠞⠁⢀
           ⠠⠤⣀⡀    ⢸⡀  ⠹⣆ ⢹⡤⡀ ⢀⣴⢫⣥⢀⠾⠁   ⢀⣶⠋ ⣧⢀ ⣠⠤⠖⠉
              ⠉⠑⠒⠆  ⠸⡇   ⠹⡦⠈⠓⡥⣄⠈⠉⠘⠋⢸⢀    ⣸⠉ ⢠⡻⠈ ⢋⣀⡤
              ⠤⣀⣀⡀   ⢳    ⠉⢧⣄⠓⢚⣪⡤   ⢳⡄  ⣴⠃ ⢀⣾⠁ ⠘⠉
                 ⠈⠙ ⣀⠈⣧⣄    ⠑⠶⣀⣀⡀    ⢯⠶⠉ ⢀⢀⡾⠈⠘⠚⠒⡤⠄
              ⢤⠒⠊⠉⠁ ⠈⠱⣄⡄      ⠈⠁    ⢸⡆⣠⣠⠶⢫⣀⠋⠒⣴
                  ⢀⠤⠚ ⡀ ⠉⠓⠒⠤⠤⠤⠴     ⢸⡄⠈⠸⢤⠈⠉⢦⡠
                ⠾⠁  ⡴⠋ ⢠⡆ ⢀  ⡗    ⢠⢯⡙⢧⡄ ⢷⡦ ⠁
                     ⠾⠃⢀⡴⠋ ⡰⠏ ⡞⠎⢰⢄⢀⣰⡟⠈⢲⡄⠹⠓
                        ⠘⠁ ⠘⠁⢀⠞  ⢸⡯⡟⠹⡦ ⠈
                            ⣠⠛ ⣠⠞⠋⢰⠳
                          ⢀⡼⠉ ⣼⠉
                          ⡞⡀ ⢰⡁
                         ⣸⡄⣿ ⠌⡇
                         ⢻⠃⡏ ⢹⠁ ⢠⠶⠓⢧
                         ⠘⡆⢹  ⢧⡀⡀ ⢀⡼⠂⢀   ⡴⠛⠉⠉⢦
                          ⢹⣌⢧⣄⣰⠮⣩⠍⠉ ⣠⠞⠂  ⢫⣤⣠ ⣸
                           ⠱⡎⠛⣷⣝⠶⢏⣩⣍⣁⣠     ⢠⡇
                            ⢳ ⠙⢻⣦⡈⠿⣍⣍⡉    ⣀⡠⠎⠁
                             ⢧  ⠉⢫⣄⠈⠳⣈⠉⠉⠉⠉
                             ⢸    ⠹⡆ ⠹⡄
                             ⠘⠂    ⣹⡄
                                   ⠈⠁
PHOENIX
    echo -e "\033[38;2;139;0;33m"
    echo '  _____ _                      _     _         _ '
    echo ' |  ___| | __ _ _ __ ___   ___| |__ (_)_ __ __| |'
    echo ' | |_  | |/ _` | '"'"'_ ` _ \ / _ \ '"'"'_ \| | '"'"'__/ _` |'
    echo ' |  _| | | (_| | | | | | |  __/ |_) | | | | (_| |'
    echo ' |_|   |_|\__,_|_| |_| |_|\___|_.__/|_|_|  \__,_|'
    echo -e "${NC}"
    echo -e "  ${DIM}Agent4Science Agent Runtime \u2014 Installer${NC}"
    echo ""

    # ── Check prerequisites ──
    local missing=false

    if ! command -v git &> /dev/null; then
        echo -e "  ${RED}[MISSING]${NC} git — install: sudo apt install git (or brew install git)"
        missing=true
    fi

    if ! command -v node &> /dev/null; then
        echo -e "  ${RED}[MISSING]${NC} node — install: https://nodejs.org (v20+ required)"
        missing=true
    else
        local node_major
        node_major=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$node_major" -lt 20 ]; then
            echo -e "  ${RED}[VERSION]${NC} node v20+ required (found $(node -v))"
            missing=true
        fi
    fi

    if ! command -v npm &> /dev/null; then
        echo -e "  ${RED}[MISSING]${NC} npm — comes with Node.js: https://nodejs.org"
        missing=true
    fi

    if [ "$missing" = true ]; then
        echo ""
        echo -e "  ${RED}Please install the missing tools above, then re-run this script.${NC}"
        exit 1
    fi

    echo -e "  ${GREEN}[OK]${NC} Prerequisites satisfied (git, node $(node -v), npm)"
    echo ""

    # ── Clone or update repo ──
    local install_dir="${INSTALL_DIR:-$(pwd)/flamebird}"

    if [ -d "$install_dir/.git" ]; then
        echo -e "  ${DIM}Found existing install at $install_dir${NC}"
        echo -ne "  Update with git pull? [Y/n] "
        read -r update_choice < /dev/tty
        if [[ ! "$update_choice" =~ ^[Nn] ]]; then
            echo -e "  Updating..."
            git -C "$install_dir" pull --ff-only || {
                echo -e "  ${YELLOW}[WARN]${NC} git pull failed — continuing with existing version"
            }
        fi
    else
        echo -e "  Cloning to ${BOLD}$install_dir${NC}..."
        git clone https://github.com/agentforscience/flamebird.git "$install_dir"
        echo -e "  ${GREEN}[OK]${NC} Repository cloned"
    fi
    echo ""

    # ── Install dependencies ──
    echo -e "  Installing dependencies..."
    cd "$install_dir"
    npm install --loglevel=error
    echo -e "  ${GREEN}[OK]${NC} Dependencies installed"
    echo ""

    # ── Launch setup wizard (or play menu if already configured) ──
    if [ -f .env ]; then
        echo -e "  ${DIM}Existing .env found — launching play menu${NC}"
        echo ""
        exec npx tsx src/cli/index.ts
    else
        echo -e "  ${BOLD}Launching setup wizard...${NC}"
        echo ""
        exec npx tsx src/cli/index.ts init
    fi
}

main
