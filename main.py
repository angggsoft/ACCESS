"""
ACCESS — Plataforma Cloud SaaS de Control de Asistencia Biométrica y Pre-Nómina
Arquitectura Multi-Empresa, Multi-Sucursal, Protocolo One-Way Push Hikvision (Reloj ➔ Servidor)
y Segregación Estricta de Roles (CLIENTE_RH vs ADMIN_SAAS).
"""

import os
import json
import socket
import secrets
import asyncio
import datetime
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, Any, Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response, Depends, HTTPException, Body, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

import config
import core.database as db
import core.mailer as mailer
import io
import csv
import re

BASE_DIR = Path(__file__).parent
TEMPLATES_DIR = BASE_DIR / "templates"
ASSETS_DIR = BASE_DIR / "assets"
CAPTURES_DIR = BASE_DIR / "captures"
CAPTURES_DIR.mkdir(exist_ok=True)

VALID_SUB_EVENT_TYPES = {75, 104, 38, 1, 9, 181}
ZK_VERIFY_TO_SUB_EVENT = {
    1: 38,   # Huella
    15: 75,  # Rostro
    2: 1,    # Tarjeta / Badge
    4: 1,    # Tarjeta RFID
    0: 9,    # PIN / Password
    3: 9     # PIN / Password
}


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
        s.connect((target_ip or "8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def get_server_base_url(request: Optional[Request] = None) -> str:
    """Obtiene la URL pública (ej. https://access.com en Railway) o la URL IP local en desarrollo."""
    if config.PUBLIC_BASE_URL:
        return config.PUBLIC_BASE_URL
    if request:
        proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "http"
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        if host and not host.startswith("localhost") and not host.startswith("127.0.0.1"):
            return f"{proto}://{host}"
    local_ip = detect_local_ip()
    return f"http://{local_ip}:{config.PORT}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Modo One-Way Push (Reloj ➔ Servidor): El servidor NO realiza conexiones salientes hacia el reloj.
    yield


app = FastAPI(
    title="ACCESS Cloud — Control de Asistencia y Pre-Nómina Multi-Tenant",
    description="Plataforma SaaS de Gestión Remota de Relojes Hikvision (One-Way Push)",
    version="3.0.0",
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
    path = request.url.path
    response = await call_next(request)
    if path.startswith("/iclock"):
        response.headers["Cache-Control"] = "no-cache"
        return response
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

@app.get("/favicon.ico", include_in_schema=False)
async def favicon_ico():
    fav_path = ASSETS_DIR / "access_dark.ico"
    if fav_path.exists():
        return FileResponse(fav_path, media_type="image/x-icon")
    return Response(status_code=404)


@app.get("/", response_class=RedirectResponse)
async def root_redirect():
    return RedirectResponse(url="/login")


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    token = request.cookies.get("access_session")
    if token and db.get_user_from_session(token):
        return RedirectResponse(url="/dashboard", status_code=302)
    login_file = TEMPLATES_DIR / "login.html"
    return HTMLResponse(content=login_file.read_text(encoding="utf-8"))


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard_page(request: Request):
    token = request.cookies.get("access_session")
    user = db.get_user_from_session(token) if token else None
    if not user:
        return RedirectResponse(url="/login", status_code=302)
    dash_file = TEMPLATES_DIR / "dashboard.html"
    return HTMLResponse(content=dash_file.read_text(encoding="utf-8"))


# ==========================================
# GUARDS DE AUTENTICACIÓN, ROLES Y PRIVACIDAD CONFIDENCIAL
# ==========================================

def require_auth(request: Request) -> Dict[str, Any]:
    """Valida que exista una sesión iniciada."""
    token = request.cookies.get("access_session")
    if not token:
        auth_hdr = request.headers.get("Authorization", "").strip()
        if auth_hdr.startswith("Bearer "):
            token = auth_hdr.replace("Bearer ", "").strip()
        elif auth_hdr:
            token = auth_hdr

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión no iniciada o token ausente. Por favor inicie sesión."
        )

    user = db.get_user_from_session(token)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sesión no válida o expirada. Por favor inicie sesión nuevamente."
        )
    return user


def require_rh_active(user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    """
    Guard de Seguridad Confidencial para Rutas de Empresa / Sucursal / Relojes / Empleados:
    1. Bloquea estrictamente al Administrador SaaS (`ADMIN_SAAS`) con 403 Forbidden para garantizar
       la privacidad de la información de cada empresa.
    2. Verifica que el usuario `CLIENTE_RH` cuente con una suscripción ACTIVA y vigente.
    """
    if user.get("role_type") == "ADMIN_SAAS":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Privacidad Protegida: El Administrador de Suscripciones no tiene acceso a la información confidencial de empresas, sucursales, empleados ni relojes checadores."
        )
    sub = user.get("subscription") or {}
    if not sub.get("is_active"):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=f"Suscripción {sub.get('estado', 'INACTIVA')}: Tu suscripción venció el {sub.get('fecha_vencimiento', 'N/A')}. Contacta al administrador para renovarla."
        )
    return user


def require_saas_admin(user: Dict[str, Any] = Depends(require_auth)) -> Dict[str, Any]:
    """
    Guard exclusivo para el Usuario Administrador (`ADMIN_SAAS`).
    Solo permite gestionar usuarios y suscripciones.
    """
    if user.get("role_type") != "ADMIN_SAAS":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acceso denegado: Se requieren privilegios de Administrador de Suscripciones."
        )
    return user


# ==========================================
# AUTH API
# ==========================================

@app.post("/api/auth/login")
async def auth_login(request: Request, response: Response, payload: Dict[str, Any] = Body(...)):
    identifier = str(payload.get("email") or payload.get("username") or "").strip()
    password = str(payload.get("password") or "")

    user = db.authenticate_user(identifier, password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas o cuenta desactivada. Verifique su usuario o contraseña."
        )

    token = db.create_user_session(user["id"], user["username"], duration_hours=24)
    is_https = (request.url.scheme == "https") or (request.headers.get("x-forwarded-proto") == "https")
    response.set_cookie(
        key="access_session",
        value=token,
        httponly=True,
        secure=is_https,
        max_age=86400,
        samesite="lax"
    )
    return {"status": "success", "user": user, "token": token}


@app.post("/api/auth/logout")
@app.get("/logout")
async def auth_logout(request: Request, response: Response):
    token = request.cookies.get("access_session")
    if token:
        db.delete_user_session(token)
    res = RedirectResponse(url="/login", status_code=302)
    res.delete_cookie(key="access_session")
    return res


@app.get("/api/auth/me")
async def auth_me(user: Dict[str, Any] = Depends(require_auth)):
    companies = []
    if user.get("role_type") == "CLIENTE_RH":
        companies = db.get_user_companies(user["id"])
    return {"status": "success", "user": user, "companies": companies}


# ==========================================
# CONSOLA EXCLUSIVA ADMINISTRADOR SAAS (GESTIÓN DE USUARIOS Y SUSCRIPCIONES)
# ==========================================

@app.get("/api/admin/users")
async def api_admin_list_users(admin_user: Dict[str, Any] = Depends(require_saas_admin)):
    """Devuelve únicamente la lista de usuarios RH y sus suscripciones (sin datos confidenciales de empresas)."""
    users = db.admin_list_users_and_subscriptions()
    total_users = len(users)
    activas = sum(1 for u in users if u["subscription"].get("is_active"))
    vencidas = sum(1 for u in users if u["subscription"].get("estado") == "VENCIDA")
    suspendidas = sum(1 for u in users if u["subscription"].get("estado") == "SUSPENDIDA")
    total_relojes_contratados = sum(u["subscription"].get("max_relojes", 0) for u in users)
    total_relojes_activos = sum(u.get("relojes_vinculados_count", 0) for u in users)
    return {
        "status": "success",
        "kpis": {
            "total_usuarios_rh": total_users,
            "suscripciones_activas": activas,
            "suscripciones_vencidas": vencidas,
            "suscripciones_suspendidas": suspendidas,
            "total_relojes_contratados": total_relojes_contratados,
            "total_relojes_activos": total_relojes_activos
        },
        "users": users
    }


@app.post("/api/admin/users")
async def api_admin_create_user(
    payload: Dict[str, Any] = Body(...),
    admin_user: Dict[str, Any] = Depends(require_saas_admin)
):
    res = db.admin_create_rh_user(payload)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Error al crear usuario RH."))
    return {"status": "success", "user_id": res["user_id"], "message": "Cuenta de usuario RH y suscripción creadas correctamente."}


@app.put("/api/admin/users/{target_user_id}/subscription")
async def api_admin_update_subscription(
    target_user_id: int,
    payload: Dict[str, Any] = Body(...),
    admin_user: Dict[str, Any] = Depends(require_saas_admin)
):
    res = db.admin_update_user_subscription(target_user_id, payload)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "No se pudo actualizar la suscripción."))
    return {"status": "success", "message": "Suscripción y permisos actualizados correctamente."}


@app.delete("/api/admin/users/{target_user_id}")
async def api_admin_delete_user(
    target_user_id: int,
    admin_user: Dict[str, Any] = Depends(require_saas_admin)
):
    res = db.admin_delete_rh_user(target_user_id)
    if not res.get("ok"):
        raise HTTPException(status_code=404, detail=res.get("error", "Usuario RH no encontrado."))
    return {"status": "success", "message": "Cuenta de usuario RH eliminada correctamente."}


