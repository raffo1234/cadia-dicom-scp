# cadia-dicom-scp

Servidor DICOM SCP (Service Class Provider) para recepción, almacenamiento y sincronización de estudios médicos en entornos multi-hospital.

Construido con TypeScript + Node.js, desplegado en Fly.io, con almacenamiento en Cloudflare R2 y metadatos en Supabase.

---

## Características

- **C-ECHO** — validación de conectividad con AE title y auditoría
- **C-FIND** — consulta de estudios y series desde Supabase
- **C-STORE** — recepción de instancias DICOM, upload a R2 e inserción en Supabase
- **C-MOVE** — reenvío de estudios a destinos registrados (Orthanc, PACS externos)
- **C-GET** — recuperación de estudios desde PACS remotos por la misma conexión
- **Sync Job** — sincronización periódica (C-FIND + C-GET) contra PACS remotos vía proxy SOCKS5

---

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js + TypeScript |
| DICOM | dcmjs-dimse |
| Base de datos | Supabase (PostgreSQL) |
| Almacenamiento | Cloudflare R2 |
| Deploy | Fly.io + Docker |
| Proxy | proxychains4 + SOCKS5 (ngrok tunnel) |

---

## Estructura

```
src/
├── handlers/
│   ├── cecho.ts          # C-ECHO handler
│   ├── cfind.ts          # C-FIND handler (inbound)
│   ├── cfind-scu.ts      # C-FIND SCU (outbound)
│   ├── cstore.ts         # C-STORE handler
│   ├── cmove.ts          # C-MOVE handler (inbound)
│   ├── cmove-scu.ts      # C-MOVE SCU (outbound)
│   ├── cget-scu.ts       # C-GET SCU (outbound, usado por sync job)
│   └── cget.ts           # C-GET standalone (deprecado)
├── lib/
│   ├── supabase.ts
│   ├── r2.ts
│   ├── syncJob.ts        # Sync job periódico
│   ├── hospitalRegistry.ts
│   ├── pendingMoves.ts
│   └── studyCompletion.ts
```

---

## Variables de entorno

```env
SCP_AE_TITLE=CADIA.PE
SCP_PORT=11112
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
STORAGE_DOMAIN=https://storage.cadia.cc
PROXY_HOST=...   # seteado automáticamente por update-proxy.sh
PROXY_PORT=...   # seteado automáticamente por update-proxy.sh
```

---

## Deploy

```bash
fly deploy -a cadia-dicom-scp
```

---

## Proxy SOCKS5 (acceso a PACS remotos)

El sync job usa C-FIND y C-GET para conectarse a PACS externos. Como Fly.io no tiene acceso directo a las redes privadas de los hospitales, se enruta el tráfico a través de un túnel SOCKS5 (proxychains4) desde tu máquina local vía ngrok.

Ver instrucciones completas de setup para macOS y Windows en:
**[raffo1234/3proxy](https://github.com/raffo1234/3proxy)**

---

## Base de datos

Tablas principales en Supabase:

| Tabla | Descripción |
|-------|-------------|
| `hospital` | Hospitales registrados |
| `hospital_access` | AE titles de modalidades/scanners por hospital |
| `ae_route` | PACS remotos con host/port para C-FIND y C-GET |
| `dicom_study` | Estudios recibidos con instancias en JSONB |
| `dicom_audit_log` | Auditoría de operaciones DICOM |