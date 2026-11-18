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
    """Recepción de checadas ZKTeco ADMS (table=ATTLOG separado por tabuladores)."""
    sn = (request.query_params.get("SN") or "").strip()
    table = (request.query_params.get("table") or "").strip().upper()
    clock = db.get_clock_by_serial(sn) if sn else None
    if not clock:
        return PlainTextResponse("OK: 0", status_code=404)

    db.touch_clock_heartbeat(clock["id"])
    if table != "ATTLOG":
        return PlainTextResponse("OK")

    raw_bytes = await request.body()
    raw_body = raw_bytes.decode("utf-8", errors="ignore")
    count = 0

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

        db.record_checkin(
            serial_no=None,
            emp_no=emp_no,
            nombre=f"Empleado #{emp_no}",
            tipo_evento="ZKTecoADMS",
            sub_event_type=sub_type,
            fecha_hora=dt_iso,
            reloj_nombre=clock["nombre"],
            empresa_id=clock["empresa_id"],
            sucursal_id=clock["sucursal_id"],
            reloj_id=clock["id"]
        )
        count += 1

    return PlainTextResponse(f"OK: {count}")


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


def _enrich_empleado(e: Any) -> Dict[str, Any]:
    d = dict(e)
    d["area"] = d.get("area_nombre") or "General"
    d["codigo_contpaqi"] = d.get("codigo_contpaqi") or ""
    d["sin_nombre"] = db.is_default_employee_name(d.get("nombre"), d.get("codigo_empleado"))
    return d


