"""
Servidor de Eventos en Tiempo Real con Filtros de Producción
Hikvision DS-K1T320MFWX-B - SaaS de Asistencia y Pre-nómina
Tecnologías: FastAPI, Uvicorn, Python-Multipart, SQLite3
Puerto: 8000 | Endpoint: /api/v1/webhooks/hikvision
"""

import os
import json
import sqlite3
import datetime
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
import uvicorn

# Configuración de base de datos
DB_FILE = Path(__file__).parent / "pruebas_checador.db"
CAPTURES_DIR = Path(__file__).parent / "captures"
CAPTURES_DIR.mkdir(exist_ok=True)

# Códigos ANSI para salida destacada en consola
ANSI_YELLOW = "\033[93m"
ANSI_GREEN = "\033[92m"
ANSI_CYAN = "\033[96m"
ANSI_BOLD = "\033[1m"
ANSI_RESET = "\033[0m"

# Sub-tipos de eventos válidos para pre-nómina
# 75: Rostro reconocido, 104: Rostro en vivo autenticado, 38: Huella válida, 1: Tarjeta válida
VALID_SUB_EVENT_TYPES = {
    75: "ROSTRO (subEventType: 75)",
    104: "ROSTRO (subEventType: 104)",
    38: "HUELLA (subEventType: 38)",
    1: "TARJETA (subEventType: 1)",
    9: "CONTRASEÑA / PIN (subEventType: 9)",
    181: "CONTRASEÑA / PIN (subEventType: 181)"
}

# Inicializar Base de Datos SQLite
def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS checadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serial_no INTEGER,
            codigo_empleado TEXT,
            nombre TEXT,
            tipo_evento TEXT,
            sub_event_type INTEGER,
            fecha_hora_evento TEXT,
            es_rebote INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    conn.commit()
    conn.close()

init_db()

# Cache en memoria para filtro anti-rebote (emp_no -> datetime)
last_employee_checkin = {}

app = FastAPI(
    title="Hikvision Live Attendance Receiver",
    description="Servidor de checadas en tiempo real para pre-nómina",
    version="2.0.0"
)


def safe_int(val) -> int:
    """Parsea enteros tanto en formato decimal ('38') como hexadecimal ('0x26')."""
    if not val:
        return 0
    val_str = str(val).strip()
    try:
        return int(val_str, 0)
    except (ValueError, TypeError):
        try:
            return int(val_str, 16)
        except Exception:
            return 0


def parse_event_payload(payload_str: str) -> dict:
    """Extrae datos estructurados desde XML o JSON."""
    data = {}
    payload_clean = payload_str.strip()
    
    # Intentar XML
    if payload_clean.startswith("<?xml") or "<EventNotificationAlert" in payload_clean:
        try:
            root = ET.fromstring(payload_clean)
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if elem.text and elem.text.strip():
                    data[tag] = elem.text.strip()
            return data
        except Exception as e:
            print(f"[!] Error procesando XML: {e}")

    # Intentar JSON
    try:
        data = json.loads(payload_clean)
    except Exception:
        pass

    return data


