import uvicorn
import config

if __name__ == "__main__":
    engine_label = "PostgreSQL (Cloud Railway)" if config.IS_POSTGRES else "SQLite (Desarrollo Local)"
    print("=" * 72)
    print("  ACCESS — Plataforma Cloud de Asistencia Biométrica y Pre-Nómina")
    print(f"  Motor de Base de Datos: {engine_label}")
    print(f"  Interfaz Web: http://localhost:{config.PORT}/login")
    print(f"  Panel Directo: http://localhost:{config.PORT}/dashboard")
    print(f"  Receptor Push Hikvision: http://0.0.0.0:{config.PORT}/api/v1/webhooks/hikvision/{{token}}")
    print("=" * 72)
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=config.PORT,
        reload=False,
        proxy_headers=True,
        forwarded_allow_ips="*",
        log_level="info"
    )
