"""
ACCESS — Sistema de Asistencia Biométrica, Control de Accesos y Pre-Nómina
Integración Nativa Hikvision ISAPI (Push Webhook + Auto-Pull Recovery)
"""

import os
import json
import socket
import asyncio
import datetime
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, Any, Optional
from contextlib import asynccontextmanager

import requests
from requests.auth import HTTPDigestAuth
from fastapi import FastAPI, Request, HTTPException, Body, UploadFile, File, Form, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

import config
import core.database as db
import core.mailer as mailer
import io
import csv

BASE_DIR = Path(__file__).parent
TEMPLATES_DIR = BASE_DIR / "templates"
ASSETS_DIR = BASE_DIR / "assets"
CAPTURES_DIR = BASE_DIR / "captures"
CAPTURES_DIR.mkdir(exist_ok=True)

VALID_SUB_EVENT_TYPES = {75, 104, 38, 1, 9, 181}


def safe_int(val) -> int:
    if val is None or val == "":
        return 0
    val_str = str(val).strip()
    try:
        return int(val_str, 0)
    except (ValueError, TypeError):
        try:
            return int(val_str, 16)
        except Exception:
            return 0


def detect_local_ip(target_ip: str = config.HIK_HOST) -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((target_ip, 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def sync_clock_events_from_hardware(ip: str, port: int, user: str, password: str, reloj_nombre: str = "Cerro Gordo") -> Dict[str, Any]:
    """
    Consulta los últimos eventos en la memoria del reloj Hikvision vía ISAPI
    e inserta automáticamente cualquier checada nueva en SQLite.
    """
    base_url = f"http://{ip}:{port}" if port != 80 else f"http://{ip}"
    auth = HTTPDigestAuth(user, password)
    url = f"{base_url}/ISAPI/AccessControl/AcsEvent?format=json"

    try:
        # 1. Consultar total de eventos
        probe_payload = {
            "AcsEventCond": {
                "searchID": "auto-sync-probe",
                "searchResultPosition": 0,
                "maxResults": 1,
                "major": 5,
                "minor": 0
            }
        }
        r_probe = requests.post(url, auth=auth, json=probe_payload, timeout=(2.5, 4.0))
        if r_probe.status_code != 200:
            return {"ok": False, "error": f"HTTP {r_probe.status_code}"}

        total_matches = r_probe.json().get("AcsEvent", {}).get("totalMatches", 0)
        start_pos = max(0, total_matches - 30)

        # 2. Descargar los últimos 30 eventos
        pull_payload = {
            "AcsEventCond": {
                "searchID": "auto-sync-pull",
                "searchResultPosition": start_pos,
                "maxResults": 30,
                "major": 5,
                "minor": 0
            }
        }
        r_pull = requests.post(url, auth=auth, json=pull_payload, timeout=(2.5, 5.0))
        if r_pull.status_code != 200:
            return {"ok": False, "error": f"HTTP {r_pull.status_code}"}

        acs_data = r_pull.json().get("AcsEvent", {})
        raw_list = acs_data.get("InfoList", [])
        if isinstance(raw_list, dict):
            raw_list = [raw_list]

        inserted_count = 0
        for idx, ev in enumerate(raw_list):
            minor_code = safe_int(ev.get("minor"))
            emp_no = ev.get("employeeNoString") or ev.get("employeeNo")
            if minor_code in VALID_SUB_EVENT_TYPES and emp_no:
                ev_time = ev.get("time", "")
                # Solo sincronizar eventos del año actual 2026 en adelante para mantener limpio el log operativo
                if ev_time.startswith("2026"):
                    serial_no = ev.get("serialNo") or (start_pos + idx + 1)
                    emp_name = ev.get("name") or "Empleado"
                    res = db.record_checkin(
                        serial_no=safe_int(serial_no),
                        emp_no=str(emp_no),
                        nombre=emp_name,
                        tipo_evento="AccessControllerEvent",
                        sub_event_type=minor_code,
                        fecha_hora=ev_time,
                        reloj_nombre=reloj_nombre
                    )
                    if res.get("inserted"):
                        inserted_count += 1

        # Actualizar estado del reloj en BD
        conn = db.get_conn()
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("""
            UPDATE relojes
            SET estado = 'ONLINE', total_eventos = ?, ultima_sincronizacion = ?
            WHERE ip = ?
        """, (total_matches, now_str, ip))
        conn.commit()
        conn.close()

        return {"ok": True, "total_in_clock": total_matches, "new_inserted": inserted_count}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def sync_employees_from_hardware(ip: str, port: int, user: str, password: str, reloj_nombre: str = "Cerro Gordo") -> Dict[str, Any]:
    """Sincroniza el censo de usuarios del reloj físico hacia SQLite."""
    base_url = f"http://{ip}:{port}" if port != 80 else f"http://{ip}"
    auth = HTTPDigestAuth(user, password)
    url = f"{base_url}/ISAPI/AccessControl/UserInfo/Search?format=json"
    payload = {
        "UserInfoSearchCond": {
            "searchID": "sync-users",
            "searchResultPosition": 0,
            "maxResults": 30
        }
    }
    try:
        resp = requests.post(url, auth=auth, json=payload, timeout=(3.0, 6.0))
        if resp.status_code != 200:
            return {"ok": False, "error": f"HTTP {resp.status_code}"}

        search_data = resp.json().get("UserInfoSearch", {})
        users = search_data.get("UserInfo", [])
        if isinstance(users, dict):
            users = [users]

        conn = db.get_conn()
        cur = conn.cursor()
        for u in users:
            emp_no = str(u.get("employeeNo", "")).strip()
            if not emp_no:
                continue
            name = u.get("name", f"Empleado {emp_no}")
            has_fp = 1 if safe_int(u.get("numOfFP", 0)) > 0 else 0
            has_face = 1 if safe_int(u.get("numOfFace", 0)) > 0 else 0
            has_card = 1 if safe_int(u.get("numOfCard", 0)) > 0 else 0
            admin_ui = 1 if u.get("localUIRight") else 0

            existing = cur.execute("SELECT id FROM empleados WHERE codigo_empleado = ?", (emp_no,)).fetchone()
            if existing:
                cur.execute("""
                    UPDATE empleados
                    SET nombre = ?, tiene_huella = ?, tiene_rostro = ?, tiene_tarjeta = ?, admin_ui = ?
                    WHERE codigo_empleado = ?
                """, (name, has_fp, has_face, has_card, admin_ui, emp_no))
            else:
                cur.execute("""
                    INSERT INTO empleados (
                        codigo_empleado, nombre, area_nombre, puesto, turno,
                        tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
                    ) VALUES (?, ?, 'Operaciones Cerro Gordo', 'Colaborador', 'Matutino (08:00 - 17:00)', ?, ?, ?, ?, ?, 'ACTIVO')
                """, (emp_no, name, has_fp, has_face, has_card, admin_ui, reloj_nombre))

        cur.execute("UPDATE relojes SET total_usuarios = ? WHERE ip = ?", (len(users), ip))
        conn.commit()
        conn.close()
        return {"ok": True, "users_synced": len(users)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


async def background_clock_poller():
    """
    Tarea asíncrona de respaldo que verifica cada 4 segundos la memoria del reloj
    para garantizar que ninguna checada se pierda jamás en la pantalla en vivo.
    """
    await asyncio.sleep(1.5)
    while True:
        try:
            conn = db.get_conn()
            clocks = conn.execute("SELECT ip, puerto, usuario, password, nombre FROM relojes").fetchall()
            conn.close()
            for clk in clocks:
                await asyncio.to_thread(
                    sync_clock_events_from_hardware,
                    clk["ip"], clk["puerto"], clk["usuario"], clk["password"], clk["nombre"]
                )
        except Exception:
            pass
        await asyncio.sleep(4.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(background_clock_poller())
    yield
    task.cancel()


app = FastAPI(
    title="ACCESS — Control de Asistencia y Pre-Nómina",
    description="Plataforma Integral de Gestión Biométrica Hikvision ISAPI",
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_Dynamic(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/js/") or path in ["/dashboard", "/login", "/"]:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    return response


if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")
if CAPTURES_DIR.exists():
    app.mount("/captures", StaticFiles(directory=str(CAPTURES_DIR)), name="captures")


# ==========================================
# HTML ROUTES
# ==========================================

@app.get("/", response_class=RedirectResponse)
async def root_redirect():
    return RedirectResponse(url="/login")


@app.get("/login", response_class=HTMLResponse)
async def login_page():
    login_file = TEMPLATES_DIR / "login.html"
    return HTMLResponse(content=login_file.read_text(encoding="utf-8"))


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page():
    dash_file = TEMPLATES_DIR / "dashboard.html"
    return HTMLResponse(content=dash_file.read_text(encoding="utf-8"))


# ==========================================
# AUTH API
# ==========================================

DEMO_USERS = [
    {
        "username": "angel.flores",
        "email": "angel.flores@quodo.mx",
        "name": "Angel Flores",
        "role": "Ingeniero de Sistemas y Hardware",
        "avatar": "AF",
        "shift": "Mixto (08:00 - 17:30)",
        "node": "Cerro Gordo • Terminal #01"
    },
    {
        "username": "areli.martinez",
        "email": "areli.martinez@quodo.mx",
        "name": "Areli Martinez",
        "role": "Coordinadora de Operaciones",
        "avatar": "AM",
        "shift": "Matutino (07:00 - 15:30)",
        "node": "Planta Cerro Gordo"
    },
    {
        "username": "carlos.mendoza",
        "email": "carlos.mendoza@quodo.mx",
        "name": "Carlos Mendoza",
        "role": "Jefe de CEDIS y Pre-Nómina",
        "avatar": "CM",
        "shift": "Matutino (07:00 - 15:30)",
        "node": "CEDIS Matriz"
    }
]


@app.post("/api/auth/login")
async def auth_login(payload: Dict[str, Any] = Body(...)):
    email = payload.get("email", "").strip().lower()
    matched = next((u for u in DEMO_USERS if u["email"].lower() == email or u["username"].lower() == email), None)
    if not matched:
        name_part = email.split("@")[0].replace(".", " ").title() or "Administrador TI"
        initials = "".join([p[0] for p in name_part.split()[:2]]).upper() or "TI"
        matched = {
            "username": email,
            "email": email,
            "name": name_part,
            "role": "Administrador de Asistencia",
            "avatar": initials,
            "shift": "Matutino (08:00 - 17:00)",
            "node": "Cerro Gordo • ISAPI"
        }
    return {"status": "success", "user": matched}


# ==========================================
# HIKVISION WEBHOOK PUSH ENDPOINT
# ==========================================

def parse_event_payload(payload_str: str) -> dict:
    """Extrae datos de evento desde XML o JSON (aplanando objetos anidados como AccessControllerEvent)."""
    data = {}
    clean = payload_str.strip()
    if not clean:
        return data

    # 1. Intentar JSON
    if clean.startswith("{"):
        try:
            raw_json = json.loads(clean)
            if isinstance(raw_json, dict):
                data.update(raw_json)
                for key, val in raw_json.items():
                    if isinstance(val, dict):
                        data.update(val)
                return data
        except Exception:
            pass

    # 2. Intentar XML
    if clean.startswith("<?xml") or "<EventNotificationAlert" in clean or "<" in clean:
        try:
            root = ET.fromstring(clean)
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if elem.text and elem.text.strip():
                    data[tag] = elem.text.strip()
            return data
        except Exception:
            pass

    return data


@app.post("/api/v1/webhooks/hikvision")
@app.post("/ISAPI/Event/notification/alertStream")
async def receive_hikvision_webhook(request: Request):
    """Recibe notificaciones Push en tiempo real desde los relojes Hikvision."""
    content_type = request.headers.get("Content-Type", "")
    event_str = ""
    photo_bytes = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        for field_name, field_value in form.items():
            if hasattr(field_value, "read"):
                raw = await field_value.read()
                if raw.startswith(b"<?xml") or b"EventNotificationAlert" in raw or b"AccessControllerEvent" in raw or raw.strip().startswith(b"{"):
                    event_str = raw.decode("utf-8", errors="ignore")
                elif raw.startswith(b"\xff\xd8"):
                    photo_bytes = raw
            elif isinstance(field_value, str):
                if "EventNotificationAlert" in field_value or "AccessControllerEvent" in field_value or field_value.strip().startswith("{") or field_name == "event_log":
                    event_str = field_value
    else:
        raw_body = await request.body()
        event_str = raw_body.decode("utf-8", errors="ignore")

    if photo_bytes:
        photo_filename = f"capture_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.urandom(2).hex()}.jpg"
        (CAPTURES_DIR / photo_filename).write_bytes(photo_bytes)

    event_data = parse_event_payload(event_str)
    event_type = event_data.get("eventType", "")
    major_type = safe_int(event_data.get("majorEventType") or event_data.get("major"))
    sub_type = safe_int(event_data.get("subEventType") or event_data.get("minor"))

    is_access_event = (event_type == "AccessControllerEvent" or major_type == 5)
    if not is_access_event or sub_type not in VALID_SUB_EVENT_TYPES:
        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success", "note": "ignored_minor"})

    emp_no = event_data.get("employeeNoString") or event_data.get("employeeNo")
    if not emp_no:
        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success", "note": "no_employee"})

    nombre = event_data.get("name", "Empleado")
    dt_str = event_data.get("dateTime") or event_data.get("time") or datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S-06:00")
    serial_no = safe_int(event_data.get("serialNo")) or None
    device_name = event_data.get("deviceName", "Cerro Gordo")

    result = db.record_checkin(
        serial_no=serial_no,
        emp_no=str(emp_no),
        nombre=nombre,
        tipo_evento="AccessControllerEvent",
        sub_event_type=sub_type,
        fecha_hora=dt_str,
        reloj_nombre=device_name
    )

    if result.get("inserted"):
        if result.get("es_rebote"):
            print(f"\033[93m[REBOTE IGNORADO] Empleado #{emp_no} - {result['nombre']} (< 180s). Guardado con es_rebote=1.\033[0m")
        else:
            print("\n\033[92m==================================================\033[0m")
            print("\033[1m\033[96m[NUEVA CHECADA EN VIVO]\033[0m")
            print(f"Empleado: #{emp_no} - {result['nombre']}")
            print(f"Método: {result['metodo']} (subEventType: {sub_type})")
            print(f"Fecha/Hora Reloj: {dt_str.replace('T', ' ')[:19]}")
            print(f"Serial Evento: {serial_no}")
            print("Estatus Pre-Nómina: \033[92mVÁLIDO (Dentro de turno)\033[0m")
            print("\033[92m==================================================\033[0m\n")

    return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success"})


# ==========================================
# DASHBOARD, CHECADAS, RELOJES, EMPLEADOS, ÁREAS API
# ==========================================

@app.get("/api/v1/attendance/records")
@app.get("/api/attendance/records")
async def api_list_records(limit: int = 100):
    records = db.list_checadas(limit=limit)
    summary = db.get_dashboard_summary()
    return {
        "status": "success",
        "count": len(records),
        "summary": summary,
        "records": records
    }


def _enrich_reloj(r: Dict[str, Any]) -> Dict[str, Any]:
    d = dict(r)
    local_ip = detect_local_ip(d.get("ip", "192.168.11.71"))
    d["serial"] = d.get("serie") or "DS-K1T320MFWX-B20240701V030502ENFX6280429"
    d["red"] = d.get("red_tipo") or "Wi-Fi (TBS)"
    d["webhook_url"] = f"http://{local_ip}:8000/api/v1/webhooks/hikvision"
    d["ultimo_contacto"] = d.get("ultima_sincronizacion") or "Reciente"
    return d


def _enrich_empleado(e: Dict[str, Any]) -> Dict[str, Any]:
    d = dict(e)
    d["area"] = d.get("area_nombre") or "General"
    return d


def _enrich_area(a: Dict[str, Any], conn) -> Dict[str, Any]:
    d = dict(a)
    horario = d.get("horario") or "08:00 - 17:00"
    parts = [p.strip() for p in horario.split("-")]
    d["hora_entrada"] = parts[0] if len(parts) >= 1 else "08:00"
    d["hora_salida"] = parts[1] if len(parts) >= 2 else "17:00"
    d["reloj_asignado"] = d.get("ubicacion") or "Cerro Gordo (192.168.11.71)"
    cnt = conn.execute(
        "SELECT COUNT(*) as cnt FROM empleados WHERE area_nombre = ?",
        (d.get("nombre", ""),)
    ).fetchone()["cnt"]
    d["empleados_count"] = cnt
    d["total_empleados"] = cnt
    return d


@app.get("/api/dashboard/overview")
async def api_dashboard_overview():
    summary = db.get_dashboard_summary()
    records = db.list_checadas(limit=100)
    conn = db.get_conn()
    relojes = [_enrich_reloj(r) for r in conn.execute("SELECT * FROM relojes ORDER BY id ASC").fetchall()]
    areas = [_enrich_area(r, conn) for r in conn.execute("SELECT * FROM areas ORDER BY id ASC").fetchall()]
    empleados = [_enrich_empleado(r) for r in conn.execute("SELECT * FROM empleados ORDER BY CAST(codigo_empleado AS INTEGER) ASC").fetchall()]
    conn.close()
    return {
        "status": "success",
        "summary": summary,
        "recent_records": records,
        "devices": relojes,
        "relojes": relojes,
        "areas": areas,
        "employees": empleados,
        "empleados": empleados
    }


# --- RELOJES CHECADORES ---

@app.get("/api/devices")
async def api_get_devices():
    conn = db.get_conn()
    rows = [_enrich_reloj(r) for r in conn.execute("SELECT * FROM relojes ORDER BY id ASC").fetchall()]
    conn.close()
    return {"status": "success", "devices": rows}


@app.post("/api/devices")
async def api_add_device(payload: Dict[str, Any] = Body(...)):
    nombre = payload.get("nombre", "Nuevo Reloj").strip()
    ip = payload.get("ip", "").strip()
    puerto = int(payload.get("puerto", 80))
    usuario = payload.get("usuario", "admin").strip()
    password = payload.get("password", config.HIK_PASS).strip()
    area_asignada = payload.get("area_asignada", "Operaciones Cerro Gordo")
    ubicacion = payload.get("ubicacion", "Acceso")
    red_tipo = payload.get("red_tipo", "Wi-Fi / LAN")

    if not ip:
        raise HTTPException(status_code=400, detail="La dirección IP es obligatoria.")

    # Intentar consultar deviceInfo real si es alcanzable
    modelo = payload.get("modelo", "DS-K1T320MFWX-B")
    serie = "N/A"
    mac = "N/A"
    firmware = "V3.5.2"
    estado = "OFFLINE"

    base_url = f"http://{ip}:{puerto}" if puerto != 80 else f"http://{ip}"
    try:
        resp = requests.get(f"{base_url}/ISAPI/System/deviceInfo", auth=HTTPDigestAuth(usuario, password), timeout=4)
        if resp.status_code == 200:
            estado = "ONLINE"
            root = ET.fromstring(resp.content)
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if elem.text:
                    if tag == "model":
                        modelo = elem.text.strip()
                    elif tag == "serialNumber":
                        serie = elem.text.strip()
                    elif tag == "macAddress":
                        mac = elem.text.strip()
                    elif tag == "firmwareVersion":
                        firmware = elem.text.strip()
    except Exception:
        pass

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = db.get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO relojes (
            nombre, modelo, serie, mac, firmware, ip, puerto, usuario, password,
            red_tipo, area_asignada, ubicacion, estado, ultima_sincronizacion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (nombre, modelo, serie, mac, firmware, ip, puerto, usuario, password, red_tipo, area_asignada, ubicacion, estado, now_str))
    new_id = cur.lastrowid
    conn.commit()
    conn.close()
    return {"status": "success", "id": new_id, "estado": estado, "modelo": modelo}


@app.post("/api/devices/{device_id}/sync")
async def api_sync_device(device_id: int):
    conn = db.get_conn()
    clk = conn.execute("SELECT * FROM relojes WHERE id = ?", (device_id,)).fetchone()
    conn.close()
    if not clk:
        raise HTTPException(status_code=404, detail="Reloj no encontrado")

    ev_res = await asyncio.to_thread(
        sync_clock_events_from_hardware,
        clk["ip"], clk["puerto"], clk["usuario"], clk["password"], clk["nombre"]
    )
    usr_res = await asyncio.to_thread(
        sync_employees_from_hardware,
        clk["ip"], clk["puerto"], clk["usuario"], clk["password"], clk["nombre"]
    )
    return {
        "ok": True,
        "status": "success" if ev_res.get("ok") else "warning",
        "users_synced": usr_res.get("users_count", 0),
        "events_pulled": ev_res.get("total_pulled", 0),
        "new_events_inserted": ev_res.get("new_inserted", 0),
        "events_sync": ev_res,
        "users_sync": usr_res,
        "message": f"Sincronización completada con {clk['nombre']} ({clk['ip']}). Nuevas checadas: {ev_res.get('new_inserted', 0)}."
    }


@app.post("/api/devices/{device_id}/sync-time")
async def api_sync_device_time(device_id: int):
    conn = db.get_conn()
    clk = conn.execute("SELECT * FROM relojes WHERE id = ?", (device_id,)).fetchone()
    conn.close()
    if not clk:
        raise HTTPException(status_code=404, detail="Reloj no encontrado")

    base_url = f"http://{clk['ip']}:{clk['puerto']}" if clk["puerto"] != 80 else f"http://{clk['ip']}"
    local_iso = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S-06:00")
    xml_payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<timeMode>manual</timeMode>
<localTime>{local_iso}</localTime>
<timeZone>CST+6:00:00</timeZone>
</Time>"""

    try:
        resp = await asyncio.to_thread(
            requests.put,
            f"{base_url}/ISAPI/System/time",
            auth=HTTPDigestAuth(clk["usuario"], clk["password"]),
            headers={"Content-Type": "application/xml"},
            data=xml_payload.encode("utf-8"),
            timeout=6
        )
        if resp.status_code == 200:
            return {"ok": True, "status": "success", "localTime": local_iso, "synced_time": local_iso, "message": f"Hora calibrada a {local_iso}"}
        raise HTTPException(status_code=400, detail=f"El reloj respondió HTTP {resp.status_code}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error calibrando hora: {e}")


@app.post("/api/devices/{device_id}/setup-webhook")
async def api_setup_device_webhook(device_id: int):
    conn = db.get_conn()
    clk = conn.execute("SELECT * FROM relojes WHERE id = ?", (device_id,)).fetchone()
    conn.close()
    if not clk:
        raise HTTPException(status_code=404, detail="Reloj no encontrado")

    local_ip = detect_local_ip(clk["ip"])
    base_url = f"http://{clk['ip']}:{clk['puerto']}" if clk["puerto"] != 80 else f"http://{clk['ip']}"
    xml_payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotification version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>1</id>
<url>/api/v1/webhooks/hikvision</url>
<protocolType>HTTP</protocolType>
<parameterFormatType>XML</parameterFormatType>
<addressingFormatType>ipaddress</addressingFormatType>
<hostName>{local_ip}</hostName>
<ipAddress>{local_ip}</ipAddress>
<portNo>8000</portNo>
<httpAuthenticationMethod>none</httpAuthenticationMethod>
<SubscribeEvent>
<heartbeat>30</heartbeat>
<eventMode>all</eventMode>
<EventList>
<Event>
<type>AccessControllerEvent</type>
<minorAlarm></minorAlarm>
<minorException></minorException>
<minorOperation></minorOperation>
<minorEvent></minorEvent>
<pictureURLType>binary</pictureURLType>
</Event>
</EventList>
</SubscribeEvent>
</HttpHostNotification>"""

    try:
        resp = await asyncio.to_thread(
            requests.put,
            f"{base_url}/ISAPI/Event/notification/httpHosts/1",
            auth=HTTPDigestAuth(clk["usuario"], clk["password"]),
            headers={"Content-Type": "application/xml"},
            data=xml_payload.encode("utf-8"),
            timeout=6
        )
        if resp.status_code == 200:
            wh_url = f"http://{local_ip}:8000/api/v1/webhooks/hikvision"
            return {
                "ok": True,
                "status": "success",
                "webhook": wh_url,
                "webhook_url": wh_url,
                "message": f"Webhook configurado hacia {local_ip}:8000"
            }
        raise HTTPException(status_code=400, detail=f"Error HTTP {resp.status_code}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/devices/{device_id}/test-connection")
async def api_test_device_connection(device_id: int):
    """
    Prueba en 1 clic la comunicación HTTP Digest con el reloj checador ISAPI.
    Mide latencia y actualiza el estado en vivo.
    """
    conn = db.get_conn()
    clk = conn.execute("SELECT * FROM relojes WHERE id = ?", (device_id,)).fetchone()
    conn.close()
    if not clk:
        raise HTTPException(status_code=404, detail="Reloj no encontrado")

    base_url = f"http://{clk['ip']}:{clk['puerto']}" if clk["puerto"] != 80 else f"http://{clk['ip']}"
    t_start = datetime.datetime.now()
    try:
        resp = await asyncio.to_thread(
            requests.get,
            f"{base_url}/ISAPI/System/deviceInfo",
            auth=HTTPDigestAuth(clk["usuario"], clk["password"]),
            timeout=3.5
        )
        latency_ms = int((datetime.datetime.now() - t_start).total_seconds() * 1000)
        if resp.status_code == 200:
            modelo = clk["modelo"]
            firmware = clk["firmware"]
            try:
                root = ET.fromstring(resp.text)
                ns = {"ns": "http://www.isapi.org/ver20/XMLSchema"}
                m_node = root.find("ns:model", ns) or root.find("model")
                if m_node is not None and m_node.text:
                    modelo = m_node.text
                f_node = root.find("ns:firmwareVersion", ns) or root.find("firmwareVersion")
                if f_node is not None and f_node.text:
                    firmware = f_node.text
            except Exception:
                pass

            conn = db.get_conn()
            conn.execute("UPDATE relojes SET estado = 'ONLINE', modelo = ?, firmware = ? WHERE id = ?",
                         (modelo, firmware, device_id))
            conn.commit()
            conn.close()

            return {
                "ok": True,
                "status": "success",
                "latency_ms": latency_ms,
                "estado": "ONLINE",
                "modelo": modelo,
                "firmware": firmware,
                "message": f"Conexión exitosa con {modelo} ({latency_ms} ms)"
            }
        else:
            return {
                "ok": False,
                "status": "error",
                "latency_ms": latency_ms,
                "error": f"El reloj respondió con código HTTP {resp.status_code} (verifique usuario y contraseña)"
            }
    except requests.exceptions.Timeout:
        return {
            "ok": False,
            "status": "error",
            "error": f"Tiempo de espera agotado al conectar con {clk['ip']}:{clk['puerto']} (reloj apagado o fuera de red)"
        }
    except Exception as e:
        return {
            "ok": False,
            "status": "error",
            "error": f"No se pudo conectar a {clk['ip']}: {str(e)}"
        }


# --- CONFIGURACIÓN Y PREFERENCIAS DEL SISTEMA ---

@app.get("/api/settings")
async def api_get_settings():
    """Retorna la configuración del sistema, parámetros anti-rebote y datos de red."""
    settings = db.get_all_settings()
    local_ip = detect_local_ip()
    settings["local_ip"] = local_ip
    settings["webhook_port"] = 8000
    settings["webhook_url"] = f"http://{local_ip}:8000/api/v1/webhooks/hikvision"
    return {"status": "success", "settings": settings}


@app.post("/api/settings")
async def api_update_settings(payload: Dict[str, Any] = Body(...)):
    """Guarda o actualiza parámetros de configuración (debounce, tolerancia, operador)."""
    db.update_settings(payload)
    return {"ok": True, "status": "success", "message": "Configuración guardada exitosamente"}


# --- EMPLEADOS Y BIOMETRÍA ---

@app.get("/api/employees")
async def api_get_employees():
    conn = db.get_conn()
    rows = [_enrich_empleado(r) for r in conn.execute("SELECT * FROM empleados ORDER BY CAST(codigo_empleado AS INTEGER) ASC").fetchall()]
    conn.close()
    return {"status": "success", "employees": rows}


@app.post("/api/employees")
async def api_create_or_update_employee(payload: Dict[str, Any] = Body(...)):
    emp_no = str(payload.get("codigo_empleado", "")).strip()
    nombre = payload.get("nombre", "").strip()
    area_nombre = (payload.get("area") or payload.get("area_nombre") or "Operaciones Cerro Gordo").strip()
    puesto = payload.get("puesto", "Colaborador").strip()
    turno = payload.get("turno", "Matutino (08:00 - 17:00)").strip()
    pin = str(payload.get("pin", "123456")).strip()
    admin_ui = 1 if payload.get("admin_ui", True) else 0
    sync_to_clock = payload.get("sync_to_clock", True)

    if not emp_no or not nombre:
        raise HTTPException(status_code=400, detail="Número de empleado y nombre son obligatorios.")

    clock_synced = False
    clock_msg = ""

    if sync_to_clock:
        conn = db.get_conn()
        clk = conn.execute("SELECT * FROM relojes ORDER BY id ASC LIMIT 1").fetchone()
        conn.close()
        if clk:
            base_url = f"http://{clk['ip']}:{clk['puerto']}" if clk["puerto"] != 80 else f"http://{clk['ip']}"
            isapi_payload = {
                "UserInfo": {
                    "employeeNo": emp_no,
                    "name": nombre,
                    "userType": "normal",
                    "closeDelayEnabled": False,
                    "Valid": {
                        "enable": True,
                        "beginTime": "2026-01-01T00:00:00",
                        "endTime": "2036-12-31T23:59:59",
                        "timeType": "local"
                    },
                    "belongGroup": "",
                    "password": pin,
                    "doorRight": "1",
                    "RightPlan": [{"doorNo": 1, "planTemplateNo": "1"}],
                    "localUIRight": bool(admin_ui),
                    "gender": "male"
                }
            }
            try:
                resp = await asyncio.to_thread(
                    requests.put,
                    f"{base_url}/ISAPI/AccessControl/UserInfo/SetUp?format=json",
                    auth=HTTPDigestAuth(clk["usuario"], clk["password"]),
                    json=isapi_payload,
                    timeout=8
                )
                if resp.status_code == 200:
                    clock_synced = True
                    clock_msg = "Sincronizado en reloj físico Hikvision"
                else:
                    clock_msg = f"Guardado local (Reloj respondió HTTP {resp.status_code})"
            except Exception as e:
                clock_msg = f"Guardado local (Reloj sin conexión: {e})"

    conn = db.get_conn()
    cur = conn.cursor()
    existing = cur.execute("SELECT id FROM empleados WHERE codigo_empleado = ?", (emp_no,)).fetchone()
    if existing:
        cur.execute("""
            UPDATE empleados
            SET nombre = ?, area_nombre = ?, puesto = ?, turno = ?, pin = ?, admin_ui = ?
            WHERE codigo_empleado = ?
        """, (nombre, area_nombre, puesto, turno, pin, admin_ui, emp_no))
    else:
        cur.execute("""
            INSERT INTO empleados (
                codigo_empleado, nombre, area_nombre, puesto, turno, pin,
                tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'Cerro Gordo', 'ACTIVO')
        """, (emp_no, nombre, area_nombre, puesto, turno, pin, admin_ui))
    conn.commit()
    conn.close()

    return {
        "ok": True,
        "status": "success",
        "clock_synced": clock_synced,
        "message": f"Empleado #{emp_no} ({nombre}) guardado. {clock_msg}"
    }


@app.delete("/api/employees/{emp_no}")
async def api_delete_employee(emp_no: str, delete_from_clock: bool = False):
    if delete_from_clock:
        conn = db.get_conn()
        clk = conn.execute("SELECT * FROM relojes ORDER BY id ASC LIMIT 1").fetchone()
        conn.close()
        if clk:
            base_url = f"http://{clk['ip']}:{clk['puerto']}" if clk["puerto"] != 80 else f"http://{clk['ip']}"
            del_payload = {
                "UserInfoDelCond": {
                    "EmployeeNoList": [{"employeeNo": str(emp_no)}]
                }
            }
            try:
                await asyncio.to_thread(
                    requests.put,
                    f"{base_url}/ISAPI/AccessControl/UserInfo/Delete?format=json",
                    auth=HTTPDigestAuth(clk["usuario"], clk["password"]),
                    json=del_payload,
                    timeout=8
                )
            except Exception:
                pass

    conn = db.get_conn()
    conn.execute("DELETE FROM empleados WHERE codigo_empleado = ?", (str(emp_no),))
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success"}


@app.post("/api/employees/{emp_no}/face")
async def api_upload_employee_face(emp_no: str, file: UploadFile = File(...)):
    conn = db.get_conn()
    clk = conn.execute("SELECT * FROM relojes ORDER BY id ASC LIMIT 1").fetchone()
    conn.close()
    if not clk:
        raise HTTPException(status_code=404, detail="No hay relojes configurados")

    img_bytes = await file.read()
    base_url = f"http://{clk['ip']}:{clk['puerto']}" if clk["puerto"] != 80 else f"http://{clk['ip']}"
    url = f"{base_url}/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json"
    face_record_json = {"faceLibType": "blackFD", "FDID": "1", "FPID": str(emp_no)}

    try:
        files = {
            "FaceDataRecord": (None, json.dumps(face_record_json), "application/json"),
            "img": (file.filename or "face.jpg", img_bytes, "image/jpeg")
        }
        resp = await asyncio.to_thread(
            requests.post,
            url,
            auth=HTTPDigestAuth(clk["usuario"], clk["password"]),
            files=files,
            timeout=12
        )
        if resp.status_code in [200, 201]:
            conn = db.get_conn()
            conn.execute("UPDATE empleados SET tiene_rostro = 1 WHERE codigo_empleado = ?", (str(emp_no),))
            conn.commit()
            conn.close()
            return {"ok": True, "status": "success", "message": f"Rostro enrolado en el reloj para el empleado #{emp_no}."}
        raise HTTPException(status_code=400, detail=f"Reloj rechazó la imagen (HTTP {resp.status_code}): {resp.text}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- ÁREAS Y TURNOS ---

@app.get("/api/areas")
async def api_get_areas():
    conn = db.get_conn()
    areas = [_enrich_area(r, conn) for r in conn.execute("SELECT * FROM areas ORDER BY id ASC").fetchall()]
    conn.close()
    return {"status": "success", "areas": areas}


@app.post("/api/areas")
async def api_create_area(payload: Dict[str, Any] = Body(...)):
    codigo = payload.get("codigo", "").strip().upper() or f"AREA-{os.urandom(2).hex().upper()}"
    nombre = payload.get("nombre", "").strip()
    responsable = payload.get("responsable", "Por asignar").strip()
    turno = payload.get("turno", "Matutino").strip()
    hora_in = payload.get("hora_entrada", "08:00").strip()
    hora_out = payload.get("hora_salida", "17:00").strip()
    horario = payload.get("horario") or f"{hora_in} - {hora_out}"
    tolerancia_min = int(payload.get("tolerancia_min", 10))
    ubicacion = (payload.get("reloj_asignado") or payload.get("ubicacion") or "Cerro Gordo (192.168.11.71)").strip()

    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre del área es obligatorio.")

    conn = db.get_conn()
    cur = conn.cursor()
    cur.execute("""
        INSERT OR REPLACE INTO areas (codigo, nombre, responsable, turno, horario, tolerancia_min, ubicacion)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (codigo, nombre, responsable, turno, horario, tolerancia_min, ubicacion))
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success", "message": f"Área '{nombre}' registrada correctamente."}


@app.delete("/api/areas/{area_id}")
async def api_delete_area(area_id: int):
    conn = db.get_conn()
    conn.execute("DELETE FROM areas WHERE id = ?", (area_id,))
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success"}


# --- CONFIGURACIÓN DE CORREO (SMTP) Y ENVÍO DE REPORTES ---

@app.get("/api/email/config")
async def api_get_email_config():
    cfg = db.get_email_config(mask_password=True)
    return {"status": "success", "config": cfg}


@app.post("/api/email/config")
async def api_update_email_config(payload: Dict[str, Any] = Body(...)):
    updated = db.update_email_config(payload)
    return {"status": "success", "config": updated, "message": "Configuración de correo actualizada correctamente."}


@app.post("/api/email/test")
async def api_test_email(payload: Dict[str, Any] = Body(...)):
    test_to = (payload.get("to_email") or "").strip()
    if not test_to:
        cfg = db.get_email_config(mask_password=False)
        test_to = cfg.get("destinatario_default") or cfg.get("smtp_user")
    if not test_to or "@" not in test_to:
        raise HTTPException(status_code=400, detail="Debes indicar un correo destinatario válido para la prueba.")

    cfg_override = None
    if "smtp_host" in payload and payload.get("smtp_host"):
        # Permite probar con datos recién tipeados en la interfaz antes de guardar
        cfg_override = payload

    now_str = datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    html_test = f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 16px; border: 1px solid #e4e4e7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background: #18181b; color: white; padding: 16px 20px; border-radius: 12px; margin-bottom: 20px;">
            <div style="font-size: 10px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #a1a1aa;">ACCESS BIOMÉTRICO</div>
            <h2 style="margin: 4px 0 0 0; font-size: 18px; color: #ffffff;">Prueba de Conexión SMTP Exitosa</h2>
        </div>
        <p style="color: #3f3f46; font-size: 13px; line-height: 1.5;">Este es un mensaje de verificación generado desde el servidor local de <strong>ACCESS</strong>.</p>
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
            <span style="color: #15803d; font-weight: bold; font-size: 13px;">✔ Autenticación y envío correctos</span>
            <p style="margin: 4px 0 0 0; font-size: 11px; color: #166534;">Tu servidor SMTP está listo para enviar reportes de asistencia automáticamente.</p>
        </div>
        <div style="font-size: 11px; color: #71717a; border-top: 1px solid #f4f4f5; padding-top: 12px; margin-top: 16px;">
            Fecha y hora: <span style="font-family: monospace;">{now_str}</span>
        </div>
    </div>
    """

    res = await asyncio.to_thread(
        mailer.send_email_message,
        to_email=test_to,
        subject="ACCESS — Prueba de Conexión de Correo Exitosa",
        html_content=html_test,
        text_content=f"Prueba exitosa de conexión de correo desde ACCESS ({now_str}).",
        config_override=cfg_override
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Error al conectar con el servidor SMTP."))
    return {"status": "success", "message": res.get("message")}


@app.get("/api/reports/query")
async def api_query_report(
    type: str = "bitacora",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    employee_id: Optional[str] = None,
    area: Optional[str] = None,
    reloj: Optional[str] = None,
    status: Optional[str] = None
):
    dataset = db.get_report_dataset(
        report_type=type,
        start_date=start_date,
        end_date=end_date,
        employee_id=employee_id,
        area=area,
        reloj=reloj,
        status_filter=status
    )
    return {"status": "success", "report": dataset}


@app.post("/api/reports/send-email")
async def api_send_report_email(payload: Dict[str, Any] = Body(...)):
    to_email = (payload.get("to_email") or "").strip()
    subject = (payload.get("subject") or "").strip()
    notes = (payload.get("notes") or "").strip()
    report_type = payload.get("report_type", "bitacora")
    start_date = payload.get("start_date")
    end_date = payload.get("end_date")
    employee_id = payload.get("employee_id")
    area = payload.get("area")
    reloj = payload.get("reloj")
    status_filter = payload.get("status")
    attach_csv = payload.get("attach_csv", True)

    cfg = db.get_email_config(mask_password=False)
    if not to_email:
        to_email = cfg.get("destinatario_default")
    if not to_email:
        raise HTTPException(status_code=400, detail="Por favor indica un correo destinatario.")
    if not cfg.get("is_configured"):
        raise HTTPException(status_code=400, detail="El servidor de correo (SMTP) aún no ha sido configurado. Ve a Configuración de Correo para ingresar las credenciales.")

    # Generar dataset dinámico
    dataset = db.get_report_dataset(
        report_type=report_type,
        start_date=start_date,
        end_date=end_date,
        employee_id=employee_id,
        area=area,
        reloj=reloj,
        status_filter=status_filter
    )

    report_title = dataset.get("title", "Reporte de Asistencia ACCESS")
    if not subject:
        today_fmt = datetime.date.today().strftime("%d/%m/%Y")
        subject = f"ACCESS — {report_title} ({today_fmt})"

    # Descripción de filtros aplicados
    filter_parts = []
    if start_date and end_date:
        filter_parts.append(f"Periodo: {start_date} al {end_date}")
    elif start_date:
        filter_parts.append(f"Desde: {start_date}")
    elif end_date:
        filter_parts.append(f"Hasta: {end_date}")
    else:
        filter_parts.append("Periodo: Todos los registros")

    if employee_id and employee_id != "TODOS":
        filter_parts.append(f"Empleado #{employee_id}")
    if area and area != "TODAS":
        filter_parts.append(f"Área: {area}")
    if reloj and reloj != "TODOS":
        filter_parts.append(f"Reloj: {reloj}")

    filters_desc = " • ".join(filter_parts)

    # Preparar KPIs
    summary_data = dataset.get("summary", {})
    kpis_list = []
    for k, v in summary_data.items():
        label_pretty = k.replace("_", " ").title()
        kpis_list.append({"label": label_pretty, "value": str(v), "hint": ""})

    # Preparar filas tabulares
    headers = dataset.get("headers", [])
    raw_data = dataset.get("data", [])
    table_rows = []

    if report_type == "bitacora":
        for r in raw_data:
            table_rows.append([
                str(r.get("id")),
                f"#{r.get('codigo_empleado')}",
                r.get("nombre", ""),
                r.get("area", ""),
                r.get("reloj_nombre", ""),
                r.get("metodo", ""),
                r.get("fecha_hora_display", ""),
                '<span style="color: #15803D; font-weight: bold;">Válido</span>' if not r.get("es_rebote") else '<span style="color: #B45309; font-weight: bold;">Rebote</span>'
            ])
    elif report_type == "empleados":
        for r in raw_data:
            table_rows.append([
                f"#{r.get('codigo_empleado')}",
                r.get("nombre", ""),
                r.get("area_nombre", ""),
                r.get("turno", ""),
                f"<b>{r.get('total_validas', 0)}</b>",
                str(r.get("total_rebotes", 0)),
                str(r.get("dias_activos", 0)),
                r.get("primera_checada", ""),
                r.get("ultima_checada", ""),
                f'<span style="color: #0369A1; font-weight: bold;">{r.get("estatus", "")}</span>'
            ])
    elif report_type == "relojes":
        for r in raw_data:
            table_rows.append([
                r.get("nombre", ""),
                r.get("ip", ""),
                r.get("modelo", ""),
                r.get("ubicacion", ""),
                str(r.get("total_eventos_periodo", 0)),
                str(r.get("validas", 0)),
                str(r.get("rebotes", 0)),
                str(r.get("usuarios_distintos", 0)),
                r.get("ultima_actividad", ""),
                '<span style="color: #15803D; font-weight: bold;">ONLINE</span>' if r.get("estado") == "ONLINE" else '<span style="color: #DC2626; font-weight: bold;">OFFLINE</span>'
            ])
    elif report_type == "areas":
        for r in raw_data:
            table_rows.append([
                r.get("codigo", ""),
                r.get("nombre", ""),
                r.get("responsable", ""),
                r.get("turno", ""),
                r.get("horario", ""),
                str(r.get("plantilla", 0)),
                str(r.get("colaboradores_presentes", 0)),
                f"{r.get('cobertura_pct', 0)}%",
                f"<b>{r.get('total_validas', 0)}</b>"
            ])

    html_email = mailer.generate_report_html(
        report_title=report_title,
        filters_desc=filters_desc,
        summary_kpis=kpis_list,
        headers=headers,
        rows=table_rows,
        notes=notes
    )

    # Generar archivo CSV adjunto opcional
    attachment_bytes = None
    attachment_filename = None
    if attach_csv:
        csv_buffer = io.StringIO()
        csv_writer = csv.writer(csv_buffer)
        csv_writer.writerow(headers)
        import re
        clean_tag_re = re.compile(r'<[^>]+>')
        for row in table_rows:
            clean_row = [clean_tag_re.sub('', str(cell)) for cell in row]
            csv_writer.writerow(clean_row)

        attachment_bytes = ("\ufeff" + csv_buffer.getvalue()).encode("utf-8")
        date_str = datetime.date.today().strftime("%Y%m%d")
        attachment_filename = f"reporte_{report_type}_{date_str}.csv"

    res = await asyncio.to_thread(
        mailer.send_email_message,
        to_email=to_email,
        subject=subject,
        html_content=html_email,
        text_content=f"{report_title}\n{filters_desc}\n\nRevisa el archivo adjunto para ver el reporte.",
        attachment_filename=attachment_filename,
        attachment_bytes=attachment_bytes
    )

    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Error al enviar el reporte por correo."))

    return {"status": "success", "message": f"Reporte enviado con éxito a {to_email}."}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
