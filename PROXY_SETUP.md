# Proxy SOCKS5 via ngrok + Fly.io

## Setup inicial

```bash
# 1. Mac — tunnel TCP
ngrok tcp 1080

# 2. Mac — actualizar secrets en Fly.io
~/update-proxy.sh

# 3. Deploy
fly deploy -a cadia-dicom-scp
```

## Operación diaria

Cada vez que reinicias ngrok:

```bash
ngrok tcp 1080
~/update-proxy.sh
```

## Verificación

```bash
# Desde el container
fly ssh console -a cadia-dicom-scp --select
proxychains4 echoscu -aet RADIANT -aec DLQ_GRAU 170.0.83.100 2104 -v
```
