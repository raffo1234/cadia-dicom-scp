@echo off
:: ==============================================
:: DICOM C-STORE Sender para Windows
:: Requiere: DCMTK para Windows
:: Descarga: https://dcmtk.org/dcmtk.php.en
:: ==============================================

set SCP_IP=137.66.1.186
set SCP_PORT=11112
set CALLING_AET=MAGNETON
set CALLED_AET=CADIA.PE

echo.
echo ======================================
echo   DICOM C-STORE Sender
echo ======================================
echo.

:: Pedir archivo con dialogo de seleccion
echo Selecciona el archivo DICOM en la ventana emergente...
echo.

for /f "delims=" %%I in ('powershell -command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'DICOM files (*.dcm)|*.dcm|All files (*.*)|*.*'; $f.Title = 'Selecciona archivo DICOM'; $null = $f.ShowDialog(); $f.FileName"') do set DICOM_FILE=%%I

if "%DICOM_FILE%"=="" (
    echo [ERROR] No seleccionaste ningun archivo.
    pause
    exit /b 1
)

echo Destino  : %SCP_IP%:%SCP_PORT%
echo Calling  : %CALLING_AET%
echo Called   : %CALLED_AET%
echo Archivo  : %DICOM_FILE%
echo.
echo Enviando...
echo.

storescu.exe -v --aetitle %CALLING_AET% --call %CALLED_AET% %SCP_IP% %SCP_PORT% "%DICOM_FILE%"

if %ERRORLEVEL%==0 (
    echo.
    echo [OK] DICOM enviado exitosamente.
) else (
    echo.
    echo [ERROR] Fallo el envio. Verifica IP, puerto y AE Titles.
)

pause