# ==========================================
# GESTIÓN MULTI-EMPRESA, MULTI-SUCURSAL Y CLAVE DINÁMICA 5 MIN (TOTP)
# ==========================================

@app.get("/api/companies")
async def api_list_companies(user: Dict[str, Any] = Depends(require_rh_active)):
    companies = db.get_user_companies(user["id"])
    return {"status": "success", "companies": companies}


@app.post("/api/companies")
async def api_create_company(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    nombre = (payload.get("nombre") or "").strip()
    rfc = (payload.get("rfc") or "").strip()
    industria = (payload.get("industria") or "General").strip()
    sucursal_inicial = (payload.get("sucursal_inicial") or "Sucursal Matriz").strip()

    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre o razón social de la empresa es obligatorio.")

    # Validar límite de empresas según su suscripción
    current_companies = db.get_user_companies(user["id"])
    max_emp = (user.get("subscription") or {}).get("max_empresas", 5)
    if len(current_companies) >= max_emp:
        raise HTTPException(
            status_code=400,
            detail=f"Has alcanzado el límite de {max_emp} empresas permitidas en tu suscripción actual."
        )

    created = db.create_company_for_user(
        user_id=user["id"],
        nombre=nombre,
        rfc=rfc,
        industria=industria,
        first_branch_name=sucursal_inicial
    )
    return {
        "status": "success",
        "company": created,
        "companies": db.get_user_companies(user["id"]),
        "message": f"Empresa '{nombre}' y sucursal '{sucursal_inicial}' creadas exitosamente."
    }


@app.get("/api/companies/{empresa_id}/invite-totp")
async def api_get_company_invite_totp(
    empresa_id: int,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Obtiene el Código de Invitación de la empresa y la Clave Dinámica de 6 dígitos
    que se renueva automáticamente cada 5 minutos (300 segundos).
    Solo accesible para el creador/administrador (OWNER) de esa empresa.
    """
    info = db.get_company_invitation_totp(user["id"], empresa_id)
    if not info:
        raise HTTPException(status_code=404, detail="Empresa no encontrada o sin acceso.")
    if info.get("error") == "not_owner":
        raise HTTPException(
            status_code=403,
            detail="Solo el creador/administrador de esta empresa puede generar y ver la Clave Dinámica de invitación."
        )
    return {"status": "success", "invitation": info}


@app.post("/api/companies/join")
async def api_join_company(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Permite a un usuario de RH agregarse a una empresa existente proporcionando:
    1. El Código de Invitación de la empresa (ej. EMP-QUODO-01)
    2. La Clave Dinámica vigente de 6 dígitos (que rota cada 5 minutos)
    """
    codigo = (payload.get("codigo_invitacion") or "").strip()
    clave = (payload.get("clave_dinamica") or "").strip()

    if not codigo or not clave:
        raise HTTPException(status_code=400, detail="Debes ingresar tanto el Código de Invitación como la Clave Dinámica de 5 minutos.")

    res = db.join_company_by_invite(user["id"], codigo, clave)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error"))

    return {
        "status": "success",
        "empresa_id": res["empresa_id"],
        "nombre": res["nombre"],
        "already_member": res.get("already_member", False),
        "companies": db.get_user_companies(user["id"]),
        "message": f"Te has vinculado exitosamente a la empresa '{res['nombre']}'."
    }


@app.delete("/api/companies/{empresa_id}/members/{member_user_id}")
async def api_remove_company_member(
    empresa_id: int,
    member_user_id: int,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """Revoca el acceso de un miembro RH de la empresa (solo creador/OWNER)."""
    res = db.remove_company_member(user["id"], empresa_id, member_user_id)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return {
        "status": "success",
        "companies": db.get_user_companies(user["id"]),
        "message": "Acceso del miembro revocado correctamente."
    }


@app.post("/api/branches")
async def api_create_branch(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    empresa_id = int(payload.get("empresa_id") or 0)
    nombre = (payload.get("nombre") or "").strip()
    ubicacion = (payload.get("ubicacion") or "").strip()
    codigo = (payload.get("codigo") or "").strip()
    debounce = int(payload.get("debounce_seconds") or 180)
    tolerancia = int(payload.get("tolerancia_minutos") or 10)

    if not empresa_id or not nombre:
        raise HTTPException(status_code=400, detail="Empresa y nombre de la sucursal son obligatorios.")

    if not db.user_has_company_access(user["id"], empresa_id):
        raise HTTPException(status_code=403, detail="No tienes acceso a la empresa seleccionada.")

    branch = db.create_branch_for_company(
        empresa_id=empresa_id,
        nombre=nombre,
        ubicacion=ubicacion,
        codigo=codigo,
        debounce_seconds=debounce,
        tolerancia_minutos=tolerancia
    )
    return {
        "status": "success",
        "branch": branch,
        "companies": db.get_user_companies(user["id"]),
        "message": f"Sucursal '{nombre}' agregada correctamente."
    }


# ==========================================
# PROTOCOLO HIKVISION ONE-WAY PUSH (RELOJ ➔ SERVIDOR)
# ==========================================

def parse_event_payload(payload_str: str) -> dict:
    """Extrae datos de evento desde XML o JSON enviados por el reloj Hikvision."""
    data = {}
    clean = payload_str.strip()
    if not clean:
        return data

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


@app.post("/api/v1/webhooks/hikvision/{webhook_token}")
@app.post("/api/v1/webhooks/hikvision")
@app.post("/ISAPI/Event/notification/alertStream")
async def receive_hikvision_webhook(request: Request, webhook_token: Optional[str] = None):
    """
    Receptor Unidireccional (One-Way Push: Reloj ➔ Servidor).
    El reloj Hikvision sube automáticamente sus eventos y latidos a este endpoint.
    Identifica la Empresa y Sucursal mediante `webhook_token` (o número de serie/nombre).
    """
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
    device_serial = event_data.get("serialNumber") or event_data.get("macAddress") or event_data.get("deviceName")

    # Identificar el reloj y su sucursal/empresa
    clock = db.get_clock_by_webhook_token(webhook_token=webhook_token, serial_or_name=device_serial)
    if not clock:
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"status": "error", "note": "unknown_clock_token"})

    # Actualizar heartbeat del reloj a ONLINE
    db.touch_clock_heartbeat(clock["id"])

    event_type = event_data.get("eventType", "")
    major_type = safe_int(event_data.get("majorEventType") or event_data.get("major"))
    sub_type = safe_int(event_data.get("subEventType") or event_data.get("minor"))

    is_access_event = (event_type == "AccessControllerEvent" or major_type == 5)
    if not is_access_event or sub_type not in VALID_SUB_EVENT_TYPES:
        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success", "note": "heartbeat_or_ignored_minor"})

    emp_no = event_data.get("employeeNoString") or event_data.get("employeeNo")
    if not emp_no:
        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success", "note": "no_employee"})

    raw_name = (event_data.get("name") or "").strip()
    nombre = raw_name if raw_name else f"Empleado #{emp_no}"
    dt_str = event_data.get("dateTime") or event_data.get("time") or datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S-06:00")
    serial_no = safe_int(event_data.get("serialNo")) or None

    result = db.record_checkin(
        serial_no=serial_no,
        emp_no=str(emp_no),
        nombre=nombre,
        tipo_evento="AccessControllerEvent",
        sub_event_type=sub_type,
        fecha_hora=dt_str,
        reloj_nombre=clock["nombre"],
        empresa_id=clock["empresa_id"],
        sucursal_id=clock["sucursal_id"],
        reloj_id=clock["id"]
    )

    return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "success", "inserted": result.get("inserted", False)})


# ==========================================
# PROTOCOLO ZKTECO ADMS / PUSH SDK (/iclock)
# ==========================================

@app.get("/iclock/cdata", response_class=PlainTextResponse)
async def zkteco_adms_handshake(request: Request):
    """Handshake inicial y heartbeat GET /iclock/cdata?SN=...&options=all"""
    sn = (request.query_params.get("SN") or "").strip()
    if sn:
        clock = db.get_clock_by_serial(sn)
        if clock:
            db.touch_clock_heartbeat(clock["id"])
    return PlainTextResponse("OK")


@app.post("/iclock/cdata", response_class=PlainTextResponse)
async def zkteco_adms_receive_data(request: Request):
    """Recepción de checadas ZKTeco ADMS (table=ATTLOG separado por tabuladores) en una sola transacción por lote."""
    sn = (request.query_params.get("SN") or "").strip()
    table = (request.query_params.get("table") or "").strip().upper()
    clock = db.get_clock_by_serial(sn) if sn else None
    if not clock:
        return PlainTextResponse("OK: 0", status_code=404)

    if table != "ATTLOG":
        db.touch_clock_heartbeat(clock["id"])
        return PlainTextResponse("OK")

    raw_bytes = await request.body()
    raw_body = raw_bytes.decode("utf-8", errors="ignore")
    events = []

    for raw_line in raw_body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 2 or not parts[0]:
            continue

        emp_no = parts[0]
        ts_raw = parts[1]
        if "T" in ts_raw:
            dt_iso = ts_raw if ("-" in ts_raw[10:] or "+" in ts_raw[10:] or ts_raw.endswith("Z")) else f"{ts_raw}-06:00"
        elif " " in ts_raw:
            dt_iso = f"{ts_raw.replace(' ', 'T', 1)}-06:00"
        else:
            dt_iso = ts_raw or datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S-06:00")

        verify_code = safe_int(parts[3]) if len(parts) > 3 and parts[3] != "" else 1
        sub_type = ZK_VERIFY_TO_SUB_EVENT.get(verify_code, 38)

        events.append({
            "serial_no": None,
            "emp_no": emp_no,
            "nombre": f"Empleado #{emp_no}",
            "tipo_evento": "ZKTecoADMS",
            "sub_event_type": sub_type,
            "fecha_hora": dt_iso
        })

    if not events:
        db.touch_clock_heartbeat(clock["id"])
        return PlainTextResponse("OK: 0")

    res = db.record_checkins_batch(events, clock)
    return PlainTextResponse(f"OK: {res['processed']}")


