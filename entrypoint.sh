#!/bin/sh
RESOLVED=$(getent hosts ${PROXY_HOST} | awk '{ print $1; exit }')
echo "Resolved ${PROXY_HOST} -> ${RESOLVED}:${PROXY_PORT}"
cat > /etc/proxychains4.conf << CONF
dynamic_chain
proxy_dns
[ProxyList]
socks5 ${RESOLVED} ${PROXY_PORT}
CONF
cat /etc/proxychains4.conf
exec proxychains4 node dist/server.js