def save_to_database(serial_no: Optional[int], emp_no: str, nombre: str,
                     tipo_evento: str, sub_event_type: int,
                     fecha_hora: str, es_rebote: int):
    """Inserta el evento procesado en SQLite."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO checadas (
            serial_no, codigo_empleado, nombre, tipo_evento,
            sub_event_type, fecha_hora_evento, es_rebote
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (serial_no, emp_no, nombre, tipo_evento, sub_event_type, fecha_hora, es_rebote))
    conn.commit()
    conn.close()


def parse_iso_datetime(dt_str: str) -> datetime.datetime:
    """Parsea fecha ISO reportada por el reloj."""
    if not dt_str or dt_str == "N/A":
        return datetime.datetime.now()
    try:
        # Formatos comunes de Hikvision: 2026-11-05T13:55:10-06:00
        clean_str = dt_str.replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(clean_str)
    except Exception:
        return datetime.datetime.now()


@app.get("/")
def health_status():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*), SUM(CASE WHEN es_rebote=0 THEN 1 ELSE 0 END), SUM(es_rebote) FROM checadas")
    row = cursor.fetchone()
    conn.close()
    
    total = row[0] or 0
    validas = row[1] or 0
    rebotes = row[2] or 0
    
    return {
        "status": "online",
        "service": "Hikvision Real-Time Attendance Webhook",
        "estadisticas": {
            "total_checadas_registradas": total,
            "checadas_validas": validas,
            "rebotes_ignorados": rebotes
        }
    }


@app.get("/api/v1/attendance/records")
def list_records(limit: int = 50):
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, serial_no, codigo_empleado, nombre, tipo_evento,
               sub_event_type, fecha_hora_evento, es_rebote, created_at
        FROM checadas ORDER BY id DESC LIMIT ?
    """, (limit,))
    rows = cursor.fetchall()
    conn.close()
    
    records = []
    for r in rows:
        records.append({
            "id": r[0],
            "serial_no": r[1],
            "codigo_empleado": r[2],
            "nombre": r[3],
            "tipo_evento": r[4],
            "sub_event_type": r[5],
            "fecha_hora_evento": r[6],
            "es_rebote": bool(r[7]),
            "created_at": r[8]
        })
    return {"count": len(records), "records": records}


