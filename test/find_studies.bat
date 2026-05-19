@echo off
:: ==============================================
:: DICOM C-FIND Test - Buscar estudios en Cadia
:: Requiere: DCMTK para Windows
:: ==============================================

set SCP_IP=137.66.1.186
set SCP_PORT=11112
set CALLING_AET=MAGNETON
set CALLED_AET=CADIA.PE

echo.
echo ======================================
echo   DICOM C-FIND - Buscar estudios
echo ======================================
echo.
echo Destino : %SCP_IP%:%SCP_PORT%
echo.

:: Busca todos los estudios (sin filtros)
findscu.exe -v ^
  --aetitle %CALLING_AET% ^
  --call %CALLED_AET% ^
  -S ^
  -k "0008,0052=STUDY" ^
  -k "0020,000D=" ^
  -k "0010,0010=" ^
  -k "0010,0020=" ^
  -k "0008,0020=" ^
  -k "0008,0060=" ^
  -k "0008,1030=" ^
  %SCP_IP% %SCP_PORT%

if %ERRORLEVEL%==0 (
    echo.
    echo [OK] C-FIND completado.
) else (
    echo.
    echo [ERROR] Fallo el C-FIND.
)

pause