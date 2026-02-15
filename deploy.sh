#!/bin/bash
# Oracle Cloud 서버 초기 설정 스크립트
# 사용법: ssh로 서버 접속 후 이 스크립트 실행

set -e

echo "=== 트레이딩 봇 서버 설정 ==="

# 1. 시스템 업데이트
echo "[1/5] 시스템 업데이트..."
sudo apt update && sudo apt upgrade -y

# 2. Node.js 20 설치
echo "[2/5] Node.js 설치..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. PM2 설치
echo "[3/5] PM2 설치..."
sudo npm install -g pm2

# 4. 방화벽 포트 열기
echo "[4/5] 방화벽 포트 열기 (3737)..."
sudo iptables -I INPUT -p tcp --dport 3737 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true

# 5. 봇 설정
echo "[5/5] 봇 의존성 설치..."
cd ~/trading-bot
npm install

echo ""
echo "=== 설정 완료! ==="
echo ""
echo "다음 단계:"
echo "  1. .env 파일에 API 키 설정:"
echo "     nano ~/trading-bot/.env"
echo ""
echo "  2. PM2로 봇 시작:"
echo "     cd ~/trading-bot && pm2 start ecosystem.config.js"
echo ""
echo "  3. PM2 자동시작 등록:"
echo "     pm2 startup && pm2 save"
echo ""
echo "  4. 대시보드 접속:"
echo "     http://<서버IP>:3737"
echo ""
echo "  5. 업비트 API에 서버 IP 등록:"
MYIP=$(curl -s https://api.ipify.org)
echo "     서버 IP: $MYIP"
echo ""
