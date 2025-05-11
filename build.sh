#!/bin/bash
set -e

# Установка Chrome
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
rm google-chrome-stable_current_amd64.deb

# Указываем правильный путь
echo "PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome" >> .env