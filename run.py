import uvicorn

if __name__ == "__main__":
    print("=" * 68)
    print("  ACCESS - Sistema de Asistencia Biometrica y Pre-Nomina")
    print("  Interfaz Web: http://localhost:8000/login")
    print("  Panel Directo: http://localhost:8000/dashboard")
    print("  Webhook ISAPI: http://0.0.0.0:8000/api/v1/webhooks/hikvision")
    print("=" * 68)
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False, log_level="info")
