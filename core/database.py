"""
ACCESS — Capa de Persistencia Dual (SQLite Local + PostgreSQL Cloud Railway)
Soporta Multi-Empresa, Multi-Sucursal, Invitaciones con Clave Dinámica TOTP (5 min),
Aislamiento de Roles (ADMIN_SAAS vs CLIENTE_RH) y Protocolo One-Way Push Hikvision.
"""

import sqlite3
import datetime
import hashlib
import hmac
import secrets
import struct
import time
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import config

DB_FILE = Path(__file__).parent.parent / "access.db"

SUB_EVENT_LABELS = {
    75: ("ROSTRO", "Reconocimiento facial exitoso"),
    104: ("ROSTRO", "Autenticación rostro en vivo"),
    38: ("HUELLA", "Huella dactilar válida"),
    1: ("TARJETA", "Tarjeta RFID / Mifare válida"),
    9: ("PIN", "Apertura por código / clave"),
    181: ("PIN", "Autenticación por contraseña/PIN"),
}


# ==========================================
# ADAPTADOR DUAL: SQLITE (LOCAL) / POSTGRESQL (RAILWAY)
# ==========================================

class DualCursor:
    """Envuelve el cursor de SQLite o Psycopg2 (PostgreSQL) unificando placeholders y diccionarios."""
    def __init__(self, raw_cursor, is_pg: bool):
        self._cur = raw_cursor
        self._is_pg = is_pg
        self.lastrowid = None

    def _translate_sql(self, sql: str) -> str:
        if not self._is_pg:
            return sql
        out = sql.replace("?", "%s")
        out = out.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        out = out.replace("INSERT OR IGNORE INTO", "INSERT INTO")
        return out

    def execute(self, sql: str, params: Tuple = ()):
        q = self._translate_sql(sql)
        if self._is_pg:
            is_insert = q.lstrip().upper().startswith("INSERT") and "RETURNING" not in q.upper()
            if "INSERT OR IGNORE" in sql.upper() and "ON CONFLICT" not in q.upper():
                q = q.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
            if is_insert and "ON CONFLICT DO NOTHING" not in q.upper():
                try:
                    self._cur.execute(q.rstrip().rstrip(";") + " RETURNING id", params)
                    row = self._cur.fetchone()
                    if row and "id" in row:
                        self.lastrowid = row["id"]
                    return self
                except Exception:
                    pass
            self._cur.execute(q, params)
        else:
            self._cur.execute(q, params)
            self.lastrowid = self._cur.lastrowid
        return self

    def executemany(self, sql: str, seq_of_params):
        q = self._translate_sql(sql)
        if self._is_pg and "INSERT OR IGNORE" in sql.upper():
            q = q.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
        self._cur.executemany(q, seq_of_params)
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()


class DualConnection:
    """Conexión unificada compatible con SQLite local y PostgreSQL en Railway."""
    def __init__(self):
        self.is_pg = config.IS_POSTGRES
        if self.is_pg:
            import psycopg2
            import psycopg2.extras
            self._conn = psycopg2.connect(config.DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
        else:
            self._conn = sqlite3.connect(DB_FILE, timeout=15.0)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
            self._conn.execute("PRAGMA foreign_keys=ON;")

    def cursor(self) -> DualCursor:
        return DualCursor(self._conn.cursor(), self.is_pg)

    def execute(self, sql: str, params: Tuple = ()) -> DualCursor:
        cur = self.cursor()
        cur.execute(sql, params)
        return cur

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_conn() -> DualConnection:
    return DualConnection()


def _table_columns(conn: DualConnection, table_name: str) -> List[str]:
    if conn.is_pg:
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
            (table_name,)
        ).fetchall()
        return [r["column_name"] for r in rows]
    else:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        return [r["name"] for r in rows]


def _ensure_column(conn: DualConnection, table: str, col: str, col_def: str):
    cols = _table_columns(conn, table)
    if col not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_def}")


# ==========================================
# CLAVE DINÁMICA DE INVITACIÓN CADA 5 MINUTOS (TOTP 300s)
# ==========================================

def generate_totp_code(totp_secret: str, timestamp: Optional[float] = None) -> Dict[str, Any]:
    """
    Genera la Clave Dinámica de 6 dígitos que se renueva cada 5 minutos (300 segundos)
    para autorizar la unión de usuarios de RH a una empresa.
    """
    window = config.TOTP_WINDOW_SECONDS  # 300 segundos (5 minutos)
    now_ts = int(timestamp if timestamp is not None else time.time())
    time_slot = now_ts // window
    expires_in = window - (now_ts % window)

    secret_bytes = (totp_secret or config.SECRET_KEY).encode("utf-8")
    msg = struct.pack(">Q", time_slot)
    digest = hmac.new(secret_bytes, msg, hashlib.sha256).digest()
    offset = digest[-1] & 0x0F
    code_int = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1000000
    code_str = f"{code_int:06d}"

    return {
        "clave_dinamica": code_str,
        "clave_formateada": f"{code_str[:3]} {code_str[3:]}",
        "expires_in_seconds": expires_in,
        "window_seconds": window,
        "time_slot": time_slot
    }


def verify_totp_code(totp_secret: str, candidate_code: str) -> bool:
    """Verifica si la clave dinámica ingresada coincide con la ventana vigente de 5 minutos."""
    clean_candidate = "".join(ch for ch in (candidate_code or "") if ch.isdigit())
    if len(clean_candidate) != 6:
        return False
    current = generate_totp_code(totp_secret)["clave_dinamica"]
    return secrets.compare_digest(clean_candidate, current)


# ==========================================
# UTILIDADES DE AUTENTICACIÓN, ROLES Y SUSCRIPCIONES
# ==========================================

def hash_password(password: str, salt: Optional[str] = None) -> str:
    """Genera un hash SHA-256 seguro con salting aleatorio."""
    if not salt:
        salt = secrets.token_hex(16)
    hashed = hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()
    return f"{salt}:{hashed}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Verifica una contraseña contra su hash con salt."""
    if not stored_hash or ":" not in stored_hash:
        return False
    salt, expected = stored_hash.split(":", 1)
    calculated = hashlib.sha256(f"{salt}:{password}".encode("utf-8")).hexdigest()
    return secrets.compare_digest(calculated, expected)


def get_user_subscription(user_id: int, conn: Optional[DualConnection] = None) -> Dict[str, Any]:
    """Obtiene el estado de suscripción del usuario y evalúa si está vigente."""
    close_after = False
    if conn is None:
        conn = get_conn()
        close_after = True

    row = conn.execute("""
        SELECT id, user_id, plan, estado, fecha_inicio, fecha_vencimiento, max_empresas, max_relojes, notas
        FROM suscripciones
        WHERE user_id = ?
    """, (user_id,)).fetchone()

    if close_after:
        conn.close()

    today_str = datetime.date.today().strftime("%Y-%m-%d")
    if not row:
        return {
            "plan": "MENSUAL",
            "estado": "VENCIDA",
            "fecha_inicio": today_str,
            "fecha_vencimiento": today_str,
            "max_empresas": 3,
            "max_relojes": 10,
            "is_active": False,
            "dias_restantes": 0,
            "notas": "Sin suscripción asignada"
        }

    exp_str = str(row["fecha_vencimiento"] or "")[:10]
    estado = (row["estado"] or "ACTIVA").upper()
    dias_restantes = 0
    try:
        dt_exp = datetime.date.fromisoformat(exp_str)
        dias_restantes = (dt_exp - datetime.date.today()).days
    except Exception:
        dias_restantes = 0

    if estado == "ACTIVA" and exp_str and exp_str < today_str:
        estado = "VENCIDA"

    is_active = (estado in ("ACTIVA", "PRUEBA")) and (dias_restantes >= 0)
    return {
        "id": row["id"],
        "plan": row["plan"] or "MENSUAL",
        "estado": estado,
        "fecha_inicio": str(row["fecha_inicio"] or "")[:10],
        "fecha_vencimiento": exp_str,
        "max_empresas": row["max_empresas"] or 5,
        "max_relojes": row["max_relojes"] or 10,
        "is_active": is_active,
        "dias_restantes": max(0, dias_restantes),
        "notas": row["notas"] or ""
    }


def _build_user_dict(row: Any, conn: DualConnection) -> Dict[str, Any]:
    name_parts = (row["nombre"] or "Usuario").split()
    initials = "".join([p[0] for p in name_parts[:2]]).upper() if name_parts else "US"
    rol_sistema = (row["rol_sistema"] if "rol_sistema" in row.keys() and row["rol_sistema"] else "CLIENTE_RH").upper()
    sub = get_user_subscription(row["id"], conn) if rol_sistema == "CLIENTE_RH" else {
        "plan": "ADMIN_SISTEMA",
        "estado": "ACTIVA",
        "is_active": True,
        "fecha_vencimiento": "2099-12-31",
        "dias_restantes": 9999
    }
    return {
        "id": row["id"],
        "username": row["username"],
        "email": row["email"],
        "name": row["nombre"],
        "role": row["rol"],
        "role_type": rol_sistema,  # 'ADMIN_SAAS' | 'CLIENTE_RH'
        "avatar": initials,
        "shift": row["turno"],
        "node": row["nodo"],
        "subscription": sub
    }


def authenticate_user(identifier: str, password: str) -> Optional[Dict[str, Any]]:
    """Valida credenciales contra la base de datos."""
    clean_id = (identifier or "").strip().lower()
    if not clean_id or not password:
        return None
    conn = get_conn()
    row = conn.execute("""
        SELECT id, username, email, password_hash, nombre, rol, rol_sistema, turno, nodo, activo
        FROM usuarios_sistema
        WHERE LOWER(email) = ? OR LOWER(username) = ?
    """, (clean_id, clean_id)).fetchone()
    if not row or not row["activo"]:
        conn.close()
        return None
    if verify_password(password, row["password_hash"]):
        user_dict = _build_user_dict(row, conn)
        conn.close()
        return user_dict
    conn.close()
    return None


def create_user_session(user_id: int, username: str, duration_hours: int = 24) -> str:
    """Crea una sesión firmada persistida en la base de datos."""
    token = secrets.token_urlsafe(32)
    now = datetime.datetime.now()
    expires_at = (now + datetime.timedelta(hours=duration_hours)).strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    conn.execute("""
        INSERT INTO sesiones_usuario (token, user_id, username, expires_at)
        VALUES (?, ?, ?, ?)
    """, (token, user_id, username, expires_at))
    conn.commit()
    conn.close()
    return token


