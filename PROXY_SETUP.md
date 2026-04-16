# Proxy SOCKS5 via ngrok + Fly.io

## Operación diaria

```bash
# Terminal 1
microsocks -p 1080

# Terminal 2
ngrok tcp 1080

# Terminal 3 (una vez por sesión)
~/update-proxy.sh
```

## Verificación

```bash
fly ssh console -a cadia-dicom-scp --select
proxychains4 echoscu -aet RADIANT -aec DLQ_GRAU 170.0.83.100 2104 -v
```
