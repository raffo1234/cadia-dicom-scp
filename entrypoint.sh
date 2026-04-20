#!/bin/sh
RESOLVED=$(getent hosts ${PROXY_HOST} | awk '{ print $1; exit }')
echo "Resolved ${PROXY_HOST} -> ${RESOLVED}:${PROXY_PORT}"
cat > /etc/proxychains4.conf << CONF
dynamic_chain
localnet 127.0.0.0/255.0.0.0
localnet 10.0.0.0/255.0.0.0
localnet 172.16.0.0/255.240.0.0
localnet 192.168.0.0/255.255.0.0
localnet 104.16.0.0/255.240.0.0
localnet 172.64.0.0/255.248.0.0
localnet 3.0.0.0/255.0.0.0
localnet 52.0.0.0/252.0.0.0
[ProxyList]
socks5 ${RESOLVED} ${PROXY_PORT}
CONF
cat /etc/proxychains4.conf
exec proxychains4 node dist/server.js