import os
from pathlib import Path
from dotenv import load_dotenv

# Cargar variables de entorno desde .env en la raíz del proyecto
env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

# ==========================================
# MODO DE EJECUCIÓN Y BASE DE DATOS (LOCAL / RAILWAY)
# ==========================================
RAW_DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if RAW_DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = RAW_DATABASE_URL.replace("postgres://", "postgresql://", 1)
else:
    DATABASE_URL = RAW_DATABASE_URL

IS_POSTGRES = DATABASE_URL.startswith("postgresql://")
PORT = int(os.getenv("PORT", "8080"))
ENV_MODE = os.getenv("ENV_MODE", "production" if IS_POSTGRES else "local")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")

# Ventana de renovación para Clave Dinámica de Invitación a Empresas (5 minutos = 300s)
TOTP_WINDOW_SECONDS = int(os.getenv("TOTP_WINDOW_SECONDS", "300"))
SECRET_KEY = os.getenv("SECRET_KEY", "access-cloud-totp-secret-key-2026-quodo")

# Terminal Hikvision ISAPI (Valores semilla opcionales)
HIK_HOST = os.getenv("HIK_HOST", "192.168.11.71")
HIK_PORT = int(os.getenv("HIK_PORT", "80"))
HIK_USER = os.getenv("HIK_USER", "admin")
HIK_PASS = os.getenv("HIK_PASS", "")

BASE_URL = f"http://{HIK_HOST}:{HIK_PORT}" if HIK_PORT != 80 else f"http://{HIK_HOST}"

# Credenciales de Red Wi-Fi (Etiqueta informativa)
WIFI_SSID = os.getenv("WIFI_SSID", "")
WIFI_PASS = os.getenv("WIFI_PASS", "")

# Configuración SMTP (Opcional - Notificaciones y Reportes)
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")
SMTP_SENDER_NAME = os.getenv("SMTP_SENDER_NAME", "ACCESS - Control Biométrico")
SMTP_DEFAULT_RECIPIENT = os.getenv("SMTP_DEFAULT_RECIPIENT", "")