@app.get("/iclock/getrequest", response_class=PlainTextResponse)
async def zkteco_adms_getrequest(request: Request):
    """Polling periódico del reloj ZKTeco para mantener estado ONLINE."""
    sn = (request.query_params.get("SN") or "").strip()
    if sn:
        clock = db.get_clock_by_serial(sn)
        if clock:
            db.touch_clock_heartbeat(clock["id"])
    return PlainTextResponse("OK")


@app.post("/iclock/devicecmd", response_class=PlainTextResponse)
async def zkteco_adms_devicecmd(request: Request):
    """Confirmación de comandos de terminal ZKTeco."""
    sn = (request.query_params.get("SN") or "").strip()
    if sn:
        clock = db.get_clock_by_serial(sn)
        if clock:
            db.touch_clock_heartbeat(clock["id"])
    return PlainTextResponse("OK")


@app.post("/api/devices/{device_id}/simulate-push")
async def api_simulate_clock_push(
    device_id: int,
    payload: Dict[str, Any] = Body(default={}),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Simulador local/cloud de checada One-Way Push para probar que un reloj de una sucursal
    sube eventos al servidor usando su `webhook_token` y auto-registra empleados si son nuevos.
    """
    conn = db.get_conn()
    clk = conn.execute("SELECT * FROM relojes WHERE id = ?", (device_id,)).fetchone()
    if not clk:
        conn.close()
        raise HTTPException(status_code=404, detail="Reloj no encontrado.")

    if not db.user_has_company_access(user["id"], clk["empresa_id"]):
        conn.close()
        raise HTTPException(status_code=403, detail="No tienes acceso a la empresa de este reloj.")

    emp_no = str(payload.get("codigo_empleado") or "").strip()
    nombre = str(payload.get("nombre") or "").strip()
    sub_type = int(payload.get("sub_event_type") or 75)  # 75 = ROSTRO por defecto

    if not emp_no:
        emp_row = conn.execute(
            "SELECT codigo_empleado, nombre FROM empleados WHERE sucursal_id = ? ORDER BY id ASC LIMIT 1",
            (clk["sucursal_id"],)
        ).fetchone()
        if emp_row:
            emp_no = str(emp_row["codigo_empleado"])
            nombre = emp_row["nombre"]
        else:
            emp_no = "1"
            nombre = "Colaborador Demo"
    conn.close()

    now_iso = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S-06:00")
    res = db.record_checkin(
        serial_no=int(datetime.datetime.now().timestamp()) % 100000,
        emp_no=emp_no,
        nombre=nombre or f"Empleado #{emp_no}",
        tipo_evento="AccessControllerEvent",
        sub_event_type=sub_type,
        fecha_hora=now_iso,
        reloj_nombre=clk["nombre"],
        empresa_id=clk["empresa_id"],
        sucursal_id=clk["sucursal_id"],
        reloj_id=clk["id"]
    )
    return {
        "ok": True,
        "status": "success",
        "record": res,
        "message": f"Evento Push recibido desde '{clk['nombre']}' para #{emp_no} ({res.get('nombre')})."
    }


# ==========================================
# DASHBOARD, CHECADAS, RELOJES, EMPLEADOS Y ÁREAS (SCOPED POR EMPRESA Y SUCURSAL)
# ==========================================

def _enrich_reloj(r: Any, request: Optional[Request] = None) -> Dict[str, Any]:
    d = dict(r)
    base_srv = get_server_base_url(request)
    marca = (d.get("marca") or "HIKVISION").strip().upper()
    token = d.get("webhook_token") or "hik_default"
    d["marca"] = marca
    d["serial"] = d.get("serie") or ("ZK-SN-PENDIENTE" if marca == "ZKTECO" else "DS-K1T320MFWX-B")
    d["red"] = d.get("red_tipo") or ("ADMS Cloud Push (/iclock)" if marca == "ZKTECO" else "Wi-Fi / Cloud Push")
    if marca == "ZKTECO":
        d["webhook_path"] = "/iclock/cdata"
        d["webhook_url"] = f"{base_srv}/iclock/cdata?SN={d.get('serie') or ''}"
    else:
        d["webhook_path"] = f"/api/v1/webhooks/hikvision/{token}"
        d["webhook_url"] = f"{base_srv}/api/v1/webhooks/hikvision/{token}"
    d["ultimo_contacto"] = d.get("ultima_sincronizacion") or "Reciente"
    return d


def _enrich_empleado(
    e: Any,
    resolver: Optional[Dict[str, Any]] = None,
    branches_map: Optional[Dict[int, str]] = None
) -> Dict[str, Any]:
    d = dict(e)
    d["area"] = d.get("area_nombre") or "General"
    d["codigo_contpaqi"] = d.get("codigo_contpaqi") or ""
    d["sin_nombre"] = db.is_default_employee_name(d.get("nombre"), d.get("codigo_empleado"))
    d["horario_id"] = d.get("horario_id")
    suc_id_val = d.get("sucursal_id")
    if branches_map is not None:
        d["sucursal_base_nombre"] = branches_map.get(int(suc_id_val or 0), "Sin sucursal")
    if resolver is not None:
        sched = db.resolve_employee_schedule(
            resolver,
            emp_code=str(d.get("codigo_empleado")),
            area_name=d["area"],
            emp_horario_id=d.get("horario_id")
        )
        d["horario_origen"] = sched["origen"]
        d["horario_efectivo_id"] = sched["horario_id"]
        d["horario_nombre"] = sched["horario_nombre"]
        d["horario_resumen"] = sched["resumen_corto"]
        d["horario_detalle"] = sched["resumen_detalle"]
        d["horario_es_mixto"] = sched["es_mixto"]
        d["horario_tolerancia_min"] = sched["tolerancia_min"]
        d["horario_bloques"] = [
            {
                "dia_semana": b["dia_semana"],
                "hora_entrada": b["hora_entrada"],
                "hora_salida": b["hora_salida"],
                "tolerancia_min": b.get("tolerancia_min")
            }
            for b in sched.get("bloques", [])
        ]
    return d


def _enrich_area(
    a: Any,
    conn: db.DualConnection,
    resolver: Optional[Dict[str, Any]] = None,
    branches_map: Optional[Dict[int, str]] = None
) -> Dict[str, Any]:
    d = dict(a)
    if branches_map is not None:
        d["sucursal_nombre"] = branches_map.get(int(d.get("sucursal_id") or 0), "")
    sched = None
    if resolver is not None:
        raw_hid = d.get("horario_id")
        if raw_hid is not None and int(raw_hid) in resolver["schedules_by_id"]:
            sched = resolver["schedules_by_id"][int(raw_hid)]
        else:
            sched = db.resolve_employee_schedule(resolver, area_name=d.get("nombre"))

    if sched and sched.get("bloques"):
        first_day = sorted(sched["bloques_por_dia"].keys())[0]
        first_day_blocks = sched["bloques_por_dia"][first_day]
        d["hora_entrada"] = first_day_blocks[0]["hora_entrada_str"]
        d["hora_salida"] = first_day_blocks[-1]["hora_salida_str"]
        d["horario"] = sched["resumen_corto"]
        d["dias_laborales"] = sched["dias_laborales_str"] or d.get("dias_laborales") or "1,2,3,4,5"
        d["tolerancia_min"] = sched["tolerancia_min"]
        d["horario_id"] = sched.get("id") or d.get("horario_id")
        d["horario_nombre"] = sched.get("nombre") or (d.get("turno") or "Estándar")
        d["horario_resumen"] = sched["resumen_corto"]
        d["horario_detalle"] = sched["resumen_detalle"]
        d["horario_es_mixto"] = sched["es_mixto"]
        d["horario_bloques"] = sched["bloques"]
        d["horas_semanales"] = sched["horas_semanales"]
    else:
        horario = d.get("horario") or "08:00 - 17:00"
        parts = [p.strip() for p in horario.split("-")]
        d["hora_entrada"] = parts[0] if len(parts) >= 1 else "08:00"
        d["hora_salida"] = parts[1] if len(parts) >= 2 else "17:00"
        d["dias_laborales"] = d.get("dias_laborales") or "1,2,3,4,5"
        d["horario_id"] = d.get("horario_id")
        d["horario_nombre"] = d.get("turno") or "Estándar"
        d["horario_resumen"] = horario
        d["horario_detalle"] = ""
        d["horario_es_mixto"] = False
        d["horario_bloques"] = []
        d["horas_semanales"] = 0.0

    d["prefijo_id"] = (d.get("prefijo_id") or "").strip()
    d["reloj_asignado"] = d.get("ubicacion") or "Sucursal Activa"
    cnt = conn.execute(
        "SELECT COUNT(*) as cnt FROM empleados WHERE empresa_id = ? AND sucursal_id = ? AND area_nombre = ?",
        (d.get("empresa_id", 1), d.get("sucursal_id", 1), d.get("nombre", ""))
    ).fetchone()["cnt"]
    d["empleados_count"] = cnt
    d["total_empleados"] = cnt
    return d


@app.get("/api/dashboard/overview")
async def api_dashboard_overview(
    request: Request,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    is_all_branches = (sucursal_id == 0)
    emp_id, suc_id = db.resolve_user_scope(
        user["id"], empresa_id, sucursal_id, allow_all_branches=is_all_branches
    )
    companies = db.get_user_companies(user["id"])

    user_sub = db.get_user_subscription(user["id"])
    user_settings = db.get_all_settings(user["id"])

    if not emp_id:
        return {
            "status": "success",
            "companies": [],
            "active_empresa_id": None,
            "active_sucursal_id": None,
            "summary": {},
            "settings": user_settings,
            "subscription": user_sub,
            "recent_records": [],
            "devices": [],
            "relojes": [],
            "areas": [],
            "schedules": [],
            "horarios": [],
            "employees": [],
            "empleados": [],
            "company_employees": [],
            "company_areas": [],
            "company_schedules": [],
            "company_devices": []
        }

    summary = db.get_dashboard_summary(empresa_id=emp_id, sucursal_id=suc_id)
    records = db.list_checadas(limit=100, empresa_id=emp_id, sucursal_id=suc_id)

    conn = db.get_conn()
    branch_rows = conn.execute("SELECT id, nombre FROM sucursales WHERE empresa_id = ?", (emp_id,)).fetchall()
    branches_map = {int(b["id"]): b["nombre"] for b in branch_rows}

    conds = ["empresa_id = ?"]
    params = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    w_sql = " AND ".join(conds)
    p_tup = tuple(params)

    default_tol = int(user_settings.get("tolerancia_minutos") or 10)
    resolver = db.build_schedule_resolver(conn, emp_id, suc_id, default_tol=default_tol)
    horarios = db.get_schedules_for_branch(emp_id, suc_id, include_custom=False, conn=conn)
    relojes = [_enrich_reloj(r, request) for r in conn.execute(f"SELECT * FROM relojes WHERE {w_sql} ORDER BY id ASC", p_tup).fetchall()]
    areas = [_enrich_area(r, conn, resolver, branches_map) for r in conn.execute(f"SELECT * FROM areas WHERE {w_sql} ORDER BY id ASC", p_tup).fetchall()]
    empleados = [_enrich_empleado(r, resolver, branches_map) for r in conn.execute(f"SELECT * FROM empleados WHERE {w_sql} ORDER BY id ASC", p_tup).fetchall()]

    # Catálogos completos a nivel empresa para gestión cross-sucursal
    company_schedules = db.get_schedules_for_branch(emp_id, None, include_custom=False, conn=conn)
    company_devices = [
        {**_enrich_reloj(r, request), "sucursal_nombre": branches_map.get(int(r["sucursal_id"] or 0), "")}
        for r in conn.execute("SELECT * FROM relojes WHERE empresa_id = ? ORDER BY id ASC", (emp_id,)).fetchall()
    ]
    company_areas = [
        _enrich_area(r, conn, resolver, branches_map)
        for r in conn.execute("SELECT * FROM areas WHERE empresa_id = ? ORDER BY id ASC", (emp_id,)).fetchall()
    ]
    company_employees = [
        _enrich_empleado(r, resolver, branches_map)
        for r in conn.execute("SELECT * FROM empleados WHERE empresa_id = ? ORDER BY id ASC", (emp_id,)).fetchall()
    ]
    conn.close()

    return {
        "status": "success",
        "companies": companies,
        "active_empresa_id": emp_id,
        "active_sucursal_id": 0 if is_all_branches else suc_id,
        "summary": summary,
        "settings": user_settings,
        "subscription": user_sub,
        "recent_records": records,
        "devices": relojes,
        "relojes": relojes,
        "areas": areas,
        "schedules": horarios,
        "horarios": horarios,
        "employees": empleados,
        "empleados": empleados,
        "company_employees": company_employees,
        "company_areas": company_areas,
        "company_schedules": company_schedules,
        "company_devices": company_devices
    }


@app.get("/api/v1/attendance/records")
@app.get("/api/attendance/records")
async def api_list_records(
    limit: int = 100,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
    records = db.list_checadas(limit=limit, empresa_id=emp_id, sucursal_id=suc_id)
    summary = db.get_dashboard_summary(empresa_id=emp_id, sucursal_id=suc_id)
    return {
        "status": "success",
        "count": len(records),
        "summary": summary,
        "records": records
    }


@app.post("/api/attendance/manual")
async def api_record_manual_attendance(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_no = str(payload.get("codigo_empleado", "")).strip()
    fecha_hora = str(payload.get("fecha_hora_evento", "")).strip()
    nota = str(payload.get("nota_incidencia", "")).strip()
    req_emp_id = payload.get("empresa_id")
    req_suc_id = payload.get("sucursal_id")

    if not emp_no:
        raise HTTPException(status_code=400, detail="El código de empleado es obligatorio.")
    if not fecha_hora:
        raise HTTPException(status_code=400, detail="La fecha y hora del evento son obligatorias.")

    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, req_suc_id)
    if req_suc_id in (None, "", "null"):
        conn_tmp = db.get_conn()
        emp_base = conn_tmp.execute(
            "SELECT sucursal_id FROM empleados WHERE empresa_id = ? AND codigo_empleado = ? LIMIT 1",
            (emp_id, emp_no)
        ).fetchone()
        conn_tmp.close()
        if emp_base and emp_base["sucursal_id"]:
            suc_id = int(emp_base["sucursal_id"])

    record = db.record_manual_checkin(
        emp_no=emp_no,
        fecha_hora=fecha_hora,
        nota_incidencia=nota or "Incidencia manual autorizada por RH",
        empresa_id=emp_id,
        sucursal_id=suc_id or 1
    )
    return {"status": "success", "record": record}


# --- RELOJES CHECADORES (ONE-WAY PUSH) ---

@app.get("/api/devices")
async def api_get_devices(
    request: Request,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
    conn = db.get_conn()
    conds = ["empresa_id = ?"]
    params = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    rows = [_enrich_reloj(r, request) for r in conn.execute(f"SELECT * FROM relojes WHERE {' AND '.join(conds)} ORDER BY id ASC", tuple(params)).fetchall()]
    conn.close()
    return {"status": "success", "devices": rows}


@app.post("/api/devices")
async def api_add_device(
    request: Request,
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Registra un nuevo reloj checador en la sucursal seleccionada y genera su `webhook_token` único
    para que el reloj físico envíe sus checadas (One-Way Push: Reloj ➔ Servidor).
    """
    req_emp_id = payload.get("empresa_id")
    req_suc_id = payload.get("sucursal_id")
    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, req_suc_id)
    if not emp_id or not suc_id:
        raise HTTPException(status_code=400, detail="Selecciona una empresa y sucursal válidas.")

    device_id = payload.get("id")
    marca = (payload.get("marca") or "HIKVISION").strip().upper()
    if marca not in ("HIKVISION", "ZKTECO"):
        marca = "HIKVISION"

    nombre = (payload.get("nombre") or "Nuevo Reloj").strip()
    ip = (payload.get("ip") or "DHCP / Remoto").strip()
    puerto = int(payload.get("puerto") or 80)
    default_model = "SpeedFace-V5L / MB360" if marca == "ZKTECO" else "DS-K1T320MFWX-B"
    modelo = (payload.get("modelo") or default_model).strip()
    serie_raw = (payload.get("serie") or "").strip()
    if marca == "ZKTECO" and not serie_raw:
        raise HTTPException(status_code=400, detail="El Número de Serie (SN) es obligatorio para relojes ZKTeco ADMS.")
    serie = serie_raw or f"HIK-{secrets.token_hex(4).upper()}"

    mac = (payload.get("mac") or "Automática Push").strip()
    firmware = (payload.get("firmware") or "V3.5.2").strip()
    area_asignada = (payload.get("area_asignada") or "General").strip()
    ubicacion = (payload.get("ubicacion") or "Acceso Principal").strip()
    default_red = "ADMS Cloud Push (/iclock)" if marca == "ZKTECO" else "Cloud Push (HTTP Listening)"
    red_tipo = (payload.get("red_tipo") or default_red).strip()

    conn = db.get_conn()
    cur = conn.cursor()
    base_srv = get_server_base_url(request)

    if device_id:
        existing_clk = cur.execute(
            "SELECT * FROM relojes WHERE id = ? AND empresa_id = ?",
            (int(device_id), emp_id)
        ).fetchone()
        if not existing_clk:
            conn.close()
            raise HTTPException(status_code=404, detail="Reloj no encontrado.")
        cur.execute("""
            UPDATE relojes
            SET nombre = ?, marca = ?, modelo = ?, serie = ?, area_asignada = ?, ubicacion = ?, red_tipo = ?
            WHERE id = ? AND empresa_id = ?
        """, (nombre, marca, modelo, serie, area_asignada, ubicacion, red_tipo, int(device_id), emp_id))
        conn.commit()
        token_existing = existing_clk["webhook_token"] or ""
        conn.close()
        return {
            "status": "success",
            "id": int(device_id),
            "marca": marca,
            "modelo": modelo,
            "webhook_token": token_existing,
            "webhook_url": f"{base_srv}/iclock/cdata?SN={serie}" if marca == "ZKTECO" else f"{base_srv}/api/v1/webhooks/hikvision/{token_existing}"
        }

    sub = db.get_user_subscription(user["id"])
    if sub["relojes_usados"] >= sub["max_relojes"]:
        conn.close()
        raise HTTPException(
            status_code=403,
            detail=f"Límite de relojes alcanzado ({sub['relojes_usados']}/{sub['max_relojes']} contratados). Amplía tu suscripción para registrar más relojes."
        )

    slug = "".join(c for c in nombre.lower() if c.isalnum())[:10] or "reloj"
    prefix = "zk" if marca == "ZKTECO" else "hik"
    webhook_token = f"{prefix}_{slug}_{secrets.token_hex(4)}"
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cur.execute("""
        INSERT INTO relojes (
            empresa_id, sucursal_id, nombre, marca, modelo, serie, mac, firmware, ip, puerto, usuario, password,
            red_tipo, area_asignada, ubicacion, webhook_token, estado, ultima_sincronizacion
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', '', ?, ?, ?, ?, 'ONLINE', ?)
    """, (emp_id, suc_id, nombre, marca, modelo, serie, mac, firmware, ip, puerto, red_tipo, area_asignada, ubicacion, webhook_token, now_str))
    new_id = cur.lastrowid
    conn.commit()
    conn.close()

    return {
        "status": "success",
        "id": new_id,
        "estado": "ONLINE",
        "marca": marca,
        "modelo": modelo,
        "webhook_token": webhook_token,
        "webhook_url": f"{base_srv}/iclock/cdata?SN={serie}" if marca == "ZKTECO" else f"{base_srv}/api/v1/webhooks/hikvision/{webhook_token}"
    }


