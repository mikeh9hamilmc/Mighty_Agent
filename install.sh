#!/bin/bash

# Mighty Agent — Fresh Ubuntu Setup Script
# Run this from inside the cloned repo directory.

set -e

echo "🚀 Starting Mighty Agent installation..."

# ─── 1. System Dependencies ─────────────────────────────────────────────────
echo "📦 Updating system packages..."
sudo apt update && sudo apt install -y \
  curl git python3 python3-pip python3-venv \
  poppler-utils pandoc

# ─── 2. Node.js (v20 LTS) ───────────────────────────────────────────────────
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
  echo "🟢 Installing Node.js 20 (LTS)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
else
  echo "✅ Node.js $(node -v) already installed."
fi

# ─── 3. NPM Dependencies ────────────────────────────────────────────────────
echo "🛠  Installing NPM packages..."
npm install

# ─── 4. Python Virtual Environment ──────────────────────────────────────────
echo "🐍 Setting up Python virtual environment..."
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

# ─── 5. Playwright browsers ─────────────────────────────────────────────────
echo "🎭 Installing Playwright browsers (weather + music skills)..."
./.venv/bin/playwright install --with-deps chromium

# ─── 6. browser-use Playwright setup ────────────────────────────────────────
echo "🌐 Installing browser-use Playwright driver..."
./.venv/bin/python -m playwright install chromium

# ─── 6. Create .env from template ───────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo "📝 Creating .env from .env.example..."
  cp .env.example .env
  # Point PYTHON_CMD to the venv python
  sed -i "s|PYTHON_CMD=python|PYTHON_CMD=$(pwd)/.venv/bin/python|g" .env
  echo ""
  echo "⚠️  ACTION REQUIRED: Edit .env with your API keys!"
  echo "   nano .env"
else
  echo "✅ .env already exists."
fi

# ─── 7. Create logs directory ────────────────────────────────────────────────
mkdir -p logs

# ─── 8. Setup systemd service (optional) ────────────────────────────────────
echo ""
echo "🎉 Installation complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit your .env file:"
echo "     nano .env"
echo ""
echo "  2. Test it:"
echo "     npm start"
echo ""
echo "  3. (Optional) Install as a system service:"
echo "     sudo bash setup-service.sh"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
