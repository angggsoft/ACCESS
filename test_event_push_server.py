"""
Servidor Webhook Receptor de Eventos Push en Tiempo Real (ISAPI HTTP Listening)
SaaS de Asistencia y Pre-nómina
Tecnologías: FastAPI, Uvicorn, Python-Multipart

Los relojes Hikvision DS-K1T320MFWX-B pueden configurarse para enviar checadas
en tiempo real a este endpoint en formato JSON o multipart/form-data (incluyendo la foto del rostro).
"""

import os
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI(
    title="Hikvision ISAPI Event Receiver - SaaS Pre-nómina",
    description="Receptor de eventos en tiempo real para relojes checadores Hikvision",
    version="1.0.0"
)

# Carpeta para capturas de rostros recibidas en tiempo real
CAPTURES_DIR = Path(__file__).parent / "captures"
CAPTURES_DIR.mkdir(exist_ok=True)


def parse_event_xml(xml_content: str) -> dict:
    """Extrae datos clave del XML de evento enviado por Hikvision."""
    data = {}
    try:
        root = ET.fromstring(xml_content)
        for elem in root.iter():
            tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if elem.text and elem.text.strip():
                data[tag] = elem.text.strip()
    except Exception as e:
        print(f"[!] Error procesando XML: {e}")
    return data


@app.get("/")
def health_check():
    return {
        "status": "online",
        "service": "Hikvision ISAPI Attendance Webhook",
        "description": "Listo para recibir notificaciones Push de terminales biométricos"
    }


@app.post("/ISAPI/Event/notification/alertStream")
@app.post("/event/stream")
@app.post("/api/v1/attendance/events")
async def receive_event(request: Request):
    """
    Endpoint compatible con el protocolo de notificación push / HTTP Listening de Hikvision.
    Soporta application/json y multipart/form-data (con foto del rostro).
    """
    content_type = request.headers.get("Content-Type", "")
    print(f"\n[EVENTO RECIBIDO] Content-Type: {content_type}")

    event_data = {}
    photo_saved = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        for key, value in form.items():
            # Si el campo contiene la metadata del evento (XML o JSON)
            if hasattr(value, "filename") and value.filename:
                # Archivo adjunto (usualmente captura del rostro .jpg)
                content = await value.read()
                filename = f"face_{key}_{os.urandom(4).hex()}.jpg"
                filepath = CAPTURES_DIR / filename
                with open(filepath, "wb") as f:
                    f.write(content)
                photo_saved = str(filepath)
                print(f"  [Foto Capturada] Guardada en: {filepath} ({len(content)} bytes)")
            elif isinstance(value, str):
                if value.strip().startswith("<?xml") or "<EventNotificationAlert" in value:
                    event_data = parse_event_xml(value)
                else:
                    try:
                        event_data = json.loads(value)
                    except Exception:
                        event_data[key] = value

    elif "json" in content_type:
        try:
            event_data = await request.json()
        except Exception as e:
            print(f"[-] Error parseando JSON: {e}")
    else:
        # Contenido crudo (raw XML o texto)
        body = await request.body()
        body_text = body.decode("utf-8", errors="ignore")
        if body_text.strip().startswith("<?xml") or "<EventNotificationAlert" in body_text:
            event_data = parse_event_xml(body_text)
        else:
            event_data = {"raw": body_text}

    # Desglose del evento para SaaS Asistencia / Pre-nómina
    emp_no = event_data.get("employeeNoString") or event_data.get("employeeNo", "Desconocido")
    name = event_data.get("name", "N/A")
    event_time = event_data.get("dateTime") or event_data.get("time", "N/A")
    event_type = event_data.get("eventType") or event_data.get("minor", "N/A")
    verify_mode = event_data.get("currentVerifyMode") or event_data.get("verifyMode", "N/A")
    
    print("=" * 60)
    print(" >>> CHECADA EN TIEMPO REAL REGISTRADA <<<")
    print(f"  • Empleado:       {emp_no} - {name}")
    print(f"  • Fecha y Hora:   {event_time}")
    print(f"  • Modo Verif:     {verify_mode}")
    print(f"  • Tipo de Evento: {event_type}")
    if photo_saved:
        print(f"  • Foto Asistencia: {photo_saved}")
    print("=" * 60)

    # Respuesta estándar requerida por Hikvision
    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={"status": "OK", "message": "Event processed successfully"}
    )


if __name__ == "__main__":
    print("[*] Iniciando servidor Webhook para eventos de checadas Hikvision...")
    print("[*] Escuchando en http://0.0.0.0:8000")
    print("[*] En el reloj Hikvision configura:")
    print("    Network -> Advanced -> HTTP Listening / Event Push")
    print("    Host: Tu IP local (ej: 192.168.11.131)")
    print("    Puerto: 8000")
    print("    URL: /ISAPI/Event/notification/alertStream")
    uvicorn.run(app, host="0.0.0.0", port=8000)