def _enrich_area(a: Any, conn: db.DualConnection) -> Dict[str, Any]:
    d = dict(a)
    horario = d.get("horario") or "08:00 - 17:00"
    parts = [p.strip() for p in horario.split("-")]
    d["hora_entrada"] = parts[0] if len(parts) >= 1 else "08:00"
    d["hora_salida"] = parts[1] if len(parts) >= 2 else "17:00"
    d["dias_laborales"] = d.get("dias_laborales") or "1,2,3,4,5"
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
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
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
            "employees": [],
            "empleados": []
        }

    summary = db.get_dashboard_summary(empresa_id=emp_id, sucursal_id=suc_id)
    records = db.list_checadas(limit=100, empresa_id=emp_id, sucursal_id=suc_id)

    conn = db.get_conn()
    conds = ["empresa_id = ?"]
    params = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    w_sql = " AND ".join(conds)
    p_tup = tuple(params)

    relojes = [_enrich_reloj(r, request) for r in conn.execute(f"SELECT * FROM relojes WHERE {w_sql} ORDER BY id ASC", p_tup).fetchall()]
    areas = [_enrich_area(r, conn) for r in conn.execute(f"SELECT * FROM areas WHERE {w_sql} ORDER BY id ASC", p_tup).fetchall()]
    empleados = [_enrich_empleado(r) for r in conn.execute(f"SELECT * FROM empleados WHERE {w_sql} ORDER BY id ASC", p_tup).fetchall()]
    conn.close()

    return {
        "status": "success",
        "companies": companies,
        "active_empresa_id": emp_id,
        "active_sucursal_id": suc_id,
        "summary": summary,
        "settings": user_settings,
        "subscription": user_sub,
        "recent_records": records,
        "devices": relojes,
        "relojes": relojes,
        "areas": areas,
        "employees": empleados,
        "empleados": empleados
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
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
    conn = db.get_conn()
    conds = ["empresa_id = ?"]
    params = [emp_id]
    if suc_id:
        conds.append("sucursal_id = ?")
        params.append(suc_id)
    rows = [_enrich_empleado(r) for r in conn.execute(f"SELECT * FROM empleados WHERE {' AND '.join(conds)} ORDER BY id ASC", tuple(params)).fetchall()]
    conn.close()
    return {"status": "success", "employees": rows}


@app.post("/api/employees")
async def api_create_or_update_employee(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(require_rh_active)
):
    """
    Registra o actualiza los datos de RH (Nombre, Área, Puesto, Turno) de un empleado
    en la sucursal seleccionada. El enrolamiento biométrico se hace directamente en el reloj físico.
    """
    req_emp_id = payload.get("empresa_id")
    req_suc_id = payload.get("sucursal_id")
    emp_id, suc_id = db.resolve_user_scope(user["id"], req_emp_id, req_suc_id)

    emp_no = str(payload.get("codigo_empleado", "")).strip()
    if not emp_no:
        raise HTTPException(status_code=400, detail="El ID de reloj del colaborador es obligatorio.")

    codigo_contpaqi = str(payload.get("codigo_contpaqi") or "").strip()
    nombre = (payload.get("nombre") or "").strip() or f"Empleado #{emp_no}"
    area_nombre = (payload.get("area") or payload.get("area_nombre") or "General").strip()
    puesto = (payload.get("puesto") or "Colaborador").strip()
    turno = (payload.get("turno") or "Matutino (08:00 - 17:00)").strip()
    pin = str(payload.get("pin") or "").strip()
    tiene_huella = 1 if payload.get("tiene_huella") else 0
    tiene_rostro = 1 if payload.get("tiene_rostro") else 0
    reloj_asignado = (payload.get("reloj_asignado") or "Sucursal Activa").strip()

    conn = db.get_conn()
    cur = conn.cursor()
    existing = cur.execute(
        "SELECT id FROM empleados WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ?",
        (emp_id, suc_id, emp_no)
    ).fetchone()
    if existing:
        cur.execute("""
            UPDATE empleados
            SET nombre = ?, codigo_contpaqi = ?, area_nombre = ?, puesto = ?, turno = ?, pin = ?,
                tiene_huella = COALESCE(?, tiene_huella), tiene_rostro = COALESCE(?, tiene_rostro)
            WHERE id = ?
        """, (nombre, codigo_contpaqi, area_nombre, puesto, turno, pin, tiene_huella, tiene_rostro, existing["id"]))
    else:
        cur.execute("""
            INSERT INTO empleados (
                empresa_id, sucursal_id, codigo_empleado, codigo_contpaqi, nombre, area_nombre, puesto, turno, pin,
                tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'ACTIVO')
        """, (emp_id, suc_id, emp_no, codigo_contpaqi, nombre, area_nombre, puesto, turno, pin, tiene_huella, tiene_rostro, reloj_asignado))
    cur.execute("""
        UPDATE checadas
        SET nombre = ?, area = ?
        WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ?
    """, (nombre, area_nombre, emp_id, suc_id, emp_no))
    conn.commit()
    conn.close()

    return {
        "ok": True,
        "status": "success",
        "message": f"Colaborador #{emp_no} ({nombre}) guardado en el catálogo de la sucursal."
    }


@app.delete("/api/employees/{emp_no}")
async def api_delete_employee(
    emp_no: str,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
    conn = db.get_conn()
    conn.execute(
        "DELETE FROM empleados WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ?",
        (emp_id, suc_id, str(emp_no))
    )
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success"}


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
    areas = [_enrich_area(r, conn) for r in conn.execute(f"SELECT * FROM areas WHERE {' AND '.join(conds)} ORDER BY id ASC", tuple(params)).fetchall()]
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
    hora_in = (payload.get("hora_entrada") or "08:00").strip()
    hora_out = (payload.get("hora_salida") or "17:00").strip()
    horario = payload.get("horario") or f"{hora_in} - {hora_out}"
    tolerancia_min = int(payload.get("tolerancia_min", 10))
    dias_laborales = str(payload.get("dias_laborales") or "1,2,3,4,5").strip()
    ubicacion = (payload.get("reloj_asignado") or payload.get("ubicacion") or "Sucursal Activa").strip()

    if not nombre:
        raise HTTPException(status_code=400, detail="El nombre del área es obligatorio.")

    conn = db.get_conn()
    cur = conn.cursor()
    if area_id:
        cur.execute("""
            UPDATE areas
            SET codigo = ?, nombre = ?, responsable = ?, turno = ?, horario = ?, tolerancia_min = ?, dias_laborales = ?, ubicacion = ?
            WHERE id = ? AND empresa_id = ?
        """, (codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, ubicacion, int(area_id), emp_id))
    else:
        cur.execute("""
            INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, ubicacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (emp_id, suc_id, codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, ubicacion))
    conn.commit()
    conn.close()
    return {"ok": True, "status": "success", "message": f"Área '{nombre}' guardada correctamente."}


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
    html_test = f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 16px; border: 1px solid #e4e4e7;">
        <div style="background: #18181b; color: white; padding: 16px 20px; border-radius: 12px; margin-bottom: 20px;">
            <div style="font-size: 10px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: #a1a1aa;">ACCESS CLOUD</div>
            <h2 style="margin: 4px 0 0 0; font-size: 18px; color: #ffffff;">Prueba de Conexión SMTP Exitosa</h2>
        </div>
        <p style="color: #3f3f46; font-size: 13px; line-height: 1.5;">Este es un mensaje de verificación generado desde <strong>ACCESS</strong> ({now_str}).</p>
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
    status: Optional[str] = None,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
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
    tipo_periodo: str = "Quincenal",
    numero_periodo: int = 1,
    ejercicio: int = 2026,
    concepto_falta: str = "Faltas injustificadas",
    concepto_retardo: str = "Retardos",
    concepto_extra: str = "Horas extras dobles",
    user: Dict[str, Any] = Depends(require_rh_active)
):
    emp_id, suc_id = db.resolve_user_scope(user["id"], empresa_id, sucursal_id)
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
        }
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

    emp_id, suc_id = db.resolve_user_scope(user["id"], payload.get("empresa_id"), payload.get("sucursal_id"))

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