@app.delete("/api/devices/{device_id}")
async def api_delete_device(
    device_id: int,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    conn = db.get_conn()
    clk = conn.execute("SELECT empresa_id FROM relojes WHERE id = ?", (device_id,)).fetchone()
    if not clk or not db.user_has_company_access(user["id"], clk["empresa_id"]):
        conn.close()
        raise HTTPException(status_code=403, detail="No tienes permiso para eliminar este reloj.")
    conn.execute("DELETE FROM relojes WHERE id = ?", (device_id,))
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success"}


# --- EMPLEADOS (CATÁLOGO EN LA NUBE + AUTO-DESCUBRIMIENTO PUSH) ---

@app.get("/api/employees")
async def api_get_employees(
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    all_branches: bool = False,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    allow_all = bool(all_branches or (sucursal_id == 0))
    emp_id, suc_id = db.resolve_user_scope(
        user["id"], empresa_id, sucursal_id, allow_all_branches=allow_all
    )
    conn = db.get_conn()
    branch_rows = conn.execute("SELECT id, nombre FROM sucursales WHERE empresa_id = ?", (emp_id,)).fetchall()
    branches_map = {int(b["id"]): b["nombre"] for b in branch_rows}
    conds = ["empresa_id = ?"]
    params: list = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    default_tol = int(db.get_setting("tolerancia_minutos", 10, user_id=user["id"]) or 10)
    resolver = db.build_schedule_resolver(conn, emp_id, suc_id, default_tol=default_tol)
    rows = [
        _enrich_empleado(r, resolver, branches_map)
        for r in conn.execute(f"SELECT * FROM empleados WHERE {' AND '.join(conds)} ORDER BY id ASC", tuple(params)).fetchall()
    ]
    conn.close()
    return {"status": "success", "employees": rows}


@app.post("/api/employees")
async def api_create_or_update_employee(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Registra o actualiza los datos de RH (Nombre, Sucursal Base, Área, Puesto, Turno y Horario)
    de un colaborador único dentro de la empresa. El enrolamiento biométrico se realiza en los relojes físicos.
    """
    req_emp_id = payload.get("empresa_id")
    req_suc_id = payload.get("sucursal_id")
    has_explicit_suc = req_suc_id not in (None, "", "null", 0, "0")
    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, int(req_suc_id) if has_explicit_suc else None)

    emp_no = str(payload.get("codigo_empleado", "")).strip()
    if not emp_no:
        raise HTTPException(status_code=400, detail="El ID de reloj del colaborador es obligatorio.")

    codigo_contpaqi = str(payload.get("codigo_contpaqi") or "").strip()
    nombre = (payload.get("nombre") or "").strip() or f"Empleado #{emp_no}"
    area_nombre = (payload.get("area") or payload.get("area_nombre") or "General").strip()
    puesto = (payload.get("puesto") or "Colaborador").strip()
    pin = str(payload.get("pin") or "").strip()
    tiene_huella = 1 if payload.get("tiene_huella") else 0
    tiene_rostro = 1 if payload.get("tiene_rostro") else 0
    horario_mode = str(payload.get("horario_mode") or "").strip().lower()

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        existing = cur.execute(
            "SELECT id, sucursal_id, horario_id, turno, reloj_asignado FROM empleados WHERE empresa_id = ? AND codigo_empleado = ?",
            (emp_id, emp_no)
        ).fetchone()

        if existing:
            target_suc_id = int(suc_id) if has_explicit_suc else int(existing["sucursal_id"] or suc_id or 1)
            reloj_asignado = (payload.get("reloj_asignado") or existing["reloj_asignado"] or "Sucursal Activa").strip()
        else:
            target_suc_id = int(suc_id or 1)
            reloj_asignado = (payload.get("reloj_asignado") or "Sucursal Activa").strip()

        old_horario_id = existing["horario_id"] if existing and "horario_id" in existing.keys() else None
        new_horario_id = old_horario_id
        turno_override = None

        if horario_mode == "area":
            new_horario_id = None
            area_row = cur.execute(
                "SELECT turno, horario, horario_id FROM areas WHERE empresa_id = ? AND sucursal_id = ? AND LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1",
                (emp_id, target_suc_id, area_nombre)
            ).fetchone()
            if not area_row:
                area_row = cur.execute(
                    "SELECT turno, horario, horario_id FROM areas WHERE empresa_id = ? AND LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1",
                    (emp_id, area_nombre)
                ).fetchone()
            if area_row:
                turno_override = f"{(area_row['turno'] or 'Área').strip()} ({area_row['horario'] or 'Horario área'})"
        elif horario_mode == "plantilla":
            req_hid = payload.get("horario_id")
            if req_hid in (None, "", "null"):
                raise HTTPException(status_code=400, detail="Selecciona una plantilla de horario válida.")
            try:
                req_hid_int = int(req_hid)
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="ID de plantilla de horario inválido.")
            tpl = db.get_schedule_by_id(req_hid_int, emp_id, conn=conn)
            if not tpl:
                raise HTTPException(status_code=400, detail="La plantilla de horario seleccionada no existe en esta empresa.")
            new_horario_id = int(tpl["id"])
            turno_override = f"{tpl['nombre']} ({tpl['resumen_corto']})"
        elif horario_mode == "personalizado":
            raw_blocks = payload.get("horario_bloques") or []
            tol_in = payload.get("horario_tolerancia_min", 10)
            target_custom_id = None
            if old_horario_id:
                old_h = cur.execute(
                    "SELECT id, es_plantilla FROM horarios WHERE id = ? AND empresa_id = ?",
                    (int(old_horario_id), emp_id)
                ).fetchone()
                if old_h and int(old_h["es_plantilla"] if old_h["es_plantilla"] is not None else 1) == 0:
                    other_emp_cnt = cur.execute(
                        "SELECT COUNT(*) as c FROM empleados WHERE empresa_id = ? AND horario_id = ? AND codigo_empleado != ?",
                        (emp_id, int(old_horario_id), emp_no)
                    ).fetchone()["c"]
                    other_area_cnt = cur.execute(
                        "SELECT COUNT(*) as c FROM areas WHERE empresa_id = ? AND horario_id = ?",
                        (emp_id, int(old_horario_id))
                    ).fetchone()["c"]
                    if int(other_emp_cnt) == 0 and int(other_area_cnt) == 0:
                        target_custom_id = int(old_horario_id)

            save_res = db.save_schedule(
                emp_id,
                target_suc_id or 1,
                {
                    "id": target_custom_id,
                    "nombre": f"Personalizado — {nombre}",
                    "descripcion": f"Horario individual de #{emp_no}",
                    "tolerancia_min": tol_in,
                    "es_plantilla": 0,
                    "bloques": raw_blocks
                },
                conn=conn
            )
            if not save_res.get("ok"):
                conn._conn.rollback()
                raise HTTPException(status_code=400, detail=save_res.get("error", "Horario personalizado inválido."))
            new_horario_id = int(save_res["id"])
            turno_override = f"Personalizado ({save_res['schedule']['resumen_corto']})"

        turno = (
            turno_override
            or payload.get("turno")
            or (existing["turno"] if existing else None)
            or "Matutino (08:00 - 17:00)"
        ).strip()

        if existing:
            cur.execute("""
                UPDATE empleados
                SET sucursal_id = ?, nombre = ?, codigo_contpaqi = ?, area_nombre = ?, puesto = ?, turno = ?, horario_id = ?, pin = ?,
                    tiene_huella = COALESCE(?, tiene_huella), tiene_rostro = COALESCE(?, tiene_rostro)
                WHERE id = ?
            """, (target_suc_id, nombre, codigo_contpaqi, area_nombre, puesto, turno, new_horario_id, pin, tiene_huella, tiene_rostro, existing["id"]))
        else:
            cur.execute("""
                INSERT INTO empleados (
                    empresa_id, sucursal_id, codigo_empleado, codigo_contpaqi, nombre, area_nombre, puesto, turno, horario_id, pin,
                    tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'ACTIVO')
            """, (emp_id, target_suc_id, emp_no, codigo_contpaqi, nombre, area_nombre, puesto, turno, new_horario_id, pin, tiene_huella, tiene_rostro, reloj_asignado))

        if old_horario_id and old_horario_id != new_horario_id:
            db.cleanup_orphan_custom_schedule(cur, old_horario_id, emp_id)

        cur.execute("""
            UPDATE checadas
            SET nombre = ?, area = ?
            WHERE empresa_id = ? AND codigo_empleado = ?
        """, (nombre, area_nombre, emp_id, emp_no))
        conn.commit()
    except HTTPException:
        conn._conn.rollback()
        raise
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "ok": True,
        "status": "success",
        "sucursal_id": target_suc_id,
        "horario_id": new_horario_id,
        "message": f"Colaborador #{emp_no} ({nombre}) guardado en el catálogo de la empresa."
    }


@app.get("/api/employees/template-csv")
async def api_employees_template_csv(
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    all_branches: bool = False,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Genera y descarga la plantilla CSV con BOM UTF-8 (utf-8-sig) pre-llenada con los
    empleados de la empresa (o filtrados por sucursal base).
    """
    allow_all = bool(all_branches or (sucursal_id == 0))
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id, allow_all_branches=allow_all)
    conn = db.get_conn()
    branch_rows = conn.execute("SELECT id, nombre FROM sucursales WHERE empresa_id = ?", (emp_id,)).fetchall()
    branches_map = {int(b["id"]): b["nombre"] for b in branch_rows}

    conds = ["empresa_id = ?"]
    params: list = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    rows = conn.execute(
        f"""
        SELECT sucursal_id, codigo_empleado, nombre, codigo_contpaqi, area_nombre, puesto, turno, horario_id
        FROM empleados
        WHERE {' AND '.join(conds)}
        ORDER BY id ASC
        """,
        tuple(params)
    ).fetchall()
    tpl_rows = conn.execute(
        "SELECT id, nombre FROM horarios WHERE empresa_id = ? AND COALESCE(es_plantilla, 1) = 1",
        (emp_id,)
    ).fetchall()
    tpl_map = {int(t["id"]): t["nombre"] for t in tpl_rows}
    conn.close()

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(["codigo_empleado", "nombre", "codigo_contpaqi", "area_nombre", "puesto", "turno", "horario_nombre", "sucursal_base"])
    for r in rows:
        hid = r["horario_id"] if "horario_id" in r.keys() else None
        h_name = tpl_map.get(int(hid), "") if hid is not None else ""
        b_name = branches_map.get(int(r["sucursal_id"] or 0), "")
        writer.writerow([
            str(r["codigo_empleado"] or "").strip(),
            str(r["nombre"] or "").strip(),
            str(r["codigo_contpaqi"] or "").strip(),
            str(r["area_nombre"] or "").strip(),
            str(r["puesto"] or "").strip(),
            str(r["turno"] or "").strip(),
            str(h_name or "").strip(),
            str(b_name or "").strip(),
        ])

    csv_bytes = buf.getvalue().encode("utf-8-sig")
    filename = f"plantilla_empleados_{'empresa_' + str(emp_id) if not suc_id else 'sucursal_' + str(suc_id)}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


def _decode_csv_text(raw_bytes: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw_bytes.decode(enc).lstrip("\ufeff")
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode("utf-8", errors="replace").lstrip("\ufeff")


def _parse_employees_csv_text(csv_text: str) -> list:
    lines = [ln for ln in csv_text.splitlines() if ln.strip()]
    if not lines:
        return []
    header_line = lines[0]
    delimiter = ";" if header_line.count(";") > header_line.count(",") else ","
    reader = csv.DictReader(io.StringIO(csv_text), delimiter=delimiter)
    if not reader.fieldnames:
        return []

    alias_map = {
        "codigo": "codigo_empleado",
        "id": "codigo_empleado",
        "id_reloj": "codigo_empleado",
        "area": "area_nombre",
        "contpaqi": "codigo_contpaqi",
        "horario": "horario_nombre"
    }
    normalized_rows = []
    for raw_row in reader:
        norm: Dict[str, Any] = {}
        for k, v in raw_row.items():
            if k is None:
                continue
            clean_k = str(k).strip().lower().lstrip("\ufeff")
            norm[clean_k] = v.strip() if isinstance(v, str) else v
        for alias_k, target_k in alias_map.items():
            if target_k not in norm and alias_k in norm:
                norm[target_k] = norm[alias_k]
        if any(str(val or "").strip() for val in norm.values()):
            normalized_rows.append(norm)
    return normalized_rows


@app.post("/api/employees/import-csv")
async def api_employees_import_csv(
    request: Request,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Importa/actualiza colaboradores desde un archivo CSV (multipart/form-data o contenido texto),
    detectando automáticamente delimitador ',' o ';' y propagando nombre y área hacia checadas.
    """
    content_type = (request.headers.get("content-type") or "").lower()
    req_emp_id: Optional[Any] = empresa_id
    req_suc_id: Optional[Any] = sucursal_id
    csv_text = ""

    if "multipart/form-data" in content_type:
        form = await request.form()
        if req_emp_id is None and form.get("empresa_id"):
            req_emp_id = form.get("empresa_id")
        if req_suc_id is None and form.get("sucursal_id"):
            req_suc_id = form.get("sucursal_id")

        file_field = form.get("file")
        if file_field is None:
            for _, v in form.items():
                if hasattr(v, "read"):
                    file_field = v
                    break
        if file_field is not None and hasattr(file_field, "read"):
            raw_bytes = await file_field.read()
            csv_text = _decode_csv_text(raw_bytes)
        elif isinstance(form.get("csv_content"), str):
            csv_text = str(form.get("csv_content")).lstrip("\ufeff")
    elif "application/json" in content_type:
        payload = await request.json()
        if isinstance(payload, dict):
            req_emp_id = req_emp_id if req_emp_id is not None else payload.get("empresa_id")
            req_suc_id = req_suc_id if req_suc_id is not None else payload.get("sucursal_id")
            csv_text = str(payload.get("csv_content") or payload.get("csv") or "").lstrip("\ufeff")
    else:
        raw_bytes = await request.body()
        csv_text = _decode_csv_text(raw_bytes)

    if not csv_text.strip():
        raise HTTPException(status_code=400, detail="El archivo o contenido CSV está vacío.")

    parsed_rows = _parse_employees_csv_text(csv_text)
    if not parsed_rows or not any("codigo_empleado" in r for r in parsed_rows):
        raise HTTPException(
            status_code=400,
            detail="Formato CSV inválido. Asegúrate de conservar la columna 'codigo_empleado'."
        )

    parsed_suc_id = int(req_suc_id) if req_suc_id not in (None, "", "null") else None
    emp_id, suc_id = db.resolve_user_scope(
        user["id"],
        int(req_emp_id) if req_emp_id not in (None, "", "null") else None,
        parsed_suc_id,
        allow_all_branches=(parsed_suc_id == 0)
    )
    res = db.import_employees_from_csv_rows(emp_id, suc_id, parsed_rows)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "No se pudo importar el CSV."))

    return {
        "ok": True,
        "status": "success",
        **res,
        "message": (
            f"Importación completada: {res['updated_employees']} actualizado(s), "
            f"{res['created_employees']} creado(s) y {res['updated_checkins']} checada(s) sincronizadas."
        )
    }


@app.delete("/api/employees/{emp_no}")
async def api_delete_employee(
    emp_no: str,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, _ = db.resolve_user_scope(user["id"], empresa_id, sucursal_id, allow_all_branches=True)
    conn = db.get_conn()
    cur = conn.cursor()
    row = cur.execute(
        "SELECT horario_id FROM empleados WHERE empresa_id = ? AND codigo_empleado = ?",
        (emp_id, str(emp_no))
    ).fetchone()
    old_hid = row["horario_id"] if row and "horario_id" in row.keys() else None
    cur.execute(
        "DELETE FROM empleados WHERE empresa_id = ? AND codigo_empleado = ?",
        (emp_id, str(emp_no))
    )
    if old_hid:
        db.cleanup_orphan_custom_schedule(cur, old_hid, emp_id)
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success"}


# --- HORARIOS FLEXIBLES MULTI-BLOQUE ---

@app.get("/api/schedules")
async def api_get_schedules(
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    include_custom: bool = False,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
    if not emp_id:
        return {"status": "success", "schedules": []}
    schedules = db.get_schedules_for_branch(emp_id, suc_id, include_custom=include_custom)
    return {"status": "success", "schedules": schedules}


@app.post("/api/schedules")
async def api_save_schedule(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    req_emp_id = payload.get("empresa_id")
    req_suc_id = payload.get("sucursal_id")
    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, req_suc_id)
    if not emp_id or not suc_id:
        raise HTTPException(status_code=400, detail="Selecciona una empresa y sucursal válidas.")

    res = db.save_schedule(emp_id, suc_id, payload)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "No se pudo guardar el horario."))
    return {
        "ok": True,
        "status": "success",
        "schedule": res["schedule"],
        "message": f"Horario '{res['schedule']['nombre']}' guardado correctamente."
    }


@app.delete("/api/schedules/{schedule_id}")
async def api_delete_schedule(
    schedule_id: int,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    conn = db.get_conn()
    row = conn.execute("SELECT empresa_id FROM horarios WHERE id = ?", (schedule_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Horario no encontrado.")
    if not db.user_has_company_access(user["id"], row["empresa_id"]):
        raise HTTPException(status_code=403, detail="Sin permiso para eliminar este horario.")

    res = db.delete_schedule(schedule_id, row["empresa_id"])
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "No se pudo eliminar el horario."))
    unlinked = res.get("unlinked_employees", 0)
    msg = (
        f"Horario eliminado. {unlinked} colaborador(es) pasaron a heredar el horario de su área."
        if unlinked > 0
        else "Horario eliminado correctamente."
    )
    return {"ok": True, "status": "success", "unlinked_employees": unlinked, "message": msg}


# --- ÁREAS Y TURNOS ---

@app.get("/api/areas")
async def api_get_areas(
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
    conn = db.get_conn()
    conds = ["empresa_id = ?"]
    params = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    default_tol = int(db.get_setting("tolerancia_minutos", 10, user_id=user["id"]) or 10)
    resolver = db.build_schedule_resolver(conn, emp_id, suc_id, default_tol=default_tol)
    areas = [_enrich_area(r, conn, resolver) for r in conn.execute(f"SELECT * FROM areas WHERE {' AND '.join(conds)} ORDER BY id ASC", tuple(params)).fetchall()]
    conn.close()
    return {"status": "success", "areas": areas}


@app.post("/api/areas")
async def api_create_area(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    req_emp_id = payload.get("empresa_id")
    req_suc_id = payload.get("sucursal_id")
    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, req_suc_id)

    area_id = payload.get("id")
    codigo = (payload.get("codigo") or "").strip().upper() or f"AREA-{os.urandom(2).hex().upper()}"
    nombre = (payload.get("nombre") or "").strip()
    responsable = (payload.get("responsable") or "Por asignar").strip()
    turno = (payload.get("turno") or "Matutino").strip()
    prefijo_id = str(payload.get("prefijo_id") or "").strip()
    ubicacion = (payload.get("reloj_asignado") or payload.get("ubicacion") or "Sucursal Activa").strip()

    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre del área es obligatorio.")

    conn = db.get_conn()
    try:
        cur = conn.cursor()
        old_row = None
        if area_id:
            old_row = cur.execute(
                "SELECT id, nombre, sucursal_id, horario_id FROM areas WHERE id = ? AND empresa_id = ?",
                (int(area_id), emp_id)
            ).fetchone()
            if not old_row:
                raise HTTPException(status_code=404, detail="Área no encontrada.")

        raw_hid = payload.get("horario_id")
        has_inline_schedule = bool(
            raw_hid == "__simple__"
            or (payload.get("horario") is not None and str(payload.get("horario")).strip() != "")
            or (payload.get("hora_entrada") is not None and str(payload.get("hora_entrada")).strip() != "")
        )
        use_template = raw_hid not in (None, "", "__simple__", "null")

        if use_template:
            try:
                target_hid_int = int(raw_hid)
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail="ID de horario inválido.")
            sched = db.get_schedule_by_id(target_hid_int, emp_id, conn=conn)
            if not sched:
                raise HTTPException(status_code=400, detail="El horario seleccionado no existe en esta empresa.")
            horario_id = int(sched["id"])
            horario = sched["resumen_corto"]
            dias_laborales = sched["dias_laborales"]
            tolerancia_min = int(sched["tolerancia_min"])
        elif not has_inline_schedule:
            target_suc = suc_id or (old_row["sucursal_id"] if old_row else 1) or 1
            default_hid = db.get_default_schedule_id_for_branch(conn, emp_id, target_suc)
            sched = db.get_schedule_by_id(default_hid, emp_id, conn=conn)
            horario_id = int(sched["id"])
            horario = sched["resumen_corto"]
            dias_laborales = sched["dias_laborales"]
            tolerancia_min = int(sched["tolerancia_min"])
        else:
            hora_in = (payload.get("hora_entrada") or "08:00").strip()
            hora_out = (payload.get("hora_salida") or "17:00").strip()
            horario_raw = payload.get("horario") or f"{hora_in} - {hora_out}"
            tolerancia_min = max(0, int(payload.get("tolerancia_min", 10)))
            dias_raw = str(payload.get("dias_laborales") or "1,2,3,4,5").strip()
            t_ent, t_sal = db.parse_horario(horario_raw)
            if not t_ent or not t_sal or t_ent >= t_sal:
                raise HTTPException(
                    status_code=400,
                    detail="El horario rápido debe tener formato HH:MM - HH:MM con entrada menor a salida."
                )
            dias_list = sorted({
                int(x.strip()) for x in dias_raw.split(",")
                if x.strip().isdigit() and 1 <= int(x.strip()) <= 7
            }) or [1, 2, 3, 4, 5]
            simple_blocks = [
                {
                    "dia_semana": d_num,
                    "hora_entrada": t_ent.strftime("%H:%M"),
                    "hora_salida": t_sal.strftime("%H:%M")
                }
                for d_num in dias_list
            ]
            target_edit_hid = None
            if old_row and old_row["horario_id"]:
                other_cnt = cur.execute(
                    "SELECT COUNT(*) as c FROM areas WHERE empresa_id = ? AND horario_id = ? AND id != ?",
                    (emp_id, int(old_row["horario_id"]), int(area_id))
                ).fetchone()["c"]
                if int(other_cnt) == 0:
                    target_edit_hid = int(old_row["horario_id"])

            save_res = db.save_schedule(
                emp_id,
                suc_id or (old_row["sucursal_id"] if old_row else 1),
                {
                    "id": target_edit_hid,
                    "nombre": f"{turno} — {nombre}",
                    "descripcion": f"Horario base de {nombre}",
                    "tolerancia_min": tolerancia_min,
                    "es_plantilla": 1,
                    "bloques": simple_blocks
                },
                conn=conn
            )
            if not save_res.get("ok"):
                raise HTTPException(status_code=400, detail=save_res.get("error", "No se pudo guardar el horario del área."))
            horario_id = int(save_res["id"])
            horario = save_res["schedule"]["resumen_corto"]
            dias_laborales = save_res["schedule"]["dias_laborales"]

        if area_id and old_row:
            cur.execute("""
                UPDATE areas
                SET codigo = ?, nombre = ?, responsable = ?, turno = ?, horario = ?, tolerancia_min = ?, dias_laborales = ?, prefijo_id = ?, horario_id = ?, ubicacion = ?
                WHERE id = ? AND empresa_id = ?
            """, (codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, prefijo_id, horario_id, ubicacion, int(area_id), emp_id))

            old_nombre = (old_row["nombre"] or "").strip()
            target_suc = old_row["sucursal_id"] or suc_id
            if old_nombre and old_nombre != nombre:
                cur.execute("""
                    UPDATE empleados SET area_nombre = ?
                    WHERE empresa_id = ? AND sucursal_id = ? AND area_nombre = ?
                """, (nombre, emp_id, target_suc, old_nombre))
                cur.execute("""
                    UPDATE checadas SET area = ?
                    WHERE empresa_id = ? AND area = ?
                      AND codigo_empleado IN (
                          SELECT codigo_empleado FROM empleados
                          WHERE empresa_id = ? AND sucursal_id = ? AND area_nombre = ?
                      )
                """, (nombre, emp_id, old_nombre, emp_id, target_suc, nombre))
                cur.execute("""
                    UPDATE relojes SET area_asignada = ?
                    WHERE empresa_id = ? AND sucursal_id = ? AND area_asignada = ?
                """, (nombre, emp_id, target_suc, old_nombre))
        else:
            cur.execute("""
                INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, prefijo_id, horario_id, ubicacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (emp_id, suc_id, codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, prefijo_id, horario_id, ubicacion))
        conn.commit()
    except HTTPException:
        conn._conn.rollback()
        raise
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()
    return {"ok": True, "status": "success", "message": f"Área '{nombre}' guardada correctamente."}


@app.post("/api/areas/reapply-rules")
async def api_reapply_area_rules(
    payload: Dict[str, Any] = Body(default={}),
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Re-evalúa todos los empleados actuales de la sucursal activa aplicando la cascada
    de prefijos, reloj asignado y fallback de sucursal, propagando cambios a checadas.
    """
    req_emp_id = payload.get("empresa_id") if isinstance(payload, dict) and payload.get("empresa_id") is not None else empresa_id
    req_suc_id = payload.get("sucursal_id") if isinstance(payload, dict) and payload.get("sucursal_id") is not None else sucursal_id
    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, req_suc_id)
    res = db.reapply_area_rules_for_branch(empresa_id=emp_id, sucursal_id=suc_id)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "No se pudieron re-aplicar las reglas."))
    return {
        "ok": True,
        "status": "success",
        **res,
        "message": (
            f"Reglas aplicadas en sucursal: {res['updated_employees']} empleado(s) "
            f"y {res['updated_checkins']} checada(s) actualizados (de {res['total_employees']} colaboradores)."
        )
    }


@app.delete("/api/areas/{area_id}")
async def api_delete_area(
    area_id: int,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    conn = db.get_conn()
    area_row = conn.execute("SELECT empresa_id FROM areas WHERE id = ?", (area_id,)).fetchone()
    if not area_row or not db.user_has_company_access(user["id"], area_row["empresa_id"]):
        conn.close()
        raise HTTPException(status_code=403, detail="Sin permiso para eliminar esta área.")
    conn.execute("DELETE FROM areas WHERE id = ?", (area_id,))
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success"}


# --- CONFIGURACIÓN Y PREFERENCIAS ---

@app.get("/api/settings")
async def api_get_settings(
    request: Request,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    settings = db.get_all_settings(user["id"])
    base_srv = get_server_base_url(request)
    settings["local_ip"] = detect_local_ip()
    settings["webhook_port"] = config.PORT
    settings["webhook_url"] = f"{base_srv}/api/v1/webhooks/hikvision/{{webhook_token}}"
    return {"status": "success", "settings": settings}


@app.post("/api/settings")
async def api_update_settings(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    account_keys = {"operator_name", "operator_email", "operator_role", "operator_shift", "nombre", "email", "rol", "turno", "username", "new_password"}
    settings_payload = {k: v for k, v in payload.items() if k not in ("username", "new_password")}
    if settings_payload:
        db.update_settings(settings_payload, user_id=user["id"])

    updated_user = None
    if any(k in payload for k in account_keys):
        res_acc = db.update_user_own_account(user["id"], payload)
        if not res_acc.get("ok"):
            raise HTTPException(status_code=400, detail=res_acc.get("error", "No se pudo actualizar la cuenta."))
        updated_user = res_acc["user"]

    return {
        "ok": True,
        "status": "success",
        "user": updated_user,
        "message": "Configuración guardada exitosamente"
    }


# --- CONFIGURACIÓN DE CORREO (SMTP) Y REPORTES ---

@app.get("/api/email/config")
async def api_get_email_config(user: Dict[str, Any] = Depends(require_rh_active)):
    cfg = db.get_email_config(mask_password=True, user_id=user["id"])
    return {"status": "success", "config": cfg}


@app.post("/api/email/config")
async def api_update_email_config(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    updated = db.update_email_config(payload, user_id=user["id"])
    return {"status": "success", "config": updated, "message": "Configuración de correo actualizada correctamente."}


@app.post("/api/email/test")
async def api_test_email(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    cfg = db.get_email_config(mask_password=False, user_id=user["id"])
    test_to = (payload.get("to_email") or "").strip()
    if not test_to:
        test_to = cfg.get("destinatario_default") or cfg.get("smtp_user")
    if not test_to or "@" not in test_to:
        raise HTTPException(status_code=400, detail="Debes indicar un correo destinatario válido para la prueba.")

    cfg_override = dict(cfg)
    if "smtp_host" in payload and payload.get("smtp_host"):
        for k, v in payload.items():
            if k == "smtp_password" and v == "••••••••":
                continue
            cfg_override[k] = v
    now_str = datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    html_test = mailer.generate_test_email_html(
        smtp_host=(cfg_override.get("smtp_host") or "").strip(),
        sender_email=(cfg_override.get("remitente_email") or cfg_override.get("smtp_user") or "").strip(),
        recipient_email=test_to,
        now_str=now_str
    )
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
    status: Optional[str] = None,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(
        user["id"], empresa_id, sucursal_id, allow_all_branches=(sucursal_id == 0)
    )
    dataset = db.get_report_dataset(
        report_type=type,
        start_date=start_date,
        end_date=end_date,
        employee_id=employee_id,
        area=area,
        reloj=reloj,
        status_filter=status,
        empresa_id=emp_id,
        sucursal_id=suc_id
    )
    return {"status": "success", "report": dataset}


@app.get("/api/reports/export-contpaqi")
async def api_export_contpaqi(
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    area_nombre: Optional[str] = None,
    tipo_periodo: str = "Quincenal",
    numero_periodo: int = 1,
    ejercicio: int = 2026,
    concepto_falta: str = "Faltas injustificadas",
    concepto_retardo: str = "Retardos",
    concepto_extra: str = "Horas extras dobles",
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(
        user["id"], empresa_id, sucursal_id, allow_all_branches=(sucursal_id == 0)
    )
    txt_content = db.generate_contpaqi_txt(
        empresa_id=emp_id,
        sucursal_id=suc_id,
        start_date=start_date,
        end_date=end_date,
        tipo_periodo=tipo_periodo,
        numero_periodo=numero_periodo,
        ejercicio=ejercicio,
        conceptos_map={
            "falta": concepto_falta,
            "retardo": concepto_retardo,
            "horas_extra": concepto_extra
        },
        area_nombre=area_nombre
    )
    try:
        txt_bytes = txt_content.encode("cp1252", errors="replace")
        media_type = "text/plain; charset=windows-1252"
    except Exception:
        txt_bytes = txt_content.encode("utf-8")
        media_type = "text/plain; charset=utf-8"

    filename = f"CONTPAQi_Incidencias_P{numero_periodo}.txt"
    return Response(
        content=txt_bytes,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.post("/api/reports/send-email")
async def api_send_report_email(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
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

    req_suc_id = payload.get("sucursal_id")
    parsed_suc_id = int(req_suc_id) if req_suc_id not in (None, "", "null") else None
    emp_id, suc_id = db.resolve_user_scope(
        user["id"],
        payload.get("empresa_id"),
        parsed_suc_id,
        allow_all_branches=(parsed_suc_id == 0)
    )

    cfg = db.get_email_config(mask_password=False, user_id=user["id"])
    if not to_email:
        to_email = cfg.get("destinatario_default")
    if not to_email:
        raise HTTPException(status_code=400, detail="Por favor indica un correo destinatario.")
    if not cfg.get("is_configured"):
        raise HTTPException(status_code=400, detail="El servidor de correo (SMTP) aún no ha sido configurado.")

    dataset = db.get_report_dataset(
        report_type=report_type,
        start_date=start_date,
        end_date=end_date,
        employee_id=employee_id,
        area=area,
        reloj=reloj,
        status_filter=status_filter,
        empresa_id=emp_id,
        sucursal_id=suc_id
    )

    report_title = dataset.get("title", "Reporte de Asistencia ACCESS")
    if not subject:
        today_fmt = datetime.date.today().strftime("%d/%m/%Y")
        subject = f"ACCESS — {report_title} ({today_fmt})"

    filter_parts = []
    if start_date and end_date:
        filter_parts.append(f"Periodo: {start_date} al {end_date}")
    else:
        filter_parts.append("Periodo: Todos los registros")
    filters_desc = " • ".join(filter_parts)

    summary_data = dataset.get("summary", {})
    kpis_list = [{"label": k.replace("_", " ").title(), "value": str(v), "hint": ""} for k, v in summary_data.items()]
    headers = dataset.get("headers", [])
    raw_data = dataset.get("data", [])
    table_rows = []

    if report_type == "bitacora":
        for r in raw_data:
            table_rows.append([
                str(r.get("id")), f"#{r.get('codigo_empleado')}", r.get("nombre", ""),
                r.get("area", ""), r.get("reloj_nombre", ""), r.get("metodo", ""),
                r.get("fecha_hora_display", ""), r.get("estatus_prenomina", "Válido")
            ])
    elif report_type == "empleados":
        for r in raw_data:
            table_rows.append([
                f"#{r.get('codigo_empleado')}", r.get("nombre", ""), r.get("area_nombre", ""),
                str(r.get("dias_asistidos", 0)), str(r.get("retardos", 0)), str(r.get("dias_incompletos", 0)),
                f"{r.get('horas_trabajadas', 0)} hrs", str(r.get("total_validas", 0)),
                str(r.get("total_rebotes", 0)), r.get("estatus", "")
            ])
    elif report_type == "relojes":
        for r in raw_data:
            table_rows.append([
                r.get("nombre", ""), r.get("ip", ""), r.get("modelo", ""), r.get("ubicacion", ""),
                str(r.get("total_eventos_periodo", 0)), str(r.get("validas", 0)), str(r.get("rebotes", 0)),
                str(r.get("usuarios_distintos", 0)), r.get("ultima_actividad", ""), r.get("estado", "ONLINE")
            ])
    else:
        for r in raw_data:
            table_rows.append([
                r.get("codigo", ""), r.get("nombre", ""), r.get("responsable", ""), r.get("turno", ""),
                r.get("horario", ""), str(r.get("plantilla", 0)), str(r.get("colaboradores_presentes", 0)),
                f"{r.get('cobertura_pct', 0)}%", str(r.get("total_validas", 0))
            ])

    html_email = mailer.generate_report_html(
        report_title=report_title,
        filters_desc=filters_desc,
        summary_kpis=kpis_list,
        headers=headers,
        rows=table_rows,
        notes=notes
    )

    attachment_bytes = None
    attachment_filename = None
    if attach_csv:
        csv_buffer = io.StringIO()
        csv_writer = csv.writer(csv_buffer)
        csv_writer.writerow(headers)
        clean_tag_re = re.compile(r'<[^>]+>')
        for row in table_rows:
            csv_writer.writerow([clean_tag_re.sub('', str(cell)) for cell in row])
        attachment_bytes = ("\ufeff" + csv_buffer.getvalue()).encode("utf-8")
        attachment_filename = f"reporte_{report_type}_{datetime.date.today().strftime('%Y%m%d')}.csv"

    res = await asyncio.to_thread(
        mailer.send_email_message,
        to_email=to_email,
        subject=subject,
        html_content=html_email,
        text_content=f"{report_title}\n{filters_desc}",
        attachment_filename=attachment_filename,
        attachment_bytes=attachment_bytes,
        config_override=cfg
    )
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Error al enviar el reporte por correo."))
    return {"status": "success", "message": f"Reporte enviado con éxito a {to_email}."}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=config.PORT)