def get_user_from_session(token: str) -> Optional[Dict[str, Any]]:
    """Obtiene el usuario autenticado y su estado de suscripción desde su sesión activa."""
    if not token:
        return None
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    row = conn.execute("""
        SELECT u.id, u.username, u.email, u.nombre, u.rol, u.rol_sistema, u.turno, u.nodo, u.activo
        FROM sesiones_usuario s
        JOIN usuarios_sistema u ON s.user_id = u.id
        WHERE s.token = ? AND s.expires_at > ? AND u.activo = 1
    """, (token, now_str)).fetchone()
    if not row:
        conn.close()
        return None
    user_dict = _build_user_dict(row, conn)
    conn.close()
    return user_dict


def delete_user_session(token: str):
    """Elimina una sesión activa (Logout)."""
    if not token:
        return
    conn = get_conn()
    conn.execute("DELETE FROM sesiones_usuario WHERE token = ?", (token,))
    conn.commit()
    conn.close()


# ==========================================
# INICIALIZACIÓN Y MIGRACIÓN AUTOMÁTICA DE ESQUEMA
# ==========================================

def init_db():
    conn = get_conn()
    cur = conn.cursor()

    # 1. Tabla de Usuarios del Sistema (con rol_sistema: ADMIN_SAAS | CLIENTE_RH)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS usuarios_sistema (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            nombre TEXT NOT NULL,
            rol TEXT NOT NULL,
            rol_sistema TEXT DEFAULT 'CLIENTE_RH',
            turno TEXT DEFAULT 'Matutino (08:00 - 17:00)',
            nodo TEXT DEFAULT 'Cloud • Push',
            activo INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    _ensure_column(conn, "usuarios_sistema", "rol_sistema", "TEXT DEFAULT 'CLIENTE_RH'")

    # 2. Tabla de Sesiones Activas
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sesiones_usuario (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL
        );
    """)

    # 3. Tabla de Suscripciones (Administrada por ADMIN_SAAS)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS suscripciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE NOT NULL,
            plan TEXT DEFAULT 'MENSUAL',
            estado TEXT DEFAULT 'ACTIVA',
            fecha_inicio TEXT NOT NULL,
            fecha_vencimiento TEXT NOT NULL,
            max_empresas INTEGER DEFAULT 5,
            max_relojes INTEGER DEFAULT 10,
            notas TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # 4. Tabla de Empresas (Multi-Tenant)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS empresas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            rfc TEXT DEFAULT '',
            industria TEXT DEFAULT 'General',
            codigo_invitacion TEXT UNIQUE NOT NULL,
            totp_secret TEXT NOT NULL,
            owner_user_id INTEGER NOT NULL,
            activo INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # 5. Tabla de Relación Muchos-a-Muchos: Usuarios RH <-> Empresas
    cur.execute("""
        CREATE TABLE IF NOT EXISTS empresa_usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            rol_empresa TEXT DEFAULT 'MIEMBRO_RH',
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(empresa_id, user_id)
        );
    """)

    # 6. Tabla de Sucursales (Por Empresa)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sucursales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            codigo TEXT NOT NULL,
            nombre TEXT NOT NULL,
            ubicacion TEXT DEFAULT '',
            timezone TEXT DEFAULT 'America/Mexico_City',
            debounce_seconds INTEGER DEFAULT 180,
            tolerancia_minutos INTEGER DEFAULT 10,
            activo INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # 7. Tabla de Relojes Checadores (1 o más por Sucursal, protocolo One-Way Push)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS relojes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER DEFAULT 1,
            sucursal_id INTEGER DEFAULT 1,
            nombre TEXT NOT NULL,
            modelo TEXT DEFAULT 'DS-K1T320MFWX-B',
            serie TEXT DEFAULT '',
            mac TEXT DEFAULT '',
            firmware TEXT DEFAULT 'V3.5.2',
            ip TEXT NOT NULL,
            puerto INTEGER DEFAULT 80,
            usuario TEXT DEFAULT 'admin',
            password TEXT DEFAULT '',
            red_tipo TEXT DEFAULT 'Wi-Fi',
            area_asignada TEXT DEFAULT 'General',
            ubicacion TEXT DEFAULT 'Acceso Principal',
            webhook_token TEXT,
            estado TEXT DEFAULT 'ONLINE',
            total_eventos INTEGER DEFAULT 0,
            total_usuarios INTEGER DEFAULT 0,
            ultimo_serial INTEGER DEFAULT 0,
            ultimo_cursor INTEGER DEFAULT 0,
            ultima_sincronizacion TEXT
        );
    """)
    _ensure_column(conn, "relojes", "empresa_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "relojes", "sucursal_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "relojes", "webhook_token", "TEXT")
    _ensure_column(conn, "relojes", "ultimo_serial", "INTEGER DEFAULT 0")
    _ensure_column(conn, "relojes", "ultimo_cursor", "INTEGER DEFAULT 0")

    # 8. Tabla de Áreas / Departamentos
    cur.execute("""
        CREATE TABLE IF NOT EXISTS areas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER DEFAULT 1,
            sucursal_id INTEGER DEFAULT 1,
            codigo TEXT,
            nombre TEXT NOT NULL,
            responsable TEXT,
            turno TEXT,
            horario TEXT,
            tolerancia_min INTEGER DEFAULT 10,
            ubicacion TEXT,
            activo INTEGER DEFAULT 1
        );
    """)
    _ensure_column(conn, "areas", "empresa_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "areas", "sucursal_id", "INTEGER DEFAULT 1")

    # 9. Tabla de Empleados
    cur.execute("""
        CREATE TABLE IF NOT EXISTS empleados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER DEFAULT 1,
            sucursal_id INTEGER DEFAULT 1,
            codigo_empleado TEXT NOT NULL,
            nombre TEXT NOT NULL,
            area_nombre TEXT DEFAULT 'General',
            puesto TEXT DEFAULT 'Colaborador',
            turno TEXT DEFAULT 'Matutino (08:00 - 17:00)',
            pin TEXT DEFAULT '123456',
            tiene_huella INTEGER DEFAULT 0,
            tiene_rostro INTEGER DEFAULT 0,
            tiene_tarjeta INTEGER DEFAULT 0,
            admin_ui INTEGER DEFAULT 0,
            reloj_asignado TEXT DEFAULT 'Cerro Gordo',
            estado TEXT DEFAULT 'ACTIVO'
        );
    """)
    _ensure_column(conn, "empleados", "empresa_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "empleados", "sucursal_id", "INTEGER DEFAULT 1")

    # 10. Tabla de Checadas
    cur.execute("""
        CREATE TABLE IF NOT EXISTS checadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER DEFAULT 1,
            sucursal_id INTEGER DEFAULT 1,
            reloj_id INTEGER DEFAULT 1,
            serial_no INTEGER,
            codigo_empleado TEXT,
            nombre TEXT,
            tipo_evento TEXT,
            sub_event_type INTEGER,
            metodo TEXT DEFAULT 'BIOMETRÍA',
            area TEXT DEFAULT 'General',
            reloj_nombre TEXT DEFAULT 'Cerro Gordo',
            fecha_hora_evento TEXT,
            es_rebote INTEGER DEFAULT 0,
            es_manual INTEGER DEFAULT 0,
            nota_incidencia TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    _ensure_column(conn, "checadas", "empresa_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "checadas", "sucursal_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "checadas", "reloj_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "checadas", "metodo", "TEXT DEFAULT 'BIOMETRÍA'")
    _ensure_column(conn, "checadas", "area", "TEXT DEFAULT 'General'")
    _ensure_column(conn, "checadas", "reloj_nombre", "TEXT DEFAULT 'Cerro Gordo'")
    _ensure_column(conn, "checadas", "es_manual", "INTEGER DEFAULT 0")
    _ensure_column(conn, "checadas", "nota_incidencia", "TEXT DEFAULT ''")

    # 11. Tabla de Settings y Correo SMTP
    cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
    default_settings = [
        ("debounce_seconds", "180"),
        ("tolerancia_minutos", "10"),
        ("operator_name", "Angel Flores"),
        ("operator_role", "Director de RH y Sistemas"),
        ("operator_email", "angel.flores@quodo.mx"),
        ("operator_shift", "Mixto (08:00 - 17:30)"),
        ("sound_alerts", "1"),
        ("auto_scroll", "1")
    ]
    cur.executemany("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", default_settings)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS config_correo (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            smtp_host TEXT DEFAULT 'smtp.gmail.com',
            smtp_port INTEGER DEFAULT 587,
            smtp_user TEXT DEFAULT '',
            smtp_password TEXT DEFAULT '',
            smtp_security TEXT DEFAULT 'STARTTLS',
            remitente_nombre TEXT DEFAULT 'ACCESS - Control Biométrico',
            remitente_email TEXT DEFAULT '',
            destinatario_default TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cur.execute("""
        INSERT OR IGNORE INTO config_correo (
            id, smtp_host, smtp_port, smtp_user, smtp_password, smtp_security, remitente_nombre, remitente_email, destinatario_default
        ) VALUES (1, ?, ?, ?, ?, 'STARTTLS', ?, ?, ?)
    """, (
        getattr(config, "SMTP_HOST", "smtp.gmail.com"),
        getattr(config, "SMTP_PORT", 587),
        getattr(config, "SMTP_USER", ""),
        getattr(config, "SMTP_PASS", ""),
        getattr(config, "SMTP_SENDER_NAME", "ACCESS - Control Biométrico"),
        getattr(config, "SMTP_USER", ""),
        getattr(config, "SMTP_DEFAULT_RECIPIENT", "")
    ))

    # ==========================================
    # SEMILLAS MULTI-TENANT Y ROLES (ADMIN_SAAS + CLIENTE_RH)
    # ==========================================
    user_count = cur.execute("SELECT COUNT(*) as c FROM usuarios_sistema").fetchone()["c"]
    if user_count == 0:
        default_users = [
            ("admin.saas", "angggggjfm@gmail.com", hash_password("admin123"), "Administrador General SaaS", "Gestor de Cuentas y Suscripciones", "ADMIN_SAAS", "Global 24/7", "Consola Suscripciones SaaS", 1),
            ("sistemas.tbs", "sistemastbs@tbsmx.com", hash_password("tbsmx123"), "Sistemas TBS", "Recursos Humanos", "CLIENTE_RH", "Oficina", "Multiempresa • Cloud", 1),
        ]
        cur.executemany("""
            INSERT INTO usuarios_sistema (username, email, password_hash, nombre, rol, rol_sistema, turno, nodo, activo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, default_users)

    # Asegurar suscripciones activas para usuarios CLIENTE_RH sin registro en suscripciones
    rh_users = cur.execute("SELECT id, email FROM usuarios_sistema WHERE rol_sistema = 'CLIENTE_RH'").fetchall()
    today = datetime.date.today()
    for u in rh_users:
        sub_row = cur.execute("SELECT id FROM suscripciones WHERE user_id = ?", (u["id"],)).fetchone()
        if not sub_row:
            f_ini = (today - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
            f_fin = (today + datetime.timedelta(days=365)).strftime("%Y-%m-%d")
            cur.execute("""
                INSERT INTO suscripciones (user_id, plan, estado, fecha_inicio, fecha_vencimiento, max_empresas, max_relojes, notas)
                VALUES (?, 'ANUAL ENTERPRISE', 'ACTIVA', ?, ?, 10, 25, 'Suscripción activa')
            """, (u["id"], f_ini, f_fin))

    # Asegurar que todos los relojes existentes tengan webhook_token
    clocks_no_token = cur.execute("SELECT id, nombre FROM relojes WHERE webhook_token IS NULL OR webhook_token = ''").fetchall()
    for clk in clocks_no_token:
        slug = "".join(c for c in clk["nombre"].lower() if c.isalnum())[:12] or "clock"
        tok = f"hik_{slug}_{secrets.token_hex(4)}"
        cur.execute("UPDATE relojes SET webhook_token = ? WHERE id = ?", (tok, clk["id"]))

    conn.commit()
    conn.close()


init_db()


# ==========================================
# GESTIÓN MULTI-EMPRESA, MULTI-SUCURSAL Y ACCESOS RH
# ==========================================

def get_user_companies(user_id: int) -> List[Dict[str, Any]]:
    """
    Devuelve todas las empresas a las que tiene acceso un usuario CLIENTE_RH,
    incluyendo sus sucursales, relojes por sucursal y su rol en cada empresa (OWNER | MIEMBRO_RH).
    """
    conn = get_conn()
    rows = conn.execute("""
        SELECT e.id, e.nombre, e.rfc, e.industria, e.codigo_invitacion, e.owner_user_id,
               eu.rol_empresa, eu.joined_at
        FROM empresas e
        JOIN empresa_usuarios eu ON eu.empresa_id = e.id
        WHERE eu.user_id = ? AND e.activo = 1
        ORDER BY e.id ASC
    """, (user_id,)).fetchall()

    companies = []
    for r in rows:
        emp_id = r["id"]
        branches_rows = conn.execute("""
            SELECT id, empresa_id, codigo, nombre, ubicacion, timezone, debounce_seconds, tolerancia_minutos
            FROM sucursales
            WHERE empresa_id = ? AND activo = 1
            ORDER BY id ASC
        """, (emp_id,)).fetchall()

        branches = []
        for b in branches_rows:
            clocks_cnt = conn.execute(
                "SELECT COUNT(*) as c FROM relojes WHERE sucursal_id = ?", (b["id"],)
            ).fetchone()["c"]
            emps_cnt = conn.execute(
                "SELECT COUNT(*) as c FROM empleados WHERE sucursal_id = ?", (b["id"],)
            ).fetchone()["c"]
            branches.append({
                "id": b["id"],
                "empresa_id": b["empresa_id"],
                "codigo": b["codigo"],
                "nombre": b["nombre"],
                "ubicacion": b["ubicacion"],
                "timezone": b["timezone"],
                "debounce_seconds": b["debounce_seconds"],
                "tolerancia_minutos": b["tolerancia_minutos"],
                "relojes_count": clocks_cnt,
                "empleados_count": emps_cnt
            })

        members_rows = conn.execute("""
            SELECT u.id, u.nombre, u.email, eu.rol_empresa, eu.joined_at
            FROM empresa_usuarios eu
            JOIN usuarios_sistema u ON u.id = eu.user_id
            WHERE eu.empresa_id = ?
            ORDER BY eu.rol_empresa DESC, u.nombre ASC
        """, (emp_id,)).fetchall()

        companies.append({
            "id": emp_id,
            "nombre": r["nombre"],
            "rfc": r["rfc"] or "",
            "industria": r["industria"] or "General",
            "codigo_invitacion": r["codigo_invitacion"],
            "owner_user_id": r["owner_user_id"],
            "rol_empresa": r["rol_empresa"],
            "is_owner": (r["rol_empresa"] == "OWNER" or r["owner_user_id"] == user_id),
            "sucursales": branches,
            "usuarios_miembros": [dict(m) for m in members_rows]
        })

    conn.close()
    return companies


def user_has_company_access(user_id: int, empresa_id: int) -> Optional[str]:
    """Retorna el rol del usuario en la empresa ('OWNER' | 'MIEMBRO_RH') o None si no tiene acceso."""
    conn = get_conn()
    row = conn.execute("""
        SELECT rol_empresa FROM empresa_usuarios
        WHERE user_id = ? AND empresa_id = ?
    """, (user_id, empresa_id)).fetchone()
    conn.close()
    return row["rol_empresa"] if row else None


def resolve_user_scope(user_id: int, empresa_id: Optional[int] = None, sucursal_id: Optional[int] = None) -> Tuple[int, Optional[int]]:
    """
    Valida y resuelve el par (empresa_id, sucursal_id) autorizado para el usuario RH.
    Garantiza que jamás pueda consultar datos de una empresa ajena.
    """
    companies = get_user_companies(user_id)
    if not companies:
        return (0, None)

    target_comp = None
    if empresa_id:
        target_comp = next((c for c in companies if c["id"] == int(empresa_id)), None)
    if not target_comp:
        target_comp = companies[0]

    emp_id = target_comp["id"]
    branches = target_comp.get("sucursales", [])
    if sucursal_id:
        valid_b = next((b for b in branches if b["id"] == int(sucursal_id)), None)
        if valid_b:
            return (emp_id, valid_b["id"])
    return (emp_id, branches[0]["id"] if branches else None)


def create_company_for_user(user_id: int, nombre: str, rfc: str = "", industria: str = "General", first_branch_name: str = "Sucursal Matriz") -> Dict[str, Any]:
    """Crea una nueva empresa asignando al usuario como OWNER y crea su primera sucursal."""
    conn = get_conn()
    cur = conn.cursor()

    clean_prefix = "".join(c for c in nombre.upper() if c.isalnum())[:5] or "EMP"
    invite_code = f"EMP-{clean_prefix}-{secrets.token_hex(2).upper()}"
    totp_secret = secrets.token_hex(16)

    cur.execute("""
        INSERT INTO empresas (nombre, rfc, industria, codigo_invitacion, totp_secret, owner_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (nombre.strip(), rfc.strip().upper(), industria.strip(), invite_code, totp_secret, user_id))
    emp_id = cur.lastrowid

    cur.execute("""
        INSERT INTO empresa_usuarios (empresa_id, user_id, rol_empresa)
        VALUES (?, ?, 'OWNER')
    """, (emp_id, user_id))

    cur.execute("""
        INSERT INTO sucursales (empresa_id, codigo, nombre, ubicacion, debounce_seconds, tolerancia_minutos)
        VALUES (?, 'SUC-01', ?, 'Acceso Principal', 180, 10)
    """, (emp_id, first_branch_name.strip() or "Sucursal Matriz"))
    suc_id = cur.lastrowid

    # Crear área general inicial para la sucursal
    cur.execute("""
        INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, ubicacion)
        VALUES (?, ?, 'AREA-GEN', 'Operaciones Generales', 'RH', 'Matutino', '08:00 - 17:00', 10, ?)
    """, (emp_id, suc_id, first_branch_name.strip() or "Sucursal Matriz"))

    conn.commit()
    conn.close()
    return {
        "empresa_id": emp_id,
        "sucursal_id": suc_id,
        "nombre": nombre,
        "codigo_invitacion": invite_code
    }


def create_branch_for_company(empresa_id: int, nombre: str, ubicacion: str = "", codigo: str = "", debounce_seconds: int = 180, tolerancia_minutos: int = 10) -> Dict[str, Any]:
    """Crea una nueva sucursal dentro de una empresa existente."""
    conn = get_conn()
    cur = conn.cursor()
    cnt = cur.execute("SELECT COUNT(*) as c FROM sucursales WHERE empresa_id = ?", (empresa_id,)).fetchone()["c"]
    code_str = codigo.strip().upper() or f"SUC-0{cnt + 1}"

    cur.execute("""
        INSERT INTO sucursales (empresa_id, codigo, nombre, ubicacion, debounce_seconds, tolerancia_minutos)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (empresa_id, code_str, nombre.strip(), ubicacion.strip() or "Acceso Principal", int(debounce_seconds), int(tolerancia_minutos)))
    suc_id = cur.lastrowid

    cur.execute("""
        INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, ubicacion)
        VALUES (?, ?, 'AREA-01', 'General Sucursal', 'RH', 'Matutino', '08:00 - 17:00', ?, ?)
    """, (empresa_id, suc_id, int(tolerancia_minutos), nombre.strip()))

    conn.commit()
    conn.close()
    return {"id": suc_id, "empresa_id": empresa_id, "codigo": code_str, "nombre": nombre}


def get_company_invitation_totp(user_id: int, empresa_id: int) -> Optional[Dict[str, Any]]:
    """
    Devuelve el Código de Invitación y la Clave Dinámica de 5 minutos (TOTP)
    exclusivamente si el usuario solicitante es el creador/administrador (OWNER) de la empresa.
    """
    conn = get_conn()
    row = conn.execute("""
        SELECT e.id, e.nombre, e.codigo_invitacion, e.totp_secret, e.owner_user_id, eu.rol_empresa
        FROM empresas e
        JOIN empresa_usuarios eu ON eu.empresa_id = e.id
        WHERE e.id = ? AND eu.user_id = ?
    """, (empresa_id, user_id)).fetchone()
    conn.close()

    if not row:
        return None
    if row["rol_empresa"] != "OWNER" and row["owner_user_id"] != user_id:
        return {"error": "not_owner"}

    totp_info = generate_totp_code(row["totp_secret"])
    return {
        "empresa_id": row["id"],
        "empresa_nombre": row["nombre"],
        "codigo_invitacion": row["codigo_invitacion"],
        **totp_info
    }


def join_company_by_invite(user_id: int, codigo_invitacion: str, clave_dinamica: str) -> Dict[str, Any]:
    """
    Valida el Código de Invitación de la empresa y su Clave Dinámica de 5 minutos (TOTP).
    Si ambos son correctos, agrega al usuario RH como miembro autorizado de la empresa.
    """
    clean_invite = (codigo_invitacion or "").strip().upper()
    conn = get_conn()
    emp = conn.execute("""
        SELECT id, nombre, codigo_invitacion, totp_secret
        FROM empresas
        WHERE UPPER(codigo_invitacion) = ? AND activo = 1
    """, (clean_invite,)).fetchone()

    if not emp:
        conn.close()
        return {"ok": False, "error": "El código de invitación de empresa no existe o es incorrecto."}

    if not verify_totp_code(emp["totp_secret"], clave_dinamica):
        conn.close()
        return {
            "ok": False,
            "error": "La Clave Dinámica de 5 minutos es inválida o ya expiró. Solicita al administrador de la empresa el código vigente."
        }

    existing = conn.execute("""
        SELECT id FROM empresa_usuarios WHERE empresa_id = ? AND user_id = ?
    """, (emp["id"], user_id)).fetchone()
    if existing:
        conn.close()
        return {"ok": True, "already_member": True, "empresa_id": emp["id"], "nombre": emp["nombre"]}

    conn.execute("""
        INSERT INTO empresa_usuarios (empresa_id, user_id, rol_empresa)
        VALUES (?, ?, 'MIEMBRO_RH')
    """, (emp["id"], user_id))
    conn.commit()
    conn.close()
    return {"ok": True, "already_member": False, "empresa_id": emp["id"], "nombre": emp["nombre"]}


# ==========================================
# GESTIÓN EXCLUSIVA DEL ADMINISTRADOR SAAS (SIN ACCESO A DATOS CONFIDENCIALES)
# ==========================================

def admin_list_users_and_subscriptions() -> List[Dict[str, Any]]:
    """
    Lista únicamente las cuentas de usuario CLIENTE_RH y el estatus de su suscripción.
    NO expone nombres de empresas, ni sucursales, ni IPs de relojes, ni empleados, ni checadas.
    """
    conn = get_conn()
    rows = conn.execute("""
        SELECT id, username, email, nombre, rol, rol_sistema, activo, created_at
        FROM usuarios_sistema
        WHERE rol_sistema = 'CLIENTE_RH'
        ORDER BY id ASC
    """).fetchall()

    result = []
    for r in rows:
        sub = get_user_subscription(r["id"], conn)
        # Solo conteo numérico de cuota utilizada (sin nombres ni datos confidenciales)
        empresas_count = conn.execute(
            "SELECT COUNT(*) as c FROM empresa_usuarios WHERE user_id = ?", (r["id"],)
        ).fetchone()["c"]
        result.append({
            "id": r["id"],
            "username": r["username"],
            "email": r["email"],
            "nombre": r["nombre"],
            "puesto": r["rol"],
            "activo": bool(r["activo"]),
            "created_at": str(r["created_at"] or "")[:19],
            "empresas_vinculadas_count": empresas_count,
            "subscription": sub
        })
    conn.close()
    return result


def admin_create_rh_user(data: Dict[str, Any]) -> Dict[str, Any]:
    """Permite al ADMIN_SAAS registrar un nuevo usuario CLIENTE_RH con su suscripción inicial."""
    email = (data.get("email") or "").strip().lower()
    username = (data.get("username") or email.split("@")[0]).strip().lower()
    nombre = (data.get("nombre") or "").strip()
    password = (data.get("password") or "123456").strip()
    rol = (data.get("rol") or "Ejecutivo de Recursos Humanos").strip()
    plan = (data.get("plan") or "MENSUAL").strip().upper()
    estado_sub = (data.get("estado") or "ACTIVA").strip().upper()
    dias_vigencia = int(data.get("dias_vigencia") or 30)
    max_empresas = int(data.get("max_empresas") or 5)
    max_relojes = int(data.get("max_relojes") or 10)
    notas = (data.get("notas") or "").strip()

    if not email or not nombre:
        return {"ok": False, "error": "Nombre y correo electrónico son obligatorios."}

    conn = get_conn()
    cur = conn.cursor()
    dup = cur.execute(
        "SELECT id FROM usuarios_sistema WHERE LOWER(email) = ? OR LOWER(username) = ?",
        (email, username)
    ).fetchone()
    if dup:
        conn.close()
        return {"ok": False, "error": "Ya existe un usuario registrado con ese correo o username."}

    cur.execute("""
        INSERT INTO usuarios_sistema (username, email, password_hash, nombre, rol, rol_sistema, turno, nodo, activo)
        VALUES (?, ?, ?, ?, ?, 'CLIENTE_RH', 'Oficina RH', 'Cloud • Multiempresa', 1)
    """, (username, email, hash_password(password), nombre, rol))
    new_user_id = cur.lastrowid

    today = datetime.date.today()
    f_ini = today.strftime("%Y-%m-%d")
    f_fin = (today + datetime.timedelta(days=dias_vigencia)).strftime("%Y-%m-%d")

    cur.execute("""
        INSERT INTO suscripciones (user_id, plan, estado, fecha_inicio, fecha_vencimiento, max_empresas, max_relojes, notas)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (new_user_id, plan, estado_sub, f_ini, f_fin, max_empresas, max_relojes, notas))

    conn.commit()
    conn.close()
    return {"ok": True, "user_id": new_user_id}


def admin_update_user_subscription(user_id: int, data: Dict[str, Any]) -> Dict[str, Any]:
    """Permite al ADMIN_SAAS activar, suspender, renovar o ajustar límites de la suscripción de un usuario RH."""
    conn = get_conn()
    cur = conn.cursor()
    u = cur.execute("SELECT id, rol_sistema FROM usuarios_sistema WHERE id = ?", (user_id,)).fetchone()
    if not u or u["rol_sistema"] != "CLIENTE_RH":
        conn.close()
        return {"ok": False, "error": "Usuario RH no encontrado."}

    if "activo" in data:
        cur.execute("UPDATE usuarios_sistema SET activo = ? WHERE id = ?", (1 if data["activo"] else 0, user_id))
    if data.get("new_password"):
        cur.execute("UPDATE usuarios_sistema SET password_hash = ? WHERE id = ?", (hash_password(str(data["new_password"])), user_id))

    sub = get_user_subscription(user_id, conn)
    plan = (data.get("plan") or sub["plan"]).strip().upper()
    estado = (data.get("estado") or sub["estado"]).strip().upper()
    fecha_vencimiento = (data.get("fecha_vencimiento") or sub["fecha_vencimiento"]).strip()[:10]
    max_empresas = int(data.get("max_empresas") or sub["max_empresas"])
    max_relojes = int(data.get("max_relojes") or sub["max_relojes"])
    notas = data.get("notas") if "notas" in data else sub["notas"]
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    existing_sub = cur.execute("SELECT id FROM suscripciones WHERE user_id = ?", (user_id,)).fetchone()
    if existing_sub:
        cur.execute("""
            UPDATE suscripciones
            SET plan = ?, estado = ?, fecha_vencimiento = ?, max_empresas = ?, max_relojes = ?, notas = ?, updated_at = ?
            WHERE user_id = ?
        """, (plan, estado, fecha_vencimiento, max_empresas, max_relojes, notas, now_str, user_id))
    else:
        today_str = datetime.date.today().strftime("%Y-%m-%d")
        cur.execute("""
            INSERT INTO suscripciones (user_id, plan, estado, fecha_inicio, fecha_vencimiento, max_empresas, max_relojes, notas)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (user_id, plan, estado, today_str, fecha_vencimiento, max_empresas, max_relojes, notas))

    conn.commit()
    conn.close()
    return {"ok": True}


# ==========================================
# MOTOR AUXILIAR DE HORARIOS Y PRE-NÓMINA (SCOPED POR EMPRESA / SUCURSAL)
# ==========================================

def parse_horario(horario_str: Optional[str]) -> Tuple[Optional[datetime.time], Optional[datetime.time]]:
    if not horario_str or "-" not in horario_str:
        return (None, None)
    parts = horario_str.split("-")
    t_entrada = None
    t_salida = None
    try:
        e_parts = parts[0].strip().split(":")
        t_entrada = datetime.time(int(e_parts[0]), int(e_parts[1]))
    except Exception:
        pass
    try:
        s_parts = parts[1].strip().split(":")
        t_salida = datetime.time(int(s_parts[0]), int(s_parts[1]))
    except Exception:
        pass
    return (t_entrada, t_salida)


def get_areas_config_map(empresa_id: Optional[int] = None, sucursal_id: Optional[int] = None) -> Dict[str, Dict[str, Any]]:
    conn = get_conn()
    conds = []
    params = []
    if empresa_id:
        conds.append("empresa_id = ?")
        params.append(empresa_id)
    if sucursal_id:
        conds.append("sucursal_id = ?")
        params.append(sucursal_id)
    where_sql = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = conn.execute(f"SELECT nombre, horario, tolerancia_min FROM areas {where_sql}", tuple(params)).fetchall()
    conn.close()
    res = {}
    for r in rows:
        t_ent, t_sal = parse_horario(r["horario"])
        res[r["nombre"]] = {
            "hora_entrada": t_ent,
            "hora_salida": t_sal,
            "tolerancia_min": r["tolerancia_min"] if r["tolerancia_min"] is not None else 10
        }
    return res


def evaluate_checkin_status(
    fecha_hora_str: str,
    is_first_of_day: bool,
    area_name: str,
    areas_map: Dict[str, Dict[str, Any]],
    default_tolerance: int = 10,
    es_rebote: bool = False,
    es_manual: bool = False
) -> str:
    if es_rebote:
        return "REBOTE IGNORADO (<180s)"
    if not is_first_of_day:
        return "SALIDA / REGISTRO"

    area_cfg = areas_map.get(area_name, {})
    hora_entrada = area_cfg.get("hora_entrada")
    tolerancia = area_cfg.get("tolerancia_min", default_tolerance)

    if not hora_entrada:
        return "JUSTIFICADO (MANUAL)" if es_manual else "PUNTUAL"

    try:
        clean_dt_str = fecha_hora_str.replace("Z", "").replace("T", " ")[:19]
        dt_event = datetime.datetime.fromisoformat(clean_dt_str)
        dt_entry = datetime.datetime.combine(dt_event.date(), hora_entrada)
        dt_limit = dt_entry + datetime.timedelta(minutes=tolerancia)

        if dt_event <= dt_limit:
            return "PUNTUAL"
        else:
            if es_manual:
                return "JUSTIFICADO (MANUAL)"
            diff_seconds = (dt_event - dt_entry).total_seconds()
            diff_min = max(1, int(round(diff_seconds / 60)))
            return f"RETARDO (+{diff_min} min)"
    except Exception:
        return "JUSTIFICADO (MANUAL)" if es_manual else "PUNTUAL"


def get_employee_area(emp_no: str, empresa_id: int = 1, sucursal_id: Optional[int] = None) -> str:
    conn = get_conn()
    if sucursal_id:
        row = conn.execute(
            "SELECT area_nombre FROM empleados WHERE codigo_empleado = ? AND empresa_id = ? AND sucursal_id = ?",
            (str(emp_no), empresa_id, sucursal_id)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT area_nombre FROM empleados WHERE codigo_empleado = ? AND empresa_id = ?",
            (str(emp_no), empresa_id)
        ).fetchone()
    conn.close()
    return row["area_nombre"] if row else "General"


def get_employee_name(emp_no: str, fallback: str = "Desconocido", empresa_id: int = 1, sucursal_id: Optional[int] = None) -> str:
    conn = get_conn()
    if sucursal_id:
        row = conn.execute(
            "SELECT nombre FROM empleados WHERE codigo_empleado = ? AND empresa_id = ? AND sucursal_id = ?",
            (str(emp_no), empresa_id, sucursal_id)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT nombre FROM empleados WHERE codigo_empleado = ? AND empresa_id = ?",
            (str(emp_no), empresa_id)
        ).fetchone()
    conn.close()
    if row and row["nombre"]:
        return row["nombre"]
    return fallback


def get_setting(key: str, default: Any = None) -> Any:
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row is not None:
        return row["value"]
    return default


def get_all_settings() -> Dict[str, Any]:
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    res = {r["key"]: r["value"] for r in rows}
    res.setdefault("debounce_seconds", "180")
    res.setdefault("tolerancia_minutos", "10")
    return res


def set_setting(key: str, value: Any):
    conn = get_conn()
    if conn.is_pg:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (str(key), str(value))
        )
    else:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (str(key), str(value)))
    conn.commit()
    conn.close()


def update_settings(data: Dict[str, Any]):
    for k, v in data.items():
        set_setting(str(k), str(v))


# ==========================================
# INGESTA ONE-WAY PUSH (RELOJ ➔ SERVIDOR) Y AUTO-DESCUBRIMIENTO
# ==========================================

def get_clock_by_webhook_token(webhook_token: Optional[str] = None, serial_or_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Identifica el reloj checador (y su empresa_id + sucursal_id) a partir del webhook_token
    en la URL Push (/api/v1/webhooks/hikvision/{webhook_token}) o por número de serie/nombre.
    """
    conn = get_conn()
    row = None
    if webhook_token:
        row = conn.execute("SELECT * FROM relojes WHERE webhook_token = ?", (webhook_token.strip(),)).fetchone()
    if not row and serial_or_name:
        row = conn.execute(
            "SELECT * FROM relojes WHERE serie = ? OR LOWER(nombre) = LOWER(?)",
            (serial_or_name.strip(), serial_or_name.strip())
        ).fetchone()
    if not row:
        row = conn.execute("SELECT * FROM relojes ORDER BY id ASC LIMIT 1").fetchone()
    conn.close()
    return dict(row) if row else None


def touch_clock_heartbeat(clock_id: int, increment_events: int = 0):
    """Actualiza el estado del reloj a ONLINE cuando recibe un evento Push o Heartbeat desde el reloj físico."""
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = get_conn()
    if increment_events > 0:
        conn.execute("""
            UPDATE relojes
            SET estado = 'ONLINE', ultima_sincronizacion = ?, total_eventos = COALESCE(total_eventos, 0) + ?
            WHERE id = ?
        """, (now_str, increment_events, clock_id))
    else:
        conn.execute("""
            UPDATE relojes
            SET estado = 'ONLINE', ultima_sincronizacion = ?
            WHERE id = ?
        """, (now_str, clock_id))
    conn.commit()
    conn.close()


def record_checkin(
    serial_no: Optional[int],
    emp_no: str,
    nombre: str,
    tipo_evento: str,
    sub_event_type: int,
    fecha_hora: str,
    reloj_nombre: str = "Cerro Gordo",
    debounce_seconds: Optional[int] = None,
    empresa_id: int = 1,
    sucursal_id: int = 1,
    reloj_id: int = 1
) -> Dict[str, Any]:
    """
    Registra una checada recibida vía Push One-Way desde el reloj físico.
    - Si el empleado fue dado de alta localmente en el reloj y aún no existe en la sucursal de la nube,
      lo auto-registra automáticamente en `empleados` actualizando su método biométrico.
    - Aplica el filtro anti-rebote (debounce) configurado en la sucursal.
    """
    conn = get_conn()
    cur = conn.cursor()

    if debounce_seconds is None:
        suc_row = cur.execute("SELECT debounce_seconds FROM sucursales WHERE id = ?", (sucursal_id,)).fetchone()
        if suc_row and suc_row["debounce_seconds"]:
            debounce_seconds = int(suc_row["debounce_seconds"])
        else:
            try:
                debounce_seconds = int(get_setting("debounce_seconds", 180))
            except (ValueError, TypeError):
                debounce_seconds = 180

    # Verificar si ya existe exactamente el mismo evento en esa sucursal
    existing = cur.execute("""
        SELECT id, es_rebote FROM checadas
        WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ? AND fecha_hora_evento = ?
        LIMIT 1
    """, (empresa_id, sucursal_id, str(emp_no), fecha_hora)).fetchone()

    if existing:
        conn.close()
        return {"inserted": False, "id": existing["id"], "es_rebote": bool(existing["es_rebote"])}

    # Auto-descubrimiento: Verificar si el empleado ya existe en el catálogo de esta sucursal
    emp_row = cur.execute("""
        SELECT id, nombre, area_nombre, tiene_huella, tiene_rostro, tiene_tarjeta
        FROM empleados
        WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ?
    """, (empresa_id, sucursal_id, str(emp_no))).fetchone()

    is_face = 1 if sub_event_type in (75, 104) else 0
    is_fp = 1 if sub_event_type == 38 else 0
    is_card = 1 if sub_event_type == 1 else 0

    if not emp_row:
        default_area_row = cur.execute(
            "SELECT nombre FROM areas WHERE empresa_id = ? AND sucursal_id = ? ORDER BY id ASC LIMIT 1",
            (empresa_id, sucursal_id)
        ).fetchone()
        default_area = default_area_row["nombre"] if default_area_row else "General"
        clean_name = (nombre or "").strip() or f"Colaborador #{emp_no}"
        cur.execute("""
            INSERT INTO empleados (
                empresa_id, sucursal_id, codigo_empleado, nombre, area_nombre, puesto, turno,
                pin, tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
            ) VALUES (?, ?, ?, ?, ?, 'Colaborador (Auto-Sincronizado Push)', 'Matutino (08:00 - 17:00)', '', ?, ?, ?, 0, ?, 'ACTIVO')
        """, (empresa_id, sucursal_id, str(emp_no), clean_name, default_area, is_fp, is_face, is_card, reloj_nombre))
        real_name = clean_name
        area_name = default_area
        # Actualizar conteo de usuarios en el reloj
        cur.execute(
            "UPDATE relojes SET total_usuarios = (SELECT COUNT(*) FROM empleados WHERE sucursal_id = ?) WHERE id = ?",
            (sucursal_id, reloj_id)
        )
    else:
        real_name = emp_row["nombre"] or nombre
        area_name = emp_row["area_nombre"] or "General"
        # Si checó con rostro/huella/tarjeta y no estaba marcado en la nube, actualizar indicador biométrico
        new_fp = 1 if (emp_row["tiene_huella"] or is_fp) else 0
        new_face = 1 if (emp_row["tiene_rostro"] or is_face) else 0
        new_card = 1 if (emp_row["tiene_tarjeta"] or is_card) else 0
        if (new_fp != emp_row["tiene_huella"]) or (new_face != emp_row["tiene_rostro"]) or (new_card != emp_row["tiene_tarjeta"]):
            cur.execute("""
                UPDATE empleados SET tiene_huella = ?, tiene_rostro = ?, tiene_tarjeta = ?
                WHERE id = ?
            """, (new_fp, new_face, new_card, emp_row["id"]))

    metodo_short, _ = SUB_EVENT_LABELS.get(sub_event_type, ("BIOMETRÍA", f"Evento #{sub_event_type}"))

    # Calcular anti-rebote comparando contra la última checada válida del empleado en esa sucursal
    es_rebote = 0
    diff_sec = None
    try:
        dt_curr = datetime.datetime.fromisoformat(fecha_hora.replace("Z", "+00:00"))
        prev_rows = cur.execute("""
            SELECT fecha_hora_evento FROM checadas
            WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ? AND es_rebote = 0
            ORDER BY fecha_hora_evento DESC LIMIT 5
        """, (empresa_id, sucursal_id, str(emp_no))).fetchall()
        for pr in prev_rows:
            dt_prev = datetime.datetime.fromisoformat(pr["fecha_hora_evento"].replace("Z", "+00:00"))
            d = abs((dt_curr - dt_prev).total_seconds())
            if 0 < d < debounce_seconds:
                es_rebote = 1
                diff_sec = int(d)
                break
    except Exception:
        pass

    cur.execute("""
        INSERT INTO checadas (
            empresa_id, sucursal_id, reloj_id, serial_no, codigo_empleado, nombre, tipo_evento,
            sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento, es_rebote,
            es_manual, nota_incidencia
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '')
    """, (
        empresa_id, sucursal_id, reloj_id, serial_no, str(emp_no), real_name, tipo_evento,
        sub_event_type, metodo_short, area_name, reloj_nombre, fecha_hora, es_rebote
    ))
    new_id = cur.lastrowid

    # Actualizar estado del reloj a ONLINE y total de eventos recibidos
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cur.execute("""
        UPDATE relojes
        SET estado = 'ONLINE', ultima_sincronizacion = ?, total_eventos = COALESCE(total_eventos, 0) + 1
        WHERE id = ?
    """, (now_str, reloj_id))

    conn.commit()
    conn.close()

    return {
        "inserted": True,
        "id": new_id,
        "empresa_id": empresa_id,
        "sucursal_id": sucursal_id,
        "reloj_id": reloj_id,
        "serial_no": serial_no,
        "codigo_empleado": str(emp_no),
        "nombre": real_name,
        "area": area_name,
        "metodo": metodo_short,
        "sub_event_type": sub_event_type,
        "fecha_hora_evento": fecha_hora,
        "es_rebote": bool(es_rebote),
        "diff_sec": diff_sec,
        "es_manual": False,
        "nota_incidencia": ""
    }


def record_manual_checkin(
    emp_no: str,
    fecha_hora: str,
    nota_incidencia: str = "",
    tipo_evento: str = "AccessControllerEvent",
    reloj_nombre: str = "Registro Manual",
    empresa_id: int = 1,
    sucursal_id: int = 1
) -> Dict[str, Any]:
    conn = get_conn()
    cur = conn.cursor()

    real_name = get_employee_name(emp_no, empresa_id=empresa_id, sucursal_id=sucursal_id)
    area_name = get_employee_area(emp_no, empresa_id=empresa_id, sucursal_id=sucursal_id)
    clean_dt = fecha_hora.replace("T", " ")[:19]
    dia = clean_dt[:10]

    earlier = cur.execute("""
        SELECT id FROM checadas
        WHERE empresa_id = ? AND sucursal_id = ? AND codigo_empleado = ?
          AND substr(fecha_hora_evento, 1, 10) = ?
          AND es_rebote = 0 AND fecha_hora_evento < ?
        LIMIT 1
    """, (empresa_id, sucursal_id, str(emp_no), dia, clean_dt)).fetchone()

    is_first_of_day = (earlier is None)

    cur.execute("""
        INSERT INTO checadas (
            empresa_id, sucursal_id, reloj_id, serial_no, codigo_empleado, nombre, tipo_evento,
            sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento, es_rebote,
            es_manual, nota_incidencia
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 0, 'MANUAL', ?, ?, ?, 0, 1, ?)
    """, (empresa_id, sucursal_id, str(emp_no), real_name, tipo_evento, area_name, reloj_nombre, clean_dt, nota_incidencia))

    new_id = cur.lastrowid
    conn.commit()
    conn.close()

    status_label = evaluate_checkin_status(
        fecha_hora_str=clean_dt,
        is_first_of_day=is_first_of_day,
        area_name=area_name,
        areas_map=get_areas_config_map(empresa_id, sucursal_id),
        default_tolerance=int(get_setting("tolerancia_minutos", 10)),
        es_rebote=False,
        es_manual=True
    )

    return {
        "id": new_id,
        "serial_no": None,
        "codigo_empleado": str(emp_no),
        "nombre": real_name,
        "area": area_name,
        "metodo": "MANUAL",
        "sub_event_type": 0,
        "fecha_hora_evento": clean_dt,
        "fecha_hora_display": clean_dt,
        "es_rebote": False,
        "es_manual": True,
        "nota_incidencia": nota_incidencia,
        "estatus_prenomina": status_label
    }


def list_checadas(limit: int = 100, empresa_id: int = 1, sucursal_id: Optional[int] = None) -> List[Dict[str, Any]]:
    conn = get_conn()
    conds = ["empresa_id = ?"]
    params: List[Any] = [empresa_id]
    if sucursal_id:
        conds.append("sucursal_id = ?")
        params.append(sucursal_id)
    where_sql = " AND ".join(conds)

    rows = conn.execute(f"""
        SELECT id, empresa_id, sucursal_id, reloj_id, serial_no, codigo_empleado, nombre, tipo_evento,
               sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento,
               es_rebote, es_manual, nota_incidencia, created_at
        FROM checadas
        WHERE {where_sql}
        ORDER BY fecha_hora_evento DESC, id DESC
        LIMIT ?
    """, tuple(params + [limit])).fetchall()

    first_checks_rows = conn.execute(f"""
        SELECT codigo_empleado, substr(fecha_hora_evento, 1, 10) as dia, MIN(fecha_hora_evento) as min_dt
        FROM checadas
        WHERE {where_sql} AND es_rebote = 0
        GROUP BY codigo_empleado, substr(fecha_hora_evento, 1, 10)
    """, tuple(params)).fetchall()
    first_checks_map = {(r["codigo_empleado"], r["dia"]): r["min_dt"] for r in first_checks_rows}
    areas_map = get_areas_config_map(empresa_id, sucursal_id)
    default_tol = int(get_setting("tolerancia_minutos", 10))
    conn.close()

    result = []
    for r in rows:
        sub_code = r["sub_event_type"]
        metodo_short, metodo_desc = SUB_EVENT_LABELS.get(sub_code, (r["metodo"] or "BIOMETRÍA", f"Evento #{sub_code}"))
        raw_dt = r["fecha_hora_evento"] or ""
        display_dt = raw_dt.replace("T", " ")[:19]
        dia = raw_dt[:10]
        emp_code = str(r["codigo_empleado"])
        is_first = (first_checks_map.get((emp_code, dia)) == raw_dt)
        area_res = r["area"] or get_employee_area(emp_code, empresa_id, sucursal_id)

        status_label = evaluate_checkin_status(
            fecha_hora_str=raw_dt,
            is_first_of_day=is_first,
            area_name=area_res,
            areas_map=areas_map,
            default_tolerance=default_tol,
            es_rebote=bool(r["es_rebote"]),
            es_manual=bool(r["es_manual"])
        )

        result.append({
            "id": r["id"],
            "empresa_id": r["empresa_id"],
            "sucursal_id": r["sucursal_id"],
            "serial_no": r["serial_no"],
            "codigo_empleado": emp_code,
            "nombre": r["nombre"],
            "area": area_res,
            "reloj_nombre": r["reloj_nombre"] or "Cerro Gordo",
            "tipo_evento": r["tipo_evento"],
            "sub_event_type": sub_code,
            "metodo": r["metodo"] if r["metodo"] == "MANUAL" else metodo_short,
            "metodo_desc": "Incidencia Manual / Justificación" if r["metodo"] == "MANUAL" else metodo_desc,
            "fecha_hora_evento": raw_dt,
            "fecha_hora_display": display_dt,
            "es_rebote": bool(r["es_rebote"]),
            "es_manual": bool(r["es_manual"]),
            "nota_incidencia": r["nota_incidencia"] or "",
            "estatus_prenomina": status_label,
            "created_at": r["created_at"]
        })
    return result


def get_dashboard_summary(empresa_id: int = 1, sucursal_id: Optional[int] = None) -> Dict[str, Any]:
    conn = get_conn()
    conds = ["empresa_id = ?"]
    params: List[Any] = [empresa_id]
    if sucursal_id:
        conds.append("sucursal_id = ?")
        params.append(sucursal_id)
    where_sql = " AND ".join(conds)
    p_tuple = tuple(params)

    total_checadas = conn.execute(f"SELECT COUNT(*) as c FROM checadas WHERE {where_sql}", p_tuple).fetchone()["c"]
    validas = conn.execute(f"SELECT COUNT(*) as c FROM checadas WHERE {where_sql} AND es_rebote = 0", p_tuple).fetchone()["c"]
    rebotes = conn.execute(f"SELECT COUNT(*) as c FROM checadas WHERE {where_sql} AND es_rebote = 1", p_tuple).fetchone()["c"]
    manuales = conn.execute(f"SELECT COUNT(*) as c FROM checadas WHERE {where_sql} AND es_manual = 1", p_tuple).fetchone()["c"]
    total_empleados = conn.execute(f"SELECT COUNT(*) as c FROM empleados WHERE {where_sql}", p_tuple).fetchone()["c"]
    con_huella = conn.execute(f"SELECT COUNT(*) as c FROM empleados WHERE {where_sql} AND tiene_huella = 1", p_tuple).fetchone()["c"]
    con_rostro = conn.execute(f"SELECT COUNT(*) as c FROM empleados WHERE {where_sql} AND tiene_rostro = 1", p_tuple).fetchone()["c"]
    total_relojes = conn.execute(f"SELECT COUNT(*) as c FROM relojes WHERE {where_sql}", p_tuple).fetchone()["c"]
    relojes_online = conn.execute(f"SELECT COUNT(*) as c FROM relojes WHERE {where_sql} AND estado = 'ONLINE'", p_tuple).fetchone()["c"]
    total_areas = conn.execute(f"SELECT COUNT(*) as c FROM areas WHERE {where_sql}", p_tuple).fetchone()["c"]
    conn.close()

    return {
        "total_checadas": total_checadas,
        "checadas_hoy": total_checadas,
        "checadas_validas": validas,
        "validas_hoy": validas,
        "rebotes_ignorados": rebotes,
        "rebotes_hoy": rebotes,
        "manuales": manuales,
        "total_empleados": total_empleados,
        "empleados_con_huella": con_huella,
        "empleados_con_rostro": con_rostro,
        "total_relojes": total_relojes,
        "relojes_online": relojes_online,
        "total_areas": total_areas
    }


def get_email_config(mask_password: bool = True) -> Dict[str, Any]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM config_correo WHERE id = 1").fetchone()
    conn.close()
    if not row:
        return {
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 587,
            "smtp_user": "",
            "smtp_password": "",
            "smtp_password_masked": "",
            "has_password": False,
            "smtp_security": "STARTTLS",
            "remitente_nombre": "ACCESS - Control Biométrico",
            "remitente_email": "",
            "destinatario_default": "",
            "is_configured": False
        }
    pwd = row["smtp_password"] or ""
    has_pwd = bool(pwd)
    return {
        "smtp_host": row["smtp_host"] or "smtp.gmail.com",
        "smtp_port": row["smtp_port"] or 587,
        "smtp_user": row["smtp_user"] or "",
        "smtp_password": "••••••••" if (mask_password and has_pwd) else pwd,
        "smtp_password_masked": "••••••••" if has_pwd else "",
        "has_password": has_pwd,
        "smtp_security": row["smtp_security"] or "STARTTLS",
        "remitente_nombre": row["remitente_nombre"] or "ACCESS - Control Biométrico",
        "remitente_email": row["remitente_email"] or (row["smtp_user"] or ""),
        "destinatario_default": row["destinatario_default"] or "",
        "is_configured": bool(row["smtp_host"] and row["smtp_user"] and has_pwd)
    }


def update_email_config(data: Dict[str, Any]) -> Dict[str, Any]:
    conn = get_conn()
    cur = conn.cursor()
    current = cur.execute("SELECT * FROM config_correo WHERE id = 1").fetchone()

    new_pwd = data.get("smtp_password", "")
    if (not new_pwd or new_pwd == "••••••••") and current and current["smtp_password"]:
        new_pwd = current["smtp_password"]

    smtp_host = (data.get("smtp_host") or "smtp.gmail.com").strip()
    smtp_port = int(data.get("smtp_port") or 587)
    smtp_user = (data.get("smtp_user") or "").strip()
    smtp_security = (data.get("smtp_security") or "STARTTLS").strip()
    remitente_nombre = (data.get("remitente_nombre") or "ACCESS - Control Biométrico").strip()
    remitente_email = (data.get("remitente_email") or "").strip() or smtp_user
    destinatario_default = (data.get("destinatario_default") or "").strip()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cur.execute("""
        UPDATE config_correo SET
            smtp_host = ?,
            smtp_port = ?,
            smtp_user = ?,
            smtp_password = ?,
            smtp_security = ?,
            remitente_nombre = ?,
            remitente_email = ?,
            destinatario_default = ?,
            updated_at = ?
        WHERE id = 1
    """, (smtp_host, smtp_port, smtp_user, new_pwd, smtp_security, remitente_nombre, remitente_email, destinatario_default, now_str))
    conn.commit()
    conn.close()
    return get_email_config(mask_password=True)


def get_report_dataset(
    report_type: str = "bitacora",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    employee_id: Optional[str] = None,
    area: Optional[str] = None,
    reloj: Optional[str] = None,
    status_filter: Optional[str] = None,
    empresa_id: int = 1,
    sucursal_id: Optional[int] = None
) -> Dict[str, Any]:
    conn = get_conn()

    conditions = ["empresa_id = ?"]
    params: List[Any] = [empresa_id]
    if sucursal_id:
        conditions.append("sucursal_id = ?")
        params.append(sucursal_id)

    if start_date:
        conditions.append("substr(fecha_hora_evento, 1, 10) >= ?")
        params.append(start_date)
    if end_date:
        conditions.append("substr(fecha_hora_evento, 1, 10) <= ?")
        params.append(end_date)
    if employee_id and employee_id != "TODOS":
        conditions.append("codigo_empleado = ?")
        params.append(str(employee_id))
    if area and area != "TODAS":
        conditions.append("area = ?")
        params.append(area)
    if reloj and reloj != "TODOS":
        conditions.append("reloj_nombre = ?")
        params.append(reloj)
    if status_filter == "validas":
        conditions.append("es_rebote = 0")
    elif status_filter == "rebotes":
        conditions.append("es_rebote = 1")

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    # 1. BITÁCORA DETALLADA
    if report_type == "bitacora":
        sql = f"""
            SELECT id, serial_no, codigo_empleado, nombre, tipo_evento,
                   sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento,
                   es_rebote, es_manual, nota_incidencia, created_at
            FROM checadas
            {where_clause}
            ORDER BY fecha_hora_evento DESC, id DESC
            LIMIT 500
        """
        rows = conn.execute(sql, tuple(params)).fetchall()

        first_checks_rows = conn.execute("""
            SELECT codigo_empleado, substr(fecha_hora_evento, 1, 10) as dia, MIN(fecha_hora_evento) as min_dt
            FROM checadas
            WHERE empresa_id = ? AND es_rebote = 0
            GROUP BY codigo_empleado, substr(fecha_hora_evento, 1, 10)
        """, (empresa_id,)).fetchall()
        first_checks_map = {(r["codigo_empleado"], r["dia"]): r["min_dt"] for r in first_checks_rows}
        areas_map = get_areas_config_map(empresa_id, sucursal_id)
        default_tol = int(get_setting("tolerancia_minutos", 10))

        records = []
        total_validas = 0
        total_rebotes = 0
        metodos_count = {}
        unique_emps = set()

        for r in rows:
            sub_code = r["sub_event_type"]
            metodo_short, metodo_desc = SUB_EVENT_LABELS.get(sub_code, (r["metodo"] or "BIOMETRÍA", f"Evento #{sub_code}"))
            raw_dt = r["fecha_hora_evento"] or ""
            display_dt = raw_dt.replace("T", " ")[:19]
            dia = raw_dt[:10]
            emp_code = str(r["codigo_empleado"])
            is_rebote = bool(r["es_rebote"])
            is_manual = bool(r["es_manual"])
            is_first = (first_checks_map.get((emp_code, dia)) == raw_dt)
            area_res = r["area"] or get_employee_area(emp_code, empresa_id, sucursal_id)

            if is_rebote:
                total_rebotes += 1
            else:
                total_validas += 1

            unique_emps.add(emp_code)
            actual_metodo = "MANUAL" if is_manual else metodo_short
            metodos_count[actual_metodo] = metodos_count.get(actual_metodo, 0) + 1

            status_label = evaluate_checkin_status(
                fecha_hora_str=raw_dt,
                is_first_of_day=is_first,
                area_name=area_res,
                areas_map=areas_map,
                default_tolerance=default_tol,
                es_rebote=is_rebote,
                es_manual=is_manual
            )

            records.append({
                "id": r["id"],
                "serial_no": r["serial_no"],
                "codigo_empleado": emp_code,
                "nombre": r["nombre"],
                "area": area_res,
                "reloj_nombre": r["reloj_nombre"] or "Cerro Gordo",
                "tipo_evento": r["tipo_evento"],
                "sub_event_type": sub_code,
                "metodo": actual_metodo,
                "metodo_desc": "Incidencia Manual / Justificación" if is_manual else metodo_desc,
                "fecha_hora_evento": raw_dt,
                "fecha_hora_display": display_dt,
                "es_rebote": is_rebote,
                "es_manual": is_manual,
                "nota_incidencia": r["nota_incidencia"] or "",
                "estatus_prenomina": status_label,
                "created_at": r["created_at"]
            })

        most_used_method = max(metodos_count.items(), key=lambda x: x[1])[0] if metodos_count else "N/A"
        conn.close()

        return {
            "type": "bitacora",
            "title": "Bitácora Detallada de Checadas",
            "summary": {
                "total_registros": len(records),
                "validas": total_validas,
                "rebotes": total_rebotes,
                "colaboradores_activos": len(unique_emps),
                "metodo_principal": most_used_method
            },
            "headers": ["ID", "Empleado", "Nombre", "Área", "Reloj", "Método", "Fecha y Hora", "Estatus"],
            "data": records
        }

    # 2. PRE-NÓMINA Y RESUMEN POR EMPLEADO
    elif report_type == "empleados":
        emp_conds = ["empresa_id = ?"]
        emp_params: List[Any] = [empresa_id]
        if sucursal_id:
            emp_conds.append("sucursal_id = ?")
            emp_params.append(sucursal_id)
        if employee_id and employee_id != "TODOS":
            emp_conds.append("codigo_empleado = ?")
            emp_params.append(str(employee_id))
        if area and area != "TODAS":
            emp_conds.append("area_nombre = ?")
            emp_params.append(area)
        emp_query = f"SELECT * FROM empleados WHERE {' AND '.join(emp_conds)} ORDER BY id ASC"
        employees_list = conn.execute(emp_query, tuple(emp_params)).fetchall()

        areas_map = get_areas_config_map(empresa_id, sucursal_id)
        default_tol = int(get_setting("tolerancia_minutos", 10))

        emp_summary_rows = []
        total_validas_global = 0
        total_rebotes_global = 0
        total_retardos_global = 0
        total_incompletos_global = 0
        total_horas_global = 0.0

        for emp in employees_list:
            emp_code = str(emp["codigo_empleado"])
            c_conditions = ["empresa_id = ?", "codigo_empleado = ?"]
            c_params: List[Any] = [empresa_id, emp_code]
            if sucursal_id:
                c_conditions.append("sucursal_id = ?")
                c_params.append(sucursal_id)
            if start_date:
                c_conditions.append("substr(fecha_hora_evento, 1, 10) >= ?")
                c_params.append(start_date)
            if end_date:
                c_conditions.append("substr(fecha_hora_evento, 1, 10) <= ?")
                c_params.append(end_date)
            if reloj and reloj != "TODOS":
                c_conditions.append("reloj_nombre = ?")
                c_params.append(reloj)
            if status_filter == "validas":
                c_conditions.append("es_rebote = 0")
            elif status_filter == "rebotes":
                c_conditions.append("es_rebote = 1")

            c_sql = f"""
                SELECT id, fecha_hora_evento, es_rebote, metodo, reloj_nombre, es_manual, nota_incidencia
                FROM checadas
                WHERE {' AND '.join(c_conditions)}
                ORDER BY fecha_hora_evento ASC
            """
            emp_records = conn.execute(c_sql, tuple(c_params)).fetchall()

            validas = [r for r in emp_records if not r["es_rebote"]]
            rebotes = [r for r in emp_records if r["es_rebote"]]
            total_validas_global += len(validas)
            total_rebotes_global += len(rebotes)

            days_dict: Dict[str, List[Any]] = {}
            for r in validas:
                day_key = (r["fecha_hora_evento"] or "")[:10]
                if day_key:
                    days_dict.setdefault(day_key, []).append(r)

            dias_asistidos = len(days_dict)
            retardos_emp = 0
            dias_incompletos_emp = 0
            horas_trabajadas_emp = 0.0
            emp_area_name = emp["area_nombre"] or "General"

            for day_key, day_recs in days_dict.items():
                first_of_day = day_recs[0]
                status_eval = evaluate_checkin_status(
                    fecha_hora_str=first_of_day["fecha_hora_evento"],
                    is_first_of_day=True,
                    area_name=emp_area_name,
                    areas_map=areas_map,
                    default_tolerance=default_tol,
                    es_rebote=False,
                    es_manual=bool(first_of_day["es_manual"]) if "es_manual" in first_of_day.keys() else False
                )
                if status_eval.startswith("RETARDO"):
                    retardos_emp += 1

                if len(day_recs) == 1:
                    dias_incompletos_emp += 1
                else:
                    try:
                        t1_str = first_of_day["fecha_hora_evento"].replace("Z", "").replace("T", " ")[:19]
                        t2_str = day_recs[-1]["fecha_hora_evento"].replace("Z", "").replace("T", " ")[:19]
                        dt1 = datetime.datetime.fromisoformat(t1_str)
                        dt2 = datetime.datetime.fromisoformat(t2_str)
                        worked_sec = max(0, (dt2 - dt1).total_seconds())
                        horas_trabajadas_emp += (worked_sec / 3600.0)
                    except Exception:
                        pass

            total_retardos_global += retardos_emp
            total_incompletos_global += dias_incompletos_emp
            total_horas_global += horas_trabajadas_emp

            first_check = validas[0]["fecha_hora_evento"].replace("T", " ")[:19] if validas else "Sin registro"
            last_check = validas[-1]["fecha_hora_evento"].replace("T", " ")[:19] if validas else "Sin registro"

            relojes_used = [r["reloj_nombre"] for r in emp_records if r["reloj_nombre"]]
            reloj_preferido = max(set(relojes_used), key=relojes_used.count) if relojes_used else (emp["reloj_asignado"] or "Cerro Gordo")

            metodos_used = [r["metodo"] for r in emp_records if r["metodo"]]
            metodo_preferido = max(set(metodos_used), key=metodos_used.count) if metodos_used else ("ROSTRO" if emp["tiene_rostro"] else ("HUELLA" if emp["tiene_huella"] else "PIN"))

            if len(validas) == 0:
                status_str = "SIN REGISTROS"
            elif retardos_emp > 0 and dias_incompletos_emp > 0:
                status_str = f"{retardos_emp} RETARDO(S) • {dias_incompletos_emp} INC."
            elif retardos_emp > 0:
                status_str = f"{retardos_emp} RETARDO(S)"
            elif dias_incompletos_emp > 0:
                status_str = f"{dias_incompletos_emp} DÍA(S) INCOMPLETO(S)"
            else:
                status_str = "ASISTENCIA PUNTUAL"

            emp_summary_rows.append({
                "codigo_empleado": emp["codigo_empleado"],
                "nombre": emp["nombre"],
                "area_nombre": emp["area_nombre"],
                "puesto": emp["puesto"],
                "turno": emp["turno"],
                "dias_asistidos": dias_asistidos,
                "dias_activos": dias_asistidos,
                "retardos": retardos_emp,
                "dias_incompletos": dias_incompletos_emp,
                "horas_trabajadas": round(horas_trabajadas_emp, 1),
                "total_validas": len(validas),
                "total_rebotes": len(rebotes),
                "primera_checada": first_check,
                "ultima_checada": last_check,
                "reloj_preferido": reloj_preferido,
                "metodo_preferido": metodo_preferido,
                "estatus": status_str
            })

        conn.close()
        return {
            "type": "empleados",
            "title": "Pre-Nómina y Asistencia por Colaborador",
            "summary": {
                "total_colaboradores": len(employees_list),
                "colaboradores_con_asistencia": sum(1 for e in emp_summary_rows if e["total_validas"] > 0),
                "total_validas": total_validas_global,
                "total_rebotes": total_rebotes_global,
                "total_dias_asistidos": sum(e["dias_asistidos"] for e in emp_summary_rows),
                "total_retardos": total_retardos_global,
                "total_incompletos": total_incompletos_global,
                "total_horas_trabajadas": round(total_horas_global, 1),
                "promedio_horas": round(total_horas_global / max(sum(1 for e in emp_summary_rows if e["total_validas"] > 0), 1), 1)
            },
            "headers": ["Código", "Colaborador", "Área / Turno", "Días Asist.", "Retardos", "Incompletos", "Horas Trab.", "Válidas", "Rebotes", "Estatus Pre-Nómina"],
            "data": emp_summary_rows
        }

    # 3. AUDITORÍA POR RELOJ CHECADOR
    elif report_type == "relojes":
        r_conds = ["empresa_id = ?"]
        r_params: List[Any] = [empresa_id]
        if sucursal_id:
            r_conds.append("sucursal_id = ?")
            r_params.append(sucursal_id)
        relojes_list = conn.execute(f"SELECT * FROM relojes WHERE {' AND '.join(r_conds)} ORDER BY id ASC", tuple(r_params)).fetchall()
        clock_rows = []
        total_events_period = 0

        for clk in relojes_list:
            clk_name = clk["nombre"]
            c_conds = ["empresa_id = ?", "reloj_nombre = ?"]
            c_params = [empresa_id, clk_name]
            if start_date:
                c_conds.append("substr(fecha_hora_evento, 1, 10) >= ?")
                c_params.append(start_date)
            if end_date:
                c_conds.append("substr(fecha_hora_evento, 1, 10) <= ?")
                c_params.append(end_date)
            if employee_id and employee_id != "TODOS":
                c_conds.append("codigo_empleado = ?")
                c_params.append(str(employee_id))
            if area and area != "TODAS":
                c_conds.append("area = ?")
                c_params.append(area)

            c_sql = f"""
                SELECT id, codigo_empleado, metodo, es_rebote, fecha_hora_evento
                FROM checadas
                WHERE {' AND '.join(c_conds)}
                ORDER BY fecha_hora_evento DESC
            """
            c_rows = conn.execute(c_sql, tuple(c_params)).fetchall()
            validas = sum(1 for r in c_rows if not r["es_rebote"])
            rebotes = sum(1 for r in c_rows if r["es_rebote"])
            users_set = set(str(r["codigo_empleado"]) for r in c_rows)
            total_events_period += len(c_rows)

            last_ev = c_rows[0]["fecha_hora_evento"].replace("T", " ")[:19] if c_rows else (clk["ultima_sincronizacion"] or "Sin actividad")

            clock_rows.append({
                "id": clk["id"],
                "nombre": clk["nombre"],
                "ip": clk["ip"],
                "puerto": clk["puerto"],
                "modelo": clk["modelo"],
                "serie": clk["serie"],
                "ubicacion": clk["ubicacion"],
                "area_asignada": clk["area_asignada"],
                "estado": clk["estado"],
                "total_eventos_periodo": len(c_rows),
                "validas": validas,
                "rebotes": rebotes,
                "usuarios_distintos": len(users_set),
                "ultima_actividad": last_ev
            })

        conn.close()
        return {
            "type": "relojes",
            "title": "Auditoría de Terminales y Relojes Checadores",
            "summary": {
                "total_relojes": len(relojes_list),
                "relojes_online": sum(1 for c in relojes_list if c["estado"] == "ONLINE"),
                "eventos_periodo": total_events_period,
                "validas_periodo": sum(c["validas"] for c in clock_rows),
                "rebotes_periodo": sum(c["rebotes"] for c in clock_rows)
            },
            "headers": ["Reloj", "IP", "Modelo", "Ubicación", "Eventos", "Válidas", "Rebotes", "Usuarios", "Último Evento", "Estado"],
            "data": clock_rows
        }

    # 4. CUMPLIMIENTO POR ÁREA / DEPARTAMENTO
    else:
        a_conds = ["empresa_id = ?"]
        a_params: List[Any] = [empresa_id]
        if sucursal_id:
            a_conds.append("sucursal_id = ?")
            a_params.append(sucursal_id)
        areas_list = conn.execute(f"SELECT * FROM areas WHERE {' AND '.join(a_conds)} ORDER BY id ASC", tuple(a_params)).fetchall()
        area_rows = []
        total_emp_global = 0
        total_present_global = 0

        for a in areas_list:
            a_name = a["nombre"]
            if area and area != "TODAS" and a_name != area:
                continue

            emp_cnt = conn.execute(
                "SELECT COUNT(*) as c FROM empleados WHERE empresa_id = ? AND area_nombre = ?",
                (empresa_id, a_name)
            ).fetchone()["c"]
            total_emp_global += emp_cnt

            c_conds = ["empresa_id = ?", "area = ?"]
            c_params = [empresa_id, a_name]
            if sucursal_id:
                c_conds.append("sucursal_id = ?")
                c_params.append(sucursal_id)
            if start_date:
                c_conds.append("substr(fecha_hora_evento, 1, 10) >= ?")
                c_params.append(start_date)
            if end_date:
                c_conds.append("substr(fecha_hora_evento, 1, 10) <= ?")
                c_params.append(end_date)
            if reloj and reloj != "TODOS":
                c_conds.append("reloj_nombre = ?")
                c_params.append(reloj)

            c_sql = f"""
                SELECT id, codigo_empleado, es_rebote
                FROM checadas
                WHERE {' AND '.join(c_conds)}
            """
            c_rows = conn.execute(c_sql, tuple(c_params)).fetchall()
            validas = [r for r in c_rows if not r["es_rebote"]]
            rebotes = [r for r in c_rows if r["es_rebote"]]
            present_emps = len(set(str(r["codigo_empleado"]) for r in validas))
            total_present_global += present_emps
            pct = round((present_emps / emp_cnt) * 100, 1) if emp_cnt > 0 else (100.0 if present_emps > 0 else 0.0)

            area_rows.append({
                "id": a["id"],
                "codigo": a["codigo"],
                "nombre": a["nombre"],
                "responsable": a["responsable"],
                "turno": a["turno"],
                "horario": a["horario"],
                "tolerancia_min": a["tolerancia_min"],
                "ubicacion": a["ubicacion"],
                "plantilla": emp_cnt,
                "colaboradores_presentes": present_emps,
                "cobertura_pct": min(100.0, pct),
                "total_validas": len(validas),
                "total_rebotes": len(rebotes)
            })

        conn.close()
        global_pct = round((total_present_global / total_emp_global) * 100, 1) if total_emp_global > 0 else 0.0
        return {
            "type": "areas",
            "title": "Cumplimiento y Cobertura por Área / Turno",
            "summary": {
                "total_areas": len(area_rows),
                "plantilla_total": total_emp_global,
                "colaboradores_con_registro": total_present_global,
                "cobertura_promedio": f"{min(100.0, global_pct)}%",
                "checadas_validas": sum(r["total_validas"] for r in area_rows)
            },
            "headers": ["Código", "Área / Departamento", "Responsable", "Turno", "Horario", "Plantilla", "Con Asistencia", "Cobertura", "Checadas Válidas"],
            "data": area_rows
        }
