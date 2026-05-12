#!/bin/bash

# Mighty Agent — systemd service installer
# Run with: sudo bash setup-service.sh

set -e

SERVICE_NAME="mighty-agent"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
WORKING_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
RUN_USER="${SUDO_USER:-$USER}"

echo "📋 Installing systemd service: ${SERVICE_NAME}"
echo "   Working dir: ${WORKING_DIR}"
echo "   Node:        ${NODE_BIN}"
echo "   User:        ${RUN_USER}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Mighty Agent — Telegram AI Agent
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${WORKING_DIR}
ExecStart=${NODE_BIN} src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

echo ""
echo "✅ Service installed and started!"
echo ""
echo "  Useful commands:"
echo "    sudo systemctl status ${SERVICE_NAME}   # check status"
echo "    sudo journalctl -u ${SERVICE_NAME} -f   # live logs"
echo "    sudo systemctl restart ${SERVICE_NAME}   # restart"
echo "    sudo systemctl stop ${SERVICE_NAME}      # stop"
echo "    sudo systemctl disable ${SERVICE_NAME}   # disable auto-start"
