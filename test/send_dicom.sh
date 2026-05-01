#!/bin/bash
# ==============================================
# DICOM CT Sender - C-STORE via storescu
# Requiere: DCMTK instalado (sudo apt install dcmtk)
# ==============================================

# --- CONFIGURACIÓN ---
SCP_IP="${1:-192.168.1.100}"
SCP_PORT="${2:-4242}"
CALLING_AET="SENDER"
CALLED_AET="STORE_SCP"

# --- SELECCIÓN DE ARCHIVO ---
echo ""
echo "======================================"
echo "  DICOM C-STORE Sender"
echo "======================================"
echo ""

if [ -n "$3" ]; then
    DICOM_FILE="$3"
else
    read -rp "Ruta del archivo DICOM (.dcm): " DICOM_FILE
fi

# Validaciones
if [ ! -f "$DICOM_FILE" ]; then
    echo "[ERROR] Archivo no encontrado: $DICOM_FILE"
    exit 1
fi

if ! command -v storescu &> /dev/null; then
    echo "[ERROR] storescu no está instalado."
    echo "        Instala con: sudo apt install dcmtk"
    exit 1
fi

# --- ENVÍO ---
echo ""
echo "Destino  : $SCP_IP:$SCP_PORT"
echo "Calling  : $CALLING_AET"
echo "Called   : $CALLED_AET"
echo "Archivo  : $DICOM_FILE"
echo ""
echo "Enviando..."

storescu \
    -v \
    --aetitle "$CALLING_AET" \
    --call "$CALLED_AET" \
    "$SCP_IP" "$SCP_PORT" \
    "$DICOM_FILE"

if [ $? -eq 0 ]; then
    echo ""
    echo "[OK] DICOM enviado exitosamente."
else
    echo ""
    echo "[ERROR] Falló el envío. Verifica IP, puerto y AE Titles."
fi