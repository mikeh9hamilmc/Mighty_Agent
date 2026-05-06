#!/bin/bash

# Mighty Agent - WSL Setup Script
# This script installs Node.js, Python dependencies, and configures the agent.

set -e

echo "🚀 Starting Mighty Agent installation for WSL..."

# 1. Update and install basic dependencies
echo "📦 Updating system packages..."
sudo apt update && sudo apt install -y curl python3 python3-pip python3-venv git

# 2. Install Node.js if not present or too old
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 18 ]; then
    echo "🟢 Installing Node.js 18 (LTS)..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "✅ Node.js $(node -v) is already installed."
fi

# 3. Install Node.js dependencies
echo "🛠  Installing NPM dependencies..."
npm install

# 4. Setup Python Virtual Environment
echo "🐍 Setting up Python Virtual Environment..."
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

# 5. Install Python dependencies
echo "📦 Installing Python packages..."
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# 6. Setup Playwright (for weather skill)
echo "🎭 Installing Playwright browsers..."
./venv/bin/playwright install --with-deps chromium

# 7. Configure .env
if [ ! -f ".env" ]; then
    echo "📝 Creating .env from .env.example..."
    cp .env.example .env
    # Set PYTHON_CMD to the venv python by default
    sed -i "s|PYTHON_CMD=python|PYTHON_CMD=$(pwd)/venv/bin/python|g" .env
    echo "⚠️  Action Required: Please edit the .env file with your API keys and User ID."
else
    echo "✅ .env file already exists."
fi

echo ""
echo "🎉 Installation complete!"
echo "-------------------------------------------------------"
echo "1. Edit your .env file: nano .env"
echo "2. Start the agent: npm start"
echo "-------------------------------------------------------"