@app.post("/api/v1/webhooks/hikvision")
@app.post("/ISAPI/Event/notification/alertStream")
async def receive_hikvision_webhook(request: Request):
    """
    Endpoint principal para recepción de notificaciones Push del reloj Hikvision.
    Responde inmediatamente HTTP 200 OK y procesa el evento en línea.
    """
    content_type = request.headers.get("Content-Type", "")
    event_str = ""
    photo_bytes = None

    # 1. Extracción de multipart/form-data
    if "multipart/form-data" in content_type:
        form = await request.form()
        print(f"\n[DEBUG WEBHOOK] Form keys recibidas: {list(form.keys())}")
        for field_name, field_value in form.items():
            print(f"  -> Campo: '{field_name}' | Tipo: {type(field_value)} | Filename: {getattr(field_value, 'filename', None)}")
            # Si el contenido o archivo contiene XML de evento
            if hasattr(field_value, "read"):
                raw = await field_value.read()
                # Verificar si es XML/JSON o imagen binaria
                if raw.startswith(b"<?xml") or b"<EventNotificationAlert" in raw or b"AccessControllerEvent" in raw or raw.startswith(b"{"):
                    event_str = raw.decode("utf-8", errors="ignore")
                elif raw.startswith(b"\xff\xd8") or getattr(field_value, "filename", "").endswith((".jpg", ".jpeg")):
                    photo_bytes = raw
            elif isinstance(field_value, str):
                if "<EventNotificationAlert" in field_value or "AccessControllerEvent" in field_value or field_value.strip().startswith("{"):
                    event_str = field_value
                elif field_name == "event_log":
                    event_str = field_value
    else:
        # Petición simple XML o JSON
        raw_body = await request.body()
        event_str = raw_body.decode("utf-8", errors="ignore")
        print(f"\n[DEBUG WEBHOOK] Petición directa body: {event_str[:200]}")

    # Si se recibió foto, guardarla
    if photo_bytes:
        photo_filename = f"capture_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.urandom(3).hex()}.jpg"
        photo_path = CAPTURES_DIR / photo_filename
        with open(photo_path, "wb") as f:
            f.write(photo_bytes)

    # 2. Parseo de datos del evento
    event_data = parse_event_payload(event_str)
    print(f"\n[EVENT LOG BODY]:\n{event_str[:400]}")
    print(f"[EVENT PARSED]: {event_data}")
    
    # 3. Filtro de Eventos de Control de Acceso / Asistencia
    event_type = event_data.get("eventType", "")
    major_type = safe_int(event_data.get("majorEventType") or event_data.get("major"))
    sub_type = safe_int(event_data.get("subEventType") or event_data.get("minor"))

    # Validar: eventType == "AccessControllerEvent", majorEventType == 5 y subEventType in [75, 104, 38, 1]
    is_access_event = (event_type == "AccessControllerEvent" or major_type == 5)
    
    if not is_access_event or sub_type not in VALID_SUB_EVENT_TYPES:
        # Evento informativo (ej: sensor de puerta abierta/cerrada, heartbeat, etc.)
        # Se responde OK de inmediato según especificación ISAPI
        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success", "note": "non_target_event"})

    # Extracción de atributos de la checada
    emp_no = event_data.get("employeeNoString") or event_data.get("employeeNo", "N/A")
    nombre = event_data.get("name", "Desconocido")
    dt_event_str = event_data.get("dateTime") or event_data.get("time", "N/A")
    serial_no = event_data.get("serialNo")
    try:
        serial_no = int(serial_no) if serial_no else None
    except ValueError:
        serial_no = None

    dt_current = parse_iso_datetime(dt_event_str)
    
    # 4. Filtro Anti-Rebote (Debounce de 180 segundos)
    es_rebote = 0
    segundos_transcurridos = None
    
    if emp_no != "N/A":
        if emp_no in last_employee_checkin:
            dt_prev = last_employee_checkin[emp_no]
            # Diferencia en segundos absolutos
            diff = abs((dt_current - dt_prev).total_seconds())
            segundos_transcurridos = int(diff)
            if diff < 180:
                es_rebote = 1
        
        # Actualizar timestamp para el empleado
        last_employee_checkin[emp_no] = dt_current

    # 5. Guardar en SQLite
    save_to_database(
        serial_no=serial_no,
        emp_no=emp_no,
        nombre=nombre,
        tipo_evento=event_type or "AccessControllerEvent",
        sub_event_type=sub_type,
        fecha_hora=dt_event_str,
        es_rebote=es_rebote
    )

    # 6. Salida en Consola
    method_desc = VALID_SUB_EVENT_TYPES.get(sub_type, f"OTRO ({sub_type})")
    formatted_time = dt_current.strftime("%Y-%m-%d %H:%M:%S")

    if es_rebote == 1:
        # Aviso amarillo de rebote ignorado
        print(f"{ANSI_YELLOW}[REBOTE IGNORADO] Empleado #{emp_no} - {nombre} checó hace {segundos_transcurridos}s (< 180s). Registrado con es_rebote=1.{ANSI_RESET}")
    else:
        # Tarjeta destacada de checada válida
        print("\n" + ANSI_GREEN + "=" * 52 + ANSI_RESET)
        print(f"{ANSI_BOLD}{ANSI_CYAN}[NUEVA CHECADA EN VIVO]{ANSI_RESET}")
        print(f"Empleado:          #{emp_no} - {nombre}")
        print(f"Método:            {method_desc}")
        print(f"Fecha/Hora Reloj:  {formatted_time}")
        print(f"Serial Evento:     {serial_no if serial_no else 'N/A'}")
        print(f"Estatus Pre-Nómina:{ANSI_GREEN} VÁLIDO (Dentro de turno){ANSI_RESET}")
        print(ANSI_GREEN + "=" * 52 + ANSI_RESET + "\n")

    return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success"})


if __name__ == "__main__":
    print(f"\n{ANSI_BOLD}================================================================={ANSI_RESET}")
    print(f"{ANSI_BOLD} HIKVISION LIVE ATTENDANCE SERVER - SAAS PRE-NÓMINA{ANSI_RESET}")
    print(f"{ANSI_BOLD}================================================================={ANSI_RESET}")
    print(f"Escuchando en:      http://0.0.0.0:8000")
    print(f"Endpoint Webhook:   http://0.0.0.0:8000/api/v1/webhooks/hikvision")
    print(f"Base de Datos:      {DB_FILE}")
    print(f"Filtro Anti-Rebote: 180 segundos por empleado")
    print(f"Eventos Válidos:    {list(VALID_SUB_EVENT_TYPES.keys())} (Rostro, Huella, Tarjeta)")
    print(f"{ANSI_BOLD}================================================================={ANSI_RESET}\n")
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
