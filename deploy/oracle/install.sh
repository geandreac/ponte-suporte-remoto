#!/usr/bin/env bash
# Instala o servidor do Ponte numa VM Ubuntu (Oracle Cloud Free ou similar).
# Uso (na VM, dentro desta pasta):
#   sudo PONTE_DOMAIN=meuponte.duckdns.org ACME_EMAIL=voce@exemplo.com ./install.sh
# Antes: aponte o domínio para o IP público da VM e libere as portas na Security List da Oracle
# (TCP 80, 443, 3478; UDP 3478, 49160-49200). Veja docs/MIGRACAO-ORACLE.md.
set -euo pipefail
cd "$(dirname "$0")"

: "${PONTE_DOMAIN:?defina PONTE_DOMAIN (ex.: meuponte.duckdns.org)}"
: "${ACME_EMAIL:?defina ACME_EMAIL (aviso de expiração do certificado)}"
[[ "$PONTE_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "PONTE_DOMAIN inválido"; exit 1; }

echo "==> Pacotes (Docker, Compose, iptables-persistent)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2 iptables-persistent openssl dnsutils

echo "==> Firewall da instância (as imagens Ubuntu da Oracle rejeitam tudo além do SSH)"
open_port() { # proto porta
  iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null && return
  local reject
  reject=$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')
  if [[ -n "$reject" ]]; then iptables -I INPUT "$reject" -p "$1" --dport "$2" -j ACCEPT
  else iptables -A INPUT -p "$1" --dport "$2" -j ACCEPT; fi
}
open_port tcp 80
open_port tcp 443
open_port tcp 3478
open_port udp 3478
open_port udp 49160:49200
netfilter-persistent save

echo "==> Segredos (gerados aqui, nunca no repositório)"
if [[ ! -f .env ]]; then
  umask 077
  printf 'PONTE_DOMAIN=%s\nACME_EMAIL=%s\nTURN_SECRET=%s\n' "$PONTE_DOMAIN" "$ACME_EMAIL" "$(openssl rand -hex 32)" > .env
fi
chmod 600 .env
TURN_SECRET=$(grep '^TURN_SECRET=' .env | cut -d= -f2)

PUBLIC_IP=$(dig +short "$PONTE_DOMAIN" A | tail -n1)
PRIVATE_IP=$(hostname -I | awk '{print $1}')
[[ -n "$PUBLIC_IP" ]] || { echo "O domínio $PONTE_DOMAIN ainda não aponta para um IP"; exit 1; }

umask 077
sed -e "s/__TURN_SECRET__/$TURN_SECRET/" -e "s/__PONTE_DOMAIN__/$PONTE_DOMAIN/" \
    -e "s/__PUBLIC_IP__/$PUBLIC_IP/" -e "s/__PRIVATE_IP__/$PRIVATE_IP/" \
    turnserver.conf.template > turnserver.conf
# Contém o segredo do TURN: legível só pelo usuário do contêiner do coturn (nobody, 65534).
chown 65534:65534 turnserver.conf
chmod 600 turnserver.conf

echo "==> Subindo os serviços"
docker compose up -d --build
docker compose ps
echo
echo "Pronto. Teste: curl https://$PONTE_DOMAIN/healthz  (deve responder: ok)"
echo "No app, em Ajustes › Servidor da organização: https://$PONTE_DOMAIN"
