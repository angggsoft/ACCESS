"""
ACCESS — Capa de Persistencia Dual (SQLite Local + PostgreSQL Cloud Railway)
Soporta Multi-Empresa, Multi-Sucursal, Invitaciones con Clave Dinámica TOTP (5 min),
Aislamiento de Roles (ADMIN_SAAS vs CLIENTE_RH) y Protocolo One-Way Push Hikvision.
"""

import sqlite3
import json
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
    """Obtiene el estado de suscripción del usuario, su uso real y evalúa si está vigente."""
    close_after = False
    if conn is None:
        conn = get_conn()
        close_after = True

    row = conn.execute("""
        SELECT id, user_id, plan, estado, fecha_inicio, fecha_vencimiento, max_empresas, max_relojes, notas
        FROM suscripciones
        WHERE user_id = ?
    """, (user_id,)).fetchone()

    empresas_usadas = conn.execute(
        "SELECT COUNT(*) as c FROM empresa_usuarios WHERE user_id = ?", (user_id,)
    ).fetchone()["c"]
    relojes_usados = conn.execute("""
        SELECT COUNT(*) as c FROM relojes
        WHERE empresa_id IN (SELECT empresa_id FROM empresa_usuarios WHERE user_id = ?)
    """, (user_id,)).fetchone()["c"]

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
            "empresas_usadas": empresas_usadas,
            "max_relojes": 1,
            "relojes_usados": relojes_usados,
            "relojes_disponibles": 0,
            "can_add_clock": False,
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
    max_emp = int(row["max_empresas"]) if row["max_empresas"] is not None else 5
    max_rel = int(row["max_relojes"]) if row["max_relojes"] is not None else 1
    relojes_disponibles = max(0, max_rel - relojes_usados)
    return {
        "id": row["id"],
        "plan": row["plan"] or "MENSUAL",
        "estado": estado,
        "fecha_inicio": str(row["fecha_inicio"] or "")[:10],
        "fecha_vencimiento": exp_str,
        "max_empresas": max_emp,
        "empresas_usadas": empresas_usadas,
        "max_relojes": max_rel,
        "relojes_usados": relojes_usados,
        "relojes_disponibles": relojes_disponibles,
        "can_add_clock": bool(is_active and (relojes_usados < max_rel)),
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


WEEK_DAY_LABELS = {1: "Lun", 2: "Mar", 3: "Mié", 4: "Jue", 5: "Vie", 6: "Sáb", 7: "Dom"}


def _parse_hhmm(val: Any) -> Optional[datetime.time]:
    if isinstance(val, datetime.time):
        return datetime.time(val.hour, val.minute)
    raw = str(val or "").strip()
    if not raw or ":" not in raw:
        return None
    parts = raw.split(":")
    try:
        h = int(parts[0])
        m = int(parts[1])
        return datetime.time(h, m)
    except Exception:
        return None


def _format_hours_compact(hours_val: float) -> str:
    txt = f"{round(float(hours_val), 1):.1f}"
    return txt[:-2] if txt.endswith(".0") else txt


def format_schedule_summary(bloques: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Calcula bloques por día, días laborales, horas semanales y resúmenes legibles."""
    bloques_por_dia: Dict[int, List[Dict[str, Any]]] = {}
    ref_day = datetime.date(2026, 1, 5)
    total_sec = 0.0

    for b in bloques or []:
        day_num = int(b["dia_semana"])
        t_in = _parse_hhmm(b["hora_entrada"])
        t_out = _parse_hhmm(b["hora_salida"])
        if not t_in or not t_out:
            continue
        ent_str = t_in.strftime("%H:%M")
        sal_str = t_out.strftime("%H:%M")
        total_sec += max(0.0, (datetime.datetime.combine(ref_day, t_out) - datetime.datetime.combine(ref_day, t_in)).total_seconds())
        bloques_por_dia.setdefault(day_num, []).append({
            "dia_semana": day_num,
            "orden_bloque": int(b.get("orden_bloque") or (len(bloques_por_dia.get(day_num, [])) + 1)),
            "hora_entrada": ent_str,
            "hora_salida": sal_str,
            "tolerancia_min": b.get("tolerancia_min")
        })

    for d_num in bloques_por_dia:
        bloques_por_dia[d_num].sort(key=lambda x: (x["hora_entrada"], x["orden_bloque"]))
        for idx, blk in enumerate(bloques_por_dia[d_num], start=1):
            blk["orden_bloque"] = idx

    dias_laborales = sorted(bloques_por_dia.keys())
    dias_laborales_str = ",".join(str(d) for d in dias_laborales)
    horas_semanales = round(total_sec / 3600.0, 1)

    day_sigs: Dict[int, Tuple[Tuple[str, str], ...]] = {
        d: tuple((blk["hora_entrada"], blk["hora_salida"]) for blk in bloques_por_dia[d])
        for d in dias_laborales
    }
    unique_sigs = set(day_sigs.values())
    es_mixto = any(len(bloques_por_dia[d]) > 1 for d in dias_laborales) or len(unique_sigs) > 1

    if not dias_laborales:
        resumen_corto = "Sin horario"
        resumen_detalle = "Sin bloques asignados"
    elif len(unique_sigs) == 1:
        sig = next(iter(unique_sigs))
        if len(sig) == 1:
            resumen_corto = f"{sig[0][0]} - {sig[0][1]}"
        else:
            resumen_corto = " / ".join(f"{s}-{e}" for s, e in sig)
    else:
        resumen_corto = f"Mixto ({len(dias_laborales)} días · {_format_hours_compact(horas_semanales)}h/sem)"

    if dias_laborales:
        sig_order: List[Tuple[Tuple[str, str], ...]] = []
        sig_days: Dict[Tuple[Tuple[str, str], ...], List[str]] = {}
        for d in dias_laborales:
            sig = day_sigs[d]
            if sig not in sig_days:
                sig_order.append(sig)
                sig_days[sig] = []
            sig_days[sig].append(WEEK_DAY_LABELS[d])
        detail_parts = []
        for sig in sig_order:
            days_lbl = ",".join(sig_days[sig])
            blocks_lbl = ", ".join(f"{s}-{e}" for s, e in sig)
            detail_parts.append(f"{days_lbl}: {blocks_lbl}")
        resumen_detalle = " · ".join(detail_parts)

    return {
        "bloques_por_dia": bloques_por_dia,
        "dias_laborales": dias_laborales,
        "dias_laborales_str": dias_laborales_str,
        "horas_semanales": horas_semanales,
        "es_mixto": es_mixto,
        "resumen_corto": resumen_corto,
        "resumen_detalle": resumen_detalle
    }


def _create_default_schedule_for_area(
    cur: DualCursor,
    empresa_id: int,
    sucursal_id: int,
    area_nombre: str,
    turno: Optional[str],
    horario_str: Optional[str],
    tolerancia_min: Optional[int],
    dias_laborales_str: Optional[str] = "1,2,3,4,5"
) -> int:
    """Crea un horario plantilla de 1 bloque por día laboral para un área nueva o migrada."""
    t_ent, t_sal = parse_horario(horario_str)
    if not t_ent or not t_sal or t_ent >= t_sal:
        t_ent = datetime.time(8, 0)
        t_sal = datetime.time(17, 0)
    dias_set = sorted({
        int(x.strip()) for x in str(dias_laborales_str or "1,2,3,4,5").split(",")
        if x.strip().isdigit() and 1 <= int(x.strip()) <= 7
    }) or [1, 2, 3, 4, 5]
    tol_val = max(0, int(tolerancia_min)) if tolerancia_min is not None else 10
    sched_name = f"{(turno or 'Estándar').strip()} — {area_nombre}"
    sched_desc = f"Horario base de {area_nombre}"

    cur.execute("""
        INSERT INTO horarios (empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo)
        VALUES (?, ?, ?, ?, ?, 1, 1)
    """, (int(empresa_id), int(sucursal_id), sched_name, sched_desc, tol_val))
    new_hid = cur.lastrowid

    ent_str = t_ent.strftime("%H:%M")
    sal_str = t_sal.strftime("%H:%M")
    for d_num in dias_set:
        cur.execute("""
            INSERT INTO horario_bloques (horario_id, dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min)
            VALUES (?, ?, 1, ?, ?, NULL)
        """, (new_hid, d_num, ent_str, sal_str))
    return int(new_hid)


def ensure_default_schedule_for_branch(
    cur: DualCursor,
    empresa_id: int,
    sucursal_id: int,
    default_tol: Optional[int] = None
) -> int:
    """
    Garantiza que exista al menos una plantilla de horario en (empresa_id, sucursal_id),
    priorizando el horario matutino o creando 'Horario Matutino' (08:00 - 17:00, Lun-Vie).
    """
    rows = cur.execute("""
        SELECT id, nombre
        FROM horarios
        WHERE empresa_id = ? AND sucursal_id = ?
          AND COALESCE(es_plantilla, 1) = 1 AND COALESCE(activo, 1) = 1
        ORDER BY id ASC
    """, (int(empresa_id), int(sucursal_id))).fetchall()

    if rows:
        for r in rows:
            if "matutino" in str(r["nombre"] or "").lower():
                return int(r["id"])
        return int(rows[0]["id"])

    if default_tol is None:
        suc_row = cur.execute("SELECT tolerancia_minutos FROM sucursales WHERE id = ?", (int(sucursal_id),)).fetchone()
        tol_val = int(suc_row["tolerancia_minutos"]) if suc_row and suc_row["tolerancia_minutos"] is not None else 10
    else:
        tol_val = max(0, int(default_tol))

    cur.execute("""
        INSERT INTO horarios (empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo)
        VALUES (?, ?, 'Horario Matutino', 'Horario matutino estándar por defecto', ?, 1, 1)
    """, (int(empresa_id), int(sucursal_id), tol_val))
    new_hid = int(cur.lastrowid)

    for d_num in (1, 2, 3, 4, 5):
        cur.execute("""
            INSERT INTO horario_bloques (horario_id, dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min)
            VALUES (?, ?, 1, '08:00', '17:00', NULL)
        """, (new_hid, d_num))
    return new_hid


def get_default_schedule_id_for_branch(conn: DualConnection, empresa_id: int, sucursal_id: int) -> int:
    """Devuelve el ID del horario por defecto (Matutino) de la sucursal, creándolo si no existe."""
    return ensure_default_schedule_for_branch(conn.cursor(), int(empresa_id), int(sucursal_id))


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        return row[key] if key in row.keys() else default
    except Exception:
        return default


def is_default_employee_name(nombre: Optional[str], emp_no: Any = None) -> bool:
    """Indica si el nombre corresponde a un placeholder genérico o sin nombre personalizado."""
    clean = (nombre or "").strip().lower()
    if not clean:
        return True
    if clean in ("colaborador", "desconocido", "sin nombre", "sin asignar"):
        return True
    if clean.startswith("empleado #") or clean.startswith("colaborador #"):
        return True
    if emp_no is not None and clean == str(emp_no).strip().lower():
        return True
    return False


def _deduplicate_company_employees(cur: DualCursor):
    """
    Consolida colaboradores duplicados por (empresa_id, codigo_empleado) tomando siempre
    el primer registro histórico (`ORDER BY id ASC`) como ficha original y su Sucursal Base,
    fusionando biometrías, nombre real, código CONTPAQi y horario si faltaban en el original.
    """
    dup_groups = cur.execute("""
        SELECT empresa_id, codigo_empleado
        FROM empleados
        GROUP BY empresa_id, codigo_empleado
        HAVING COUNT(*) > 1
    """).fetchall()

    for grp in dup_groups:
        emp_id = grp["empresa_id"]
        emp_code = grp["codigo_empleado"]
        rows = cur.execute("""
            SELECT id, sucursal_id, codigo_contpaqi, nombre, area_nombre, puesto, turno,
                   horario_id, tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui
            FROM empleados
            WHERE empresa_id = ? AND codigo_empleado = ?
            ORDER BY id ASC
        """, (emp_id, emp_code)).fetchall()
        if len(rows) <= 1:
            continue

        # El primer registro histórico es la ficha original y define la Sucursal Base
        keeper = rows[0]
        secondaries = rows[1:]

        merged_fp = 1 if any(_row_get(r, "tiene_huella") for r in rows) else 0
        merged_face = 1 if any(_row_get(r, "tiene_rostro") for r in rows) else 0
        merged_card = 1 if any(_row_get(r, "tiene_tarjeta") for r in rows) else 0
        merged_admin = 1 if any(_row_get(r, "admin_ui") for r in rows) else 0

        keeper_name = str(_row_get(keeper, "nombre") or "").strip()
        if is_default_employee_name(keeper_name, emp_code):
            for r in secondaries:
                cand_name = str(_row_get(r, "nombre") or "").strip()
                if cand_name and not is_default_employee_name(cand_name, emp_code):
                    keeper_name = cand_name
                    break

        merged_contpaqi = str(_row_get(keeper, "codigo_contpaqi") or "").strip()
        if not merged_contpaqi:
            for r in secondaries:
                cand = str(_row_get(r, "codigo_contpaqi") or "").strip()
                if cand:
                    merged_contpaqi = cand
                    break

        merged_horario_id = _row_get(keeper, "horario_id")
        if merged_horario_id is None:
            for r in secondaries:
                if _row_get(r, "horario_id") is not None:
                    merged_horario_id = _row_get(r, "horario_id")
                    break

        keeper_area = str(_row_get(keeper, "area_nombre") or "General").strip()

        cur.execute("""
            UPDATE empleados
            SET nombre = ?, horario_id = ?, tiene_huella = ?, tiene_rostro = ?, tiene_tarjeta = ?, admin_ui = ?, codigo_contpaqi = ?
            WHERE id = ?
        """, (keeper_name, merged_horario_id, merged_fp, merged_face, merged_card, merged_admin, merged_contpaqi, keeper["id"]))

        if keeper_name and not is_default_employee_name(keeper_name, emp_code):
            cur.execute("""
                UPDATE checadas
                SET nombre = ?, area = ?
                WHERE empresa_id = ? AND codigo_empleado = ?
            """, (keeper_name, keeper_area, emp_id, emp_code))

        for sec in secondaries:
            cur.execute("DELETE FROM empleados WHERE id = ?", (sec["id"],))


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
            marca TEXT DEFAULT 'HIKVISION',
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
    _ensure_column(conn, "relojes", "marca", "TEXT DEFAULT 'HIKVISION'")
    _ensure_column(conn, "relojes", "ultimo_serial", "INTEGER DEFAULT 0")
    _ensure_column(conn, "relojes", "ultimo_cursor", "INTEGER DEFAULT 0")
    cur.execute("UPDATE relojes SET marca = 'HIKVISION' WHERE marca IS NULL OR marca = ''")

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
            dias_laborales TEXT DEFAULT '1,2,3,4,5',
            prefijo_id TEXT DEFAULT '',
            ubicacion TEXT,
            activo INTEGER DEFAULT 1
        );
    """)
    _ensure_column(conn, "areas", "empresa_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "areas", "sucursal_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "areas", "dias_laborales", "TEXT DEFAULT '1,2,3,4,5'")
    _ensure_column(conn, "areas", "prefijo_id", "TEXT DEFAULT ''")
    _ensure_column(conn, "areas", "horario_id", "INTEGER DEFAULT NULL")
    cur.execute("UPDATE areas SET dias_laborales = '1,2,3,4,5' WHERE dias_laborales IS NULL OR dias_laborales = ''")
    cur.execute("UPDATE areas SET prefijo_id = '' WHERE prefijo_id IS NULL")

    if not conn.is_pg:
        areas_ddl = cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='areas'").fetchone()
        if areas_ddl and "codigo TEXT UNIQUE" in (areas_ddl["sql"] or ""):
            cur.execute("""
                CREATE TABLE areas_mig (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    empresa_id INTEGER DEFAULT 1,
                    sucursal_id INTEGER DEFAULT 1,
                    codigo TEXT,
                    nombre TEXT NOT NULL,
                    responsable TEXT,
                    turno TEXT,
                    horario TEXT,
                    tolerancia_min INTEGER DEFAULT 10,
                    dias_laborales TEXT DEFAULT '1,2,3,4,5',
                    prefijo_id TEXT DEFAULT '',
                    horario_id INTEGER DEFAULT NULL,
                    ubicacion TEXT,
                    activo INTEGER DEFAULT 1
                );
            """)
            cur.execute("""
                INSERT INTO areas_mig (id, empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, prefijo_id, horario_id, ubicacion, activo)
                SELECT id, COALESCE(empresa_id, 1), COALESCE(sucursal_id, 1), codigo, nombre, responsable, turno, horario, COALESCE(tolerancia_min, 10), COALESCE(dias_laborales, '1,2,3,4,5'), COALESCE(prefijo_id, ''), horario_id, ubicacion, COALESCE(activo, 1)
                FROM areas
            """)
            cur.execute("DROP TABLE areas")
            cur.execute("ALTER TABLE areas_mig RENAME TO areas")

    # 8.1 Tablas de Horarios Flexibles Multi-Bloque (horarios + horario_bloques)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS horarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL DEFAULT 1,
            sucursal_id INTEGER NOT NULL DEFAULT 1,
            nombre TEXT NOT NULL,
            descripcion TEXT DEFAULT '',
            tolerancia_min INTEGER DEFAULT 10,
            es_plantilla INTEGER DEFAULT 1,
            activo INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS horario_bloques (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            horario_id INTEGER NOT NULL,
            dia_semana INTEGER NOT NULL,
            orden_bloque INTEGER NOT NULL DEFAULT 1,
            hora_entrada TEXT NOT NULL,
            hora_salida TEXT NOT NULL,
            tolerancia_min INTEGER DEFAULT NULL
        );
    """)

    # 9. Tabla de Empleados
    cur.execute("""
        CREATE TABLE IF NOT EXISTS empleados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER DEFAULT 1,
            sucursal_id INTEGER DEFAULT 1,
            codigo_empleado TEXT NOT NULL,
            codigo_contpaqi TEXT DEFAULT '',
            nombre TEXT NOT NULL,
            area_nombre TEXT DEFAULT 'General',
            puesto TEXT DEFAULT 'Colaborador',
            turno TEXT DEFAULT 'Matutino (08:00 - 17:00)',
            horario_id INTEGER DEFAULT NULL,
            pin TEXT DEFAULT '123456',
            tiene_huella INTEGER DEFAULT 0,
            tiene_rostro INTEGER DEFAULT 0,
            tiene_tarjeta INTEGER DEFAULT 0,
            admin_ui INTEGER DEFAULT 0,
            reloj_asignado TEXT DEFAULT 'Terminal Principal',
            estado TEXT DEFAULT 'ACTIVO'
        );
    """)
    _ensure_column(conn, "empleados", "empresa_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "empleados", "sucursal_id", "INTEGER DEFAULT 1")
    _ensure_column(conn, "empleados", "codigo_contpaqi", "TEXT DEFAULT ''")
    _ensure_column(conn, "empleados", "horario_id", "INTEGER DEFAULT NULL")

    if not conn.is_pg:
        emps_ddl = cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='empleados'").fetchone()
        if emps_ddl and "codigo_empleado TEXT UNIQUE" in (emps_ddl["sql"] or ""):
            cur.execute("""
                CREATE TABLE empleados_mig (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    empresa_id INTEGER DEFAULT 1,
                    sucursal_id INTEGER DEFAULT 1,
                    codigo_empleado TEXT NOT NULL,
                    codigo_contpaqi TEXT DEFAULT '',
                    nombre TEXT NOT NULL,
                    area_nombre TEXT DEFAULT 'General',
                    puesto TEXT DEFAULT 'Colaborador',
                    turno TEXT DEFAULT 'Matutino (08:00 - 17:00)',
                    horario_id INTEGER DEFAULT NULL,
                    pin TEXT DEFAULT '123456',
                    tiene_huella INTEGER DEFAULT 0,
                    tiene_rostro INTEGER DEFAULT 0,
                    tiene_tarjeta INTEGER DEFAULT 0,
                    admin_ui INTEGER DEFAULT 0,
                    reloj_asignado TEXT DEFAULT 'Terminal Principal',
                    estado TEXT DEFAULT 'ACTIVO'
                );
            """)
            cur.execute("""
                INSERT INTO empleados_mig (id, empresa_id, sucursal_id, codigo_empleado, codigo_contpaqi, nombre, area_nombre, puesto, turno, horario_id, pin, tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado)
                SELECT id, COALESCE(empresa_id, 1), COALESCE(sucursal_id, 1), codigo_empleado, COALESCE(codigo_contpaqi, ''), nombre, area_nombre, puesto, turno, horario_id, pin, tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
                FROM empleados
            """)
            cur.execute("DROP TABLE empleados")
            cur.execute("ALTER TABLE empleados_mig RENAME TO empleados")

    # Migración automática idempotente: convertir áreas legacy sin horario_id en plantillas multi-bloque
    legacy_areas = cur.execute("""
        SELECT id, empresa_id, sucursal_id, nombre, turno, horario, tolerancia_min, dias_laborales
        FROM areas
        WHERE horario_id IS NULL
        ORDER BY id ASC
    """).fetchall()
    for la in legacy_areas:
        new_hid = _create_default_schedule_for_area(
            cur,
            empresa_id=int(la["empresa_id"] or 1),
            sucursal_id=int(la["sucursal_id"] or 1),
            area_nombre=la["nombre"],
            turno=la["turno"],
            horario_str=la["horario"],
            tolerancia_min=la["tolerancia_min"],
            dias_laborales_str=la["dias_laborales"]
        )
        cur.execute("UPDATE areas SET horario_id = ? WHERE id = ?", (new_hid, la["id"]))

    # Garantizar al menos 1 horario plantilla (Matutino por defecto) en cada sucursal activa
    branch_rows = cur.execute("""
        SELECT id, empresa_id, tolerancia_minutos
        FROM sucursales
        WHERE COALESCE(activo, 1) = 1
        ORDER BY id ASC
    """).fetchall()
    for br in branch_rows:
        ensure_default_schedule_for_branch(
            cur,
            empresa_id=int(br["empresa_id"] or 1),
            sucursal_id=int(br["id"]),
            default_tol=br["tolerancia_minutos"]
        )

    # Reparar áreas con horario_id nulo o roto (sin registro activo en horarios)
    broken_areas = cur.execute("""
        SELECT a.id, a.empresa_id, a.sucursal_id
        FROM areas a
        LEFT JOIN horarios h ON h.id = a.horario_id AND COALESCE(h.activo, 1) = 1
        WHERE a.horario_id IS NULL OR h.id IS NULL
        ORDER BY a.id ASC
    """).fetchall()
    for ba in broken_areas:
        def_hid = ensure_default_schedule_for_branch(
            cur,
            empresa_id=int(ba["empresa_id"] or 1),
            sucursal_id=int(ba["sucursal_id"] or 1)
        )
        def_h = cur.execute("SELECT tolerancia_min FROM horarios WHERE id = ?", (def_hid,)).fetchone()
        def_blocks = cur.execute(
            "SELECT dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min "
            "FROM horario_bloques WHERE horario_id = ? ORDER BY dia_semana ASC, orden_bloque ASC",
            (def_hid,)
        ).fetchall()
        def_sum = format_schedule_summary([dict(b) for b in def_blocks])
        def_tol = int(def_h["tolerancia_min"]) if def_h and def_h["tolerancia_min"] is not None else 10
        cur.execute("""
            UPDATE areas
            SET horario_id = ?, horario = ?, dias_laborales = ?, tolerancia_min = ?
            WHERE id = ?
        """, (def_hid, def_sum["resumen_corto"], def_sum["dias_laborales_str"], def_tol, ba["id"]))

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
            reloj_nombre TEXT DEFAULT 'Terminal Principal',
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
    _ensure_column(conn, "checadas", "reloj_nombre", "TEXT DEFAULT 'Terminal Principal'")
    _ensure_column(conn, "checadas", "es_manual", "INTEGER DEFAULT 0")
    _ensure_column(conn, "checadas", "nota_incidencia", "TEXT DEFAULT ''")

    # Consolidación idempotente: empleados únicos por (empresa_id, codigo_empleado) con sucursal_id como Sucursal Base
    cur.execute("UPDATE empleados SET codigo_empleado = TRIM(codigo_empleado) WHERE codigo_empleado != TRIM(codigo_empleado)")
    _deduplicate_company_employees(cur)
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS ux_empleados_empresa_codigo
        ON empleados(empresa_id, codigo_empleado)
    """)

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
        ("operator_name", "Operador RH"),
        ("operator_role", "Director de RH y Sistemas"),
        ("operator_email", "rh@quodo.mx"),
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
            remitente_nombre TEXT DEFAULT 'notificaciones@access.com',
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
        getattr(config, "SMTP_SENDER_NAME", "notificaciones@access.com"),
        getattr(config, "SMTP_USER", ""),
        getattr(config, "SMTP_DEFAULT_RECIPIENT", "")
    ))

    # ==========================================
    # SEMILLAS MULTI-TENANT Y ROLES (ADMIN_SAAS + CLIENTE_RH)
    # ==========================================
    user_count = cur.execute("SELECT COUNT(*) as c FROM usuarios_sistema").fetchone()["c"]
    if user_count == 0:
        default_users = [
            ("admin.saas", "admin@quodo.mx", hash_password("admin123"), "Administrador General SaaS", "Gestor de Cuentas y Suscripciones", "ADMIN_SAAS", "Global 24/7", "Consola Suscripciones SaaS", 1),
            ("rh.demo", "rh@quodo.mx", hash_password("quodo123"), "Administrador RH", "Recursos Humanos", "CLIENTE_RH", "Oficina", "Multiempresa • Cloud", 1),
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


def resolve_user_scope(
    user_id: int,
    empresa_id: Optional[int] = None,
    sucursal_id: Optional[int] = None,
    allow_all_branches: bool = False
) -> Tuple[int, Optional[int]]:
    """
    Valida y resuelve el par (empresa_id, sucursal_id) autorizado para el usuario RH.
    Garantiza que jamás pueda consultar datos de una empresa ajena.
    Si `allow_all_branches=True` y `sucursal_id` es None o 0, retorna `(emp_id, None)`.
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
    if allow_all_branches and (sucursal_id is None or int(sucursal_id) == 0):
        return (emp_id, None)
    if sucursal_id:
        valid_b = next((b for b in branches if b["id"] == int(sucursal_id)), None)
        if valid_b:
            return (emp_id, valid_b["id"])
    return (emp_id, branches[0]["id"] if branches else None)


def create_company_for_user(user_id: int, nombre: str, rfc: str = "", industria: str = "General", first_branch_name: str = "Sucursal Matriz") -> Dict[str, Any]:
    """Crea una nueva empresa asignando al usuario como OWNER y crea su primera sucursal."""
    conn = get_conn()
    try:
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

        # Crear horario Matutino por defecto y área general inicial para la sucursal
        area_hid = ensure_default_schedule_for_branch(cur, emp_id, suc_id, default_tol=10)
        cur.execute("""
            INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, horario_id, ubicacion)
            VALUES (?, ?, ?, 'Operaciones Generales', 'RH', 'Matutino', '08:00 - 17:00', 10, ?, ?)
        """, (emp_id, suc_id, f"AREA-GEN-{suc_id}", area_hid, first_branch_name.strip() or "Sucursal Matriz"))

        conn.commit()
        return {
            "empresa_id": emp_id,
            "sucursal_id": suc_id,
            "nombre": nombre,
            "codigo_invitacion": invite_code
        }
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()


def create_branch_for_company(empresa_id: int, nombre: str, ubicacion: str = "", codigo: str = "", debounce_seconds: int = 180, tolerancia_minutos: int = 10) -> Dict[str, Any]:
    """Crea una nueva sucursal dentro de una empresa existente."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cnt = cur.execute("SELECT COUNT(*) as c FROM sucursales WHERE empresa_id = ?", (empresa_id,)).fetchone()["c"]
        code_str = codigo.strip().upper() or f"SUC-0{cnt + 1}"

        cur.execute("""
            INSERT INTO sucursales (empresa_id, codigo, nombre, ubicacion, debounce_seconds, tolerancia_minutos)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (empresa_id, code_str, nombre.strip(), ubicacion.strip() or "Acceso Principal", int(debounce_seconds), int(tolerancia_minutos)))
        suc_id = cur.lastrowid

        area_hid = ensure_default_schedule_for_branch(cur, empresa_id, suc_id, default_tol=int(tolerancia_minutos))
        cur.execute("""
            INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, horario_id, ubicacion)
            VALUES (?, ?, ?, 'General Sucursal', 'RH', 'Matutino', '08:00 - 17:00', ?, ?, ?)
        """, (emp_id := empresa_id, suc_id, f"AREA-01-{suc_id}", int(tolerancia_minutos), area_hid, nombre.strip()))

        conn.commit()
        return {"id": suc_id, "empresa_id": emp_id, "codigo": code_str, "nombre": nombre}
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()


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


def remove_company_member(owner_user_id: int, empresa_id: int, member_user_id: int) -> Dict[str, Any]:
    """Revoca el acceso de un miembro RH de la empresa (exclusivo del OWNER)."""
    conn = get_conn()
    try:
        owner_row = conn.execute("""
            SELECT e.id, e.owner_user_id, eu.rol_empresa
            FROM empresas e
            LEFT JOIN empresa_usuarios eu ON eu.empresa_id = e.id AND eu.user_id = ?
            WHERE e.id = ? AND e.activo = 1
        """, (owner_user_id, empresa_id)).fetchone()

        if not owner_row or (
            owner_row["rol_empresa"] != "OWNER"
            and int(owner_row["owner_user_id"] or 0) != int(owner_user_id)
        ):
            return {"ok": False, "error": "Solo el creador/administrador de la empresa puede gestionar miembros."}

        if int(member_user_id) == int(owner_user_id) or int(member_user_id) == int(owner_row["owner_user_id"] or 0):
            return {"ok": False, "error": "No puedes eliminar al propietario de la empresa."}

        member = conn.execute("""
            SELECT id, rol_empresa
            FROM empresa_usuarios
            WHERE empresa_id = ? AND user_id = ?
        """, (empresa_id, member_user_id)).fetchone()

        if not member:
            return {"ok": False, "error": "El usuario no pertenece a esta empresa."}
        if member["rol_empresa"] == "OWNER":
            return {"ok": False, "error": "No puedes eliminar al propietario de la empresa."}

        conn.execute(
            "DELETE FROM empresa_usuarios WHERE empresa_id = ? AND user_id = ?",
            (empresa_id, member_user_id)
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


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
        result.append({
            "id": r["id"],
            "username": r["username"],
            "email": r["email"],
            "nombre": r["nombre"],
            "puesto": r["rol"],
            "activo": bool(r["activo"]),
            "created_at": str(r["created_at"] or "")[:19],
            "empresas_vinculadas_count": sub.get("empresas_usadas", 0),
            "relojes_vinculados_count": sub.get("relojes_usados", 0),
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
    max_empresas = int(data["max_empresas"]) if data.get("max_empresas") is not None and str(data.get("max_empresas")).strip() != "" else 5
    max_relojes = int(data["max_relojes"]) if data.get("max_relojes") is not None and str(data.get("max_relojes")).strip() != "" else 1
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
    """Permite al ADMIN_SAAS moderar cuenta, activar, suspender, renovar o ajustar límites de relojes/empresas."""
    conn = get_conn()
    cur = conn.cursor()
    u = cur.execute("SELECT id, username, email, nombre, rol, rol_sistema, activo FROM usuarios_sistema WHERE id = ?", (user_id,)).fetchone()
    if not u or u["rol_sistema"] != "CLIENTE_RH":
        conn.close()
        return {"ok": False, "error": "Usuario RH no encontrado."}

    new_nombre = (data.get("nombre") or u["nombre"]).strip() if "nombre" in data and (data.get("nombre") or "").strip() else u["nombre"]
    new_email = (data.get("email") or u["email"]).strip().lower() if "email" in data and (data.get("email") or "").strip() else u["email"]
    new_username = (data.get("username") or u["username"]).strip().lower() if "username" in data and (data.get("username") or "").strip() else u["username"]
    new_rol = (data.get("rol") or u["rol"]).strip() if "rol" in data and (data.get("rol") or "").strip() else u["rol"]

    if new_email != u["email"].lower() or new_username != u["username"].lower():
        dup = cur.execute(
            "SELECT id FROM usuarios_sistema WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND id != ?",
            (new_email, new_username, user_id)
        ).fetchone()
        if dup:
            conn.close()
            return {"ok": False, "error": "Ya existe otra cuenta registrada con ese correo o username."}

    cur.execute("""
        UPDATE usuarios_sistema SET nombre = ?, email = ?, username = ?, rol = ? WHERE id = ?
    """, (new_nombre, new_email, new_username, new_rol, user_id))

    if "activo" in data:
        cur.execute("UPDATE usuarios_sistema SET activo = ? WHERE id = ?", (1 if data["activo"] else 0, user_id))
    if data.get("new_password"):
        cur.execute("UPDATE usuarios_sistema SET password_hash = ? WHERE id = ?", (hash_password(str(data["new_password"])), user_id))

    sub = get_user_subscription(user_id, conn)
    plan = (data.get("plan") or sub["plan"]).strip().upper()
    estado = (data.get("estado") or sub["estado"]).strip().upper()
    fecha_vencimiento = (data.get("fecha_vencimiento") or sub["fecha_vencimiento"]).strip()[:10]
    max_empresas = max(0, int(data["max_empresas"])) if "max_empresas" in data and data["max_empresas"] is not None and str(data["max_empresas"]).strip() != "" else sub["max_empresas"]
    max_relojes = max(0, int(data["max_relojes"])) if "max_relojes" in data and data["max_relojes"] is not None and str(data["max_relojes"]).strip() != "" else sub["max_relojes"]
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


def admin_delete_rh_user(user_id: int) -> Dict[str, Any]:
    """Elimina una cuenta CLIENTE_RH junto con sus sesiones, suscripción y membresías."""
    conn = get_conn()
    cur = conn.cursor()
    u = cur.execute("SELECT id, rol_sistema FROM usuarios_sistema WHERE id = ?", (user_id,)).fetchone()
    if not u or u["rol_sistema"] != "CLIENTE_RH":
        conn.close()
        return {"ok": False, "error": "Usuario RH no encontrado."}

    cur.execute("DELETE FROM sesiones_usuario WHERE user_id = ?", (user_id,))
    cur.execute("DELETE FROM suscripciones WHERE user_id = ?", (user_id,))
    cur.execute("DELETE FROM empresa_usuarios WHERE user_id = ?", (user_id,))
    cur.execute("DELETE FROM usuarios_sistema WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


def update_user_own_account(user_id: int, data: Dict[str, Any]) -> Dict[str, Any]:
    """Permite al usuario autenticado actualizar su propia cuenta (nombre, correo, username, puesto, turno y contraseña)."""
    conn = get_conn()
    cur = conn.cursor()
    u = cur.execute("SELECT * FROM usuarios_sistema WHERE id = ?", (user_id,)).fetchone()
    if not u:
        conn.close()
        return {"ok": False, "error": "Usuario no encontrado."}

    new_nombre = (data.get("nombre") or data.get("operator_name") or u["nombre"]).strip()
    new_email = (data.get("email") or data.get("operator_email") or u["email"]).strip().lower()
    new_username = (data.get("username") or u["username"]).strip().lower()
    new_rol = (data.get("rol") or data.get("operator_role") or u["rol"]).strip()
    new_turno = (data.get("turno") or data.get("operator_shift") or u["turno"]).strip()

    if not new_nombre or not new_email or not new_username:
        conn.close()
        return {"ok": False, "error": "Nombre, correo electrónico y usuario son obligatorios."}

    if new_email != u["email"].lower() or new_username != u["username"].lower():
        dup = cur.execute(
            "SELECT id FROM usuarios_sistema WHERE (LOWER(email) = ? OR LOWER(username) = ?) AND id != ?",
            (new_email, new_username, user_id)
        ).fetchone()
        if dup:
            conn.close()
            return {"ok": False, "error": "Ya existe otra cuenta con ese correo electrónico o nombre de usuario."}

    cur.execute("""
        UPDATE usuarios_sistema
        SET nombre = ?, email = ?, username = ?, rol = ?, turno = ?
        WHERE id = ?
    """, (new_nombre, new_email, new_username, new_rol, new_turno, user_id))

    if data.get("new_password"):
        cur.execute(
            "UPDATE usuarios_sistema SET password_hash = ? WHERE id = ?",
            (hash_password(str(data["new_password"]).strip()), user_id)
        )

    conn.commit()
    updated_row = cur.execute("""
        SELECT id, username, email, nombre, rol, rol_sistema, turno, nodo, activo
        FROM usuarios_sistema WHERE id = ?
    """, (user_id,)).fetchone()
    user_dict = _build_user_dict(updated_row, conn)
    conn.close()
    return {"ok": True, "user": user_dict}


# ==========================================
# MOTOR AUXILIAR DE HORARIOS Y PRE-NÓMINA (SCOPED POR EMPRESA / SUCURSAL)
# ==========================================

def _parse_event_naive_dt(raw_str: Any) -> Optional[datetime.datetime]:
    if not raw_str:
        return None
    try:
        clean_dt_str = str(raw_str).strip().replace("Z", "").replace("T", " ")[:19]
        return datetime.datetime.fromisoformat(clean_dt_str)
    except Exception:
        return None


def validate_and_normalize_blocks(bloques: List[Dict[str, Any]]) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """Valida bloques semanales (Lun=1..Dom=7) sin cruces de medianoche ni solapamientos."""
    if not isinstance(bloques, list) or not bloques:
        return (None, "Debes configurar al menos un día y bloque horario.")

    by_day: Dict[int, List[Tuple[datetime.time, datetime.time, Dict[str, Any]]]] = {}
    for b in bloques:
        if not isinstance(b, dict):
            return (None, "Formato inválido en bloque horario.")
        try:
            day_num = int(b.get("dia_semana"))
        except Exception:
            return (None, "Día de la semana inválido en bloque horario.")
        if day_num < 1 or day_num > 7:
            return (None, f"Día de la semana fuera de rango ({day_num}). Debe estar entre 1 (Lun) y 7 (Dom).")

        t_in = _parse_hhmm(b.get("hora_entrada"))
        t_out = _parse_hhmm(b.get("hora_salida"))
        if not t_in or not t_out:
            return (None, f"Formato de hora inválido en {WEEK_DAY_LABELS[day_num]} (usa HH:MM).")
        if t_in >= t_out:
            return (
                None,
                f"En {WEEK_DAY_LABELS[day_num]}, la hora de entrada ({t_in.strftime('%H:%M')}) debe ser menor que la salida ({t_out.strftime('%H:%M')}). No se admiten turnos nocturnos."
            )

        tol_raw = b.get("tolerancia_min")
        tol_block: Optional[int] = None
        if tol_raw is not None and str(tol_raw).strip() != "":
            try:
                tol_block = max(0, int(tol_raw))
            except Exception:
                return (None, f"Tolerancia inválida en {WEEK_DAY_LABELS[day_num]}.")

        by_day.setdefault(day_num, []).append((
            t_in,
            t_out,
            {
                "dia_semana": day_num,
                "hora_entrada": t_in.strftime("%H:%M"),
                "hora_salida": t_out.strftime("%H:%M"),
                "tolerancia_min": tol_block
            }
        ))

    if not by_day:
        return (None, "Debes configurar al menos un día y bloque horario.")

    normalized: List[Dict[str, Any]] = []
    for day_num in sorted(by_day.keys()):
        day_items = sorted(by_day[day_num], key=lambda item: (item[0], item[1]))
        prev_out: Optional[datetime.time] = None
        for idx, (t_in, t_out, block_dict) in enumerate(day_items, start=1):
            if prev_out is not None and t_in <= prev_out:
                return (
                    None,
                    f"En {WEEK_DAY_LABELS[day_num]}, los bloques se empalman o no tienen descanso entre ellos "
                    f"(salida {prev_out.strftime('%H:%M')} vs entrada {t_in.strftime('%H:%M')})."
                )
            prev_out = t_out
            normalized.append({
                "dia_semana": day_num,
                "orden_bloque": idx,
                "hora_entrada": block_dict["hora_entrada"],
                "hora_salida": block_dict["hora_salida"],
                "tolerancia_min": block_dict["tolerancia_min"]
            })

    return (normalized, None)


def _assemble_schedule_dicts(
    sched_rows: List[Any],
    block_rows: List[Any],
    areas_counts: Dict[int, int],
    emps_counts: Dict[int, int]
) -> List[Dict[str, Any]]:
    blocks_by_hid: Dict[int, List[Dict[str, Any]]] = {}
    for br in block_rows:
        hid = int(br["horario_id"])
        blocks_by_hid.setdefault(hid, []).append({
            "id": br["id"],
            "horario_id": hid,
            "dia_semana": int(br["dia_semana"]),
            "orden_bloque": int(br["orden_bloque"] or 1),
            "hora_entrada": str(br["hora_entrada"])[:5],
            "hora_salida": str(br["hora_salida"])[:5],
            "tolerancia_min": br["tolerancia_min"]
        })

    result = []
    for sr in sched_rows:
        hid = int(sr["id"])
        raw_blocks = blocks_by_hid.get(hid, [])
        summary = format_schedule_summary(raw_blocks)
        bloques_dia_json = {str(k): v for k, v in summary["bloques_por_dia"].items()}
        tol_val = int(sr["tolerancia_min"]) if sr["tolerancia_min"] is not None else 10
        result.append({
            "id": hid,
            "empresa_id": int(sr["empresa_id"]),
            "sucursal_id": int(sr["sucursal_id"]),
            "nombre": sr["nombre"],
            "descripcion": sr["descripcion"] or "",
            "tolerancia_min": tol_val,
            "es_plantilla": bool(sr["es_plantilla"] if sr["es_plantilla"] is not None else 1),
            "bloques": raw_blocks,
            "bloques_por_dia": bloques_dia_json,
            "dias_laborales": summary["dias_laborales_str"],
            "es_mixto": summary["es_mixto"],
            "horas_semanales": summary["horas_semanales"],
            "resumen_corto": summary["resumen_corto"],
            "resumen_detalle": summary["resumen_detalle"],
            "areas_count": int(areas_counts.get(hid, 0)),
            "empleados_count": int(emps_counts.get(hid, 0))
        })
    return result


def get_schedules_for_branch(
    empresa_id: int,
    sucursal_id: Optional[int] = None,
    include_custom: bool = False,
    conn: Optional[DualConnection] = None
) -> List[Dict[str, Any]]:
    """Lista los horarios configurados de la empresa/sucursal con sus bloques y conteos de uso."""
    owns_conn = conn is None
    if owns_conn:
        conn = get_conn()
    try:
        conds = ["empresa_id = ?", "COALESCE(activo, 1) = 1"]
        params: List[Any] = [empresa_id]
        if sucursal_id:
            conds.append("sucursal_id = ?")
            params.append(sucursal_id)
        if not include_custom:
            conds.append("COALESCE(es_plantilla, 1) = 1")
        where_sql = " AND ".join(conds)

        sched_rows = conn.execute(
            f"SELECT id, empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo "
            f"FROM horarios WHERE {where_sql} ORDER BY id ASC",
            tuple(params)
        ).fetchall()
        if not sched_rows and sucursal_id and not include_custom:
            ensure_default_schedule_for_branch(conn.cursor(), int(empresa_id), int(sucursal_id))
            if owns_conn:
                conn.commit()
            sched_rows = conn.execute(
                f"SELECT id, empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo "
                f"FROM horarios WHERE {where_sql} ORDER BY id ASC",
                tuple(params)
            ).fetchall()
        if not sched_rows:
            return []

        hids = [int(r["id"]) for r in sched_rows]
        ph = ",".join("?" for _ in hids)
        block_rows = conn.execute(
            f"SELECT id, horario_id, dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min "
            f"FROM horario_bloques WHERE horario_id IN ({ph}) ORDER BY dia_semana ASC, orden_bloque ASC, hora_entrada ASC",
            tuple(hids)
        ).fetchall()

        area_cnt_rows = conn.execute(
            f"SELECT horario_id, COUNT(*) as c FROM areas WHERE empresa_id = ? AND horario_id IN ({ph}) GROUP BY horario_id",
            tuple([empresa_id] + hids)
        ).fetchall()
        emp_cnt_rows = conn.execute(
            f"SELECT horario_id, COUNT(*) as c FROM empleados WHERE empresa_id = ? AND horario_id IN ({ph}) GROUP BY horario_id",
            tuple([empresa_id] + hids)
        ).fetchall()

        areas_counts = {int(r["horario_id"]): int(r["c"]) for r in area_cnt_rows if r["horario_id"] is not None}
        emps_counts = {int(r["horario_id"]): int(r["c"]) for r in emp_cnt_rows if r["horario_id"] is not None}
        return _assemble_schedule_dicts(sched_rows, block_rows, areas_counts, emps_counts)
    finally:
        if owns_conn:
            conn.close()


def get_schedule_by_id(schedule_id: int, empresa_id: int, conn: Optional[DualConnection] = None) -> Optional[Dict[str, Any]]:
    owns_conn = conn is None
    if owns_conn:
        conn = get_conn()
    try:
        sr = conn.execute(
            "SELECT id, empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo "
            "FROM horarios WHERE id = ? AND empresa_id = ? AND COALESCE(activo, 1) = 1",
            (int(schedule_id), int(empresa_id))
        ).fetchone()
        if not sr:
            return None
        block_rows = conn.execute(
            "SELECT id, horario_id, dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min "
            "FROM horario_bloques WHERE horario_id = ? ORDER BY dia_semana ASC, orden_bloque ASC, hora_entrada ASC",
            (int(schedule_id),)
        ).fetchall()
        a_cnt = conn.execute(
            "SELECT COUNT(*) as c FROM areas WHERE empresa_id = ? AND horario_id = ?",
            (int(empresa_id), int(schedule_id))
        ).fetchone()["c"]
        e_cnt = conn.execute(
            "SELECT COUNT(*) as c FROM empleados WHERE empresa_id = ? AND horario_id = ?",
            (int(empresa_id), int(schedule_id))
        ).fetchone()["c"]
        return _assemble_schedule_dicts(
            [sr], block_rows, {int(schedule_id): int(a_cnt)}, {int(schedule_id): int(e_cnt)}
        )[0]
    finally:
        if owns_conn:
            conn.close()


def save_schedule(
    empresa_id: int,
    sucursal_id: int,
    data: Dict[str, Any],
    conn: Optional[DualConnection] = None
) -> Dict[str, Any]:
    """Crea o actualiza un horario multi-bloque y sincroniza áreas vinculadas."""
    nombre = str(data.get("nombre") or "").strip()
    if not nombre:
        return {"ok": False, "error": "El nombre del horario es obligatorio."}

    descripcion = str(data.get("descripcion") or "").strip()
    raw_tol = data.get("tolerancia_min", 10)
    try:
        tolerancia_min = max(0, int(raw_tol if raw_tol is not None and str(raw_tol).strip() != "" else 10))
    except Exception:
        return {"ok": False, "error": "La tolerancia en minutos debe ser un número entero."}

    es_plantilla = 1 if data.get("es_plantilla", 1) else 0
    norm_blocks, err = validate_and_normalize_blocks(data.get("bloques") or [])
    if err or not norm_blocks:
        return {"ok": False, "error": err or "Bloques horarios inválidos."}

    owns_conn = conn is None
    if owns_conn:
        conn = get_conn()
    try:
        cur = conn.cursor()
        schedule_id = data.get("id")
        if schedule_id:
            existing = cur.execute(
                "SELECT id FROM horarios WHERE id = ? AND empresa_id = ?",
                (int(schedule_id), int(empresa_id))
            ).fetchone()
            if not existing:
                return {"ok": False, "error": "Horario no encontrado."}
            schedule_id = int(schedule_id)
            cur.execute("""
                UPDATE horarios
                SET nombre = ?, descripcion = ?, tolerancia_min = ?, es_plantilla = ?, activo = 1
                WHERE id = ? AND empresa_id = ?
            """, (nombre, descripcion, tolerancia_min, es_plantilla, schedule_id, int(empresa_id)))
            cur.execute("DELETE FROM horario_bloques WHERE horario_id = ?", (schedule_id,))
        else:
            cur.execute("""
                INSERT INTO horarios (empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo)
                VALUES (?, ?, ?, ?, ?, ?, 1)
            """, (int(empresa_id), int(sucursal_id), nombre, descripcion, tolerancia_min, es_plantilla))
            schedule_id = int(cur.lastrowid)

        for blk in norm_blocks:
            cur.execute("""
                INSERT INTO horario_bloques (horario_id, dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                schedule_id,
                blk["dia_semana"],
                blk["orden_bloque"],
                blk["hora_entrada"],
                blk["hora_salida"],
                blk["tolerancia_min"]
            ))

        summary = format_schedule_summary(norm_blocks)
        cur.execute("""
            UPDATE areas
            SET horario = ?, dias_laborales = ?, tolerancia_min = ?
            WHERE horario_id = ? AND empresa_id = ?
        """, (summary["resumen_corto"], summary["dias_laborales_str"], tolerancia_min, schedule_id, int(empresa_id)))

        if owns_conn:
            conn.commit()

        sched_dict = get_schedule_by_id(schedule_id, empresa_id, conn=conn)
        return {"ok": True, "id": schedule_id, "schedule": sched_dict}
    except Exception:
        if owns_conn:
            conn._conn.rollback()
        raise
    finally:
        if owns_conn:
            conn.close()


def delete_schedule(schedule_id: int, empresa_id: int) -> Dict[str, Any]:
    """Elimina un horario si no es el único de la sucursal ni base de ningún área y revierte empleados a herencia."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        row = cur.execute(
            "SELECT id, sucursal_id, es_plantilla FROM horarios WHERE id = ? AND empresa_id = ?",
            (int(schedule_id), int(empresa_id))
        ).fetchone()
        if not row:
            return {"ok": False, "error": "Horario no encontrado."}

        is_tpl = int(row["es_plantilla"] if row["es_plantilla"] is not None else 1) == 1
        if is_tpl:
            tpl_cnt = cur.execute("""
                SELECT COUNT(*) as c FROM horarios
                WHERE empresa_id = ? AND sucursal_id = ?
                  AND COALESCE(es_plantilla, 1) = 1 AND COALESCE(activo, 1) = 1
            """, (int(empresa_id), int(row["sucursal_id"]))).fetchone()["c"]
            if int(tpl_cnt) <= 1:
                return {
                    "ok": False,
                    "error": "Siempre debe existir al menos un horario activo en la sucursal. Crea otro horario antes de eliminar este."
                }

        area_cnt = cur.execute(
            "SELECT COUNT(*) as c FROM areas WHERE empresa_id = ? AND horario_id = ?",
            (int(empresa_id), int(schedule_id))
        ).fetchone()["c"]
        if int(area_cnt) > 0:
            return {
                "ok": False,
                "error": "Este horario está asignado como horario base de una o más áreas. Cambia primero el horario de esas áreas."
            }

        emp_cnt = cur.execute(
            "SELECT COUNT(*) as c FROM empleados WHERE empresa_id = ? AND horario_id = ?",
            (int(empresa_id), int(schedule_id))
        ).fetchone()["c"]
        cur.execute(
            "UPDATE empleados SET horario_id = NULL WHERE empresa_id = ? AND horario_id = ?",
            (int(empresa_id), int(schedule_id))
        )
        cur.execute("DELETE FROM horario_bloques WHERE horario_id = ?", (int(schedule_id),))
        cur.execute("DELETE FROM horarios WHERE id = ? AND empresa_id = ?", (int(schedule_id), int(empresa_id)))
        conn.commit()
        return {"ok": True, "unlinked_employees": int(emp_cnt)}
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()


def cleanup_orphan_custom_schedule(cur: DualCursor, old_horario_id: Optional[int], empresa_id: int):
    """Elimina un horario personalizado (es_plantilla=0) cuando queda sin empleados ni áreas vinculadas."""
    if not old_horario_id:
        return
    hid = int(old_horario_id)
    row = cur.execute(
        "SELECT id, es_plantilla FROM horarios WHERE id = ? AND empresa_id = ?",
        (hid, int(empresa_id))
    ).fetchone()
    if not row or int(row["es_plantilla"] if row["es_plantilla"] is not None else 1) != 0:
        return
    emp_cnt = cur.execute(
        "SELECT COUNT(*) as c FROM empleados WHERE empresa_id = ? AND horario_id = ?",
        (int(empresa_id), hid)
    ).fetchone()["c"]
    area_cnt = cur.execute(
        "SELECT COUNT(*) as c FROM areas WHERE empresa_id = ? AND horario_id = ?",
        (int(empresa_id), hid)
    ).fetchone()["c"]
    if int(emp_cnt) == 0 and int(area_cnt) == 0:
        cur.execute("DELETE FROM horario_bloques WHERE horario_id = ?", (hid,))
        cur.execute("DELETE FROM horarios WHERE id = ? AND empresa_id = ?", (hid, int(empresa_id)))


def _compile_blocks_by_day(bloques: List[Dict[str, Any]], sched_tol: int) -> Dict[int, List[Dict[str, Any]]]:
    compiled: Dict[int, List[Dict[str, Any]]] = {}
    for b in bloques:
        d_num = int(b["dia_semana"])
        t_in = _parse_hhmm(b["hora_entrada"])
        t_out = _parse_hhmm(b["hora_salida"])
        if not t_in or not t_out:
            continue
        blk_tol = int(b["tolerancia_min"]) if b.get("tolerancia_min") is not None else int(sched_tol)
        compiled.setdefault(d_num, []).append({
            "dia_semana": d_num,
            "orden_bloque": int(b.get("orden_bloque") or 1),
            "hora_entrada": t_in,
            "hora_salida": t_out,
            "hora_entrada_str": t_in.strftime("%H:%M"),
            "hora_salida_str": t_out.strftime("%H:%M"),
            "tolerancia_min": blk_tol
        })
    for d_num in compiled:
        compiled[d_num].sort(key=lambda x: (x["hora_entrada"], x["orden_bloque"]))
        for idx, blk in enumerate(compiled[d_num], start=1):
            blk["orden_bloque"] = idx
    return compiled


def build_schedule_resolver(
    conn: DualConnection,
    empresa_id: int,
    sucursal_id: Optional[int] = None,
    default_tol: int = 10
) -> Dict[str, Any]:
    """Carga en memoria horarios, bloques, áreas y empleados de la empresa para resolución cross-sucursal sin N+1."""
    sched_rows = conn.execute(
        "SELECT id, empresa_id, sucursal_id, nombre, descripcion, tolerancia_min, es_plantilla, activo "
        "FROM horarios WHERE empresa_id = ? AND COALESCE(activo, 1) = 1 ORDER BY id ASC",
        (int(empresa_id),)
    ).fetchall()

    blocks_by_hid: Dict[int, List[Dict[str, Any]]] = {}
    if sched_rows:
        hids = [int(r["id"]) for r in sched_rows]
        ph = ",".join("?" for _ in hids)
        block_rows = conn.execute(
            f"SELECT id, horario_id, dia_semana, orden_bloque, hora_entrada, hora_salida, tolerancia_min "
            f"FROM horario_bloques WHERE horario_id IN ({ph}) ORDER BY dia_semana ASC, orden_bloque ASC, hora_entrada ASC",
            tuple(hids)
        ).fetchall()
        for br in block_rows:
            hid = int(br["horario_id"])
            blocks_by_hid.setdefault(hid, []).append({
                "dia_semana": int(br["dia_semana"]),
                "orden_bloque": int(br["orden_bloque"] or 1),
                "hora_entrada": str(br["hora_entrada"])[:5],
                "hora_salida": str(br["hora_salida"])[:5],
                "tolerancia_min": br["tolerancia_min"]
            })

    schedules_by_id: Dict[int, Dict[str, Any]] = {}
    for sr in sched_rows:
        hid = int(sr["id"])
        raw_blocks = blocks_by_hid.get(hid, [])
        tol_val = int(sr["tolerancia_min"]) if sr["tolerancia_min"] is not None else int(default_tol)
        summary = format_schedule_summary(raw_blocks)
        schedules_by_id[hid] = {
            "id": hid,
            "nombre": sr["nombre"],
            "descripcion": sr["descripcion"] or "",
            "tolerancia_min": tol_val,
            "es_plantilla": bool(sr["es_plantilla"] if sr["es_plantilla"] is not None else 1),
            "bloques": raw_blocks,
            "bloques_por_dia": _compile_blocks_by_day(raw_blocks, tol_val),
            "dias_laborales": set(summary["dias_laborales"]),
            "dias_laborales_str": summary["dias_laborales_str"],
            "horas_semanales": summary["horas_semanales"],
            "es_mixto": summary["es_mixto"],
            "resumen_corto": summary["resumen_corto"],
            "resumen_detalle": summary["resumen_detalle"]
        }

    area_rows = conn.execute(
        "SELECT id, sucursal_id, nombre, turno, horario, tolerancia_min, dias_laborales, prefijo_id, horario_id "
        "FROM areas WHERE empresa_id = ? ORDER BY id ASC",
        (int(empresa_id),)
    ).fetchall()
    areas_by_name: Dict[str, Dict[str, Any]] = {}
    areas_by_lower: Dict[str, Dict[str, Any]] = {}
    areas_by_branch_lower: Dict[Tuple[int, str], Dict[str, Any]] = {}
    # Insertar primero áreas de otras sucursales y luego las de la sucursal activa para priorizarla en consultas sin sucursal
    ordered_areas = sorted(
        [dict(ar) for ar in area_rows],
        key=lambda a: (1 if (sucursal_id and int(a.get("sucursal_id") or 0) == int(sucursal_id)) else 0, int(a.get("id") or 0))
    )
    for ar_dict in ordered_areas:
        b_id = int(ar_dict.get("sucursal_id") or 0)
        low_name = str(ar_dict["nombre"] or "").strip().lower()
        areas_by_name[ar_dict["nombre"]] = ar_dict
        areas_by_lower[low_name] = ar_dict
        areas_by_branch_lower[(b_id, low_name)] = ar_dict

    emp_rows = conn.execute(
        "SELECT id, sucursal_id, codigo_empleado, area_nombre, turno, horario_id FROM empleados WHERE empresa_id = ?",
        (int(empresa_id),)
    ).fetchall()
    employees_by_code = {str(er["codigo_empleado"]): dict(er) for er in emp_rows}

    tpl_rows = [
        sr for sr in sched_rows
        if int(sr["es_plantilla"] if sr["es_plantilla"] is not None else 1) == 1
    ]
    default_schedule_by_branch: Dict[int, int] = {}
    by_branch_tpl: Dict[int, List[Any]] = {}
    for sr in tpl_rows:
        by_branch_tpl.setdefault(int(sr["sucursal_id"] or 0), []).append(sr)
    for b_id, b_pool in by_branch_tpl.items():
        mat_row = next((sr for sr in b_pool if "matutino" in str(sr["nombre"] or "").lower()), None)
        default_schedule_by_branch[b_id] = int((mat_row or b_pool[0])["id"])

    branch_pool = (
        [sr for sr in tpl_rows if int(sr["sucursal_id"] or 0) == int(sucursal_id)]
        if sucursal_id
        else tpl_rows
    )
    pool = branch_pool or tpl_rows
    default_schedule_id: Optional[int] = None
    if pool:
        mat_row = next((sr for sr in pool if "matutino" in str(sr["nombre"] or "").lower()), None)
        default_schedule_id = int((mat_row or pool[0])["id"])

    return {
        "default_tol": int(default_tol),
        "default_schedule_id": default_schedule_id,
        "default_schedule_by_branch": default_schedule_by_branch,
        "schedules_by_id": schedules_by_id,
        "areas_by_name": areas_by_name,
        "areas_by_lower": areas_by_lower,
        "areas_by_branch_lower": areas_by_branch_lower,
        "employees_by_code": employees_by_code
    }


def resolve_employee_schedule(
    resolver: Dict[str, Any],
    emp_code: Optional[str] = None,
    area_name: Optional[str] = None,
    emp_horario_id: Optional[int] = None
) -> Dict[str, Any]:
    """Resuelve el horario efectivo del colaborador (Horario Propio -> Horario de Área en su Sucursal Base -> Fallback)."""
    emp_row = resolver["employees_by_code"].get(str(emp_code)) if emp_code is not None else None
    eff_emp_hid = emp_horario_id if emp_horario_id is not None else (emp_row.get("horario_id") if emp_row else None)
    eff_area = area_name or (emp_row.get("area_nombre") if emp_row else None) or "General"
    eff_area_low = str(eff_area).strip().lower()
    emp_suc_id = int(emp_row["sucursal_id"]) if (emp_row and emp_row.get("sucursal_id") is not None) else None

    area_row = None
    if emp_suc_id is not None:
        area_row = resolver.get("areas_by_branch_lower", {}).get((emp_suc_id, eff_area_low))
    if not area_row:
        area_row = resolver["areas_by_name"].get(eff_area) or resolver["areas_by_lower"].get(eff_area_low)
    default_tol = resolver["default_tol"]

    if eff_emp_hid is not None:
        try:
            hid_int = int(eff_emp_hid)
        except Exception:
            hid_int = None
        if hid_int and hid_int in resolver["schedules_by_id"]:
            sched = resolver["schedules_by_id"][hid_int]
            return {
                **sched,
                "horario_id": hid_int,
                "horario_nombre": sched["nombre"],
                "origen": "ASIGNADO" if sched["es_plantilla"] else "PERSONALIZADO"
            }

    if area_row and area_row.get("horario_id") is not None:
        try:
            area_hid = int(area_row["horario_id"])
        except Exception:
            area_hid = None
        if area_hid and area_hid in resolver["schedules_by_id"]:
            sched = resolver["schedules_by_id"][area_hid]
            return {
                **sched,
                "horario_id": area_hid,
                "horario_nombre": sched["nombre"],
                "origen": "AREA"
            }

    if area_row:
        t_ent, t_sal = parse_horario(area_row.get("horario"))
        tol_val = int(area_row["tolerancia_min"]) if area_row.get("tolerancia_min") is not None else default_tol
        raw_dl = area_row.get("dias_laborales") or "1,2,3,4,5"
        dias_set = sorted({
            int(x.strip()) for x in str(raw_dl).split(",")
            if x.strip().isdigit() and 1 <= int(x.strip()) <= 7
        }) or [1, 2, 3, 4, 5]
        raw_blocks: List[Dict[str, Any]] = []
        if t_ent and t_sal and t_ent < t_sal:
            ent_str = t_ent.strftime("%H:%M")
            sal_str = t_sal.strftime("%H:%M")
            for d_num in dias_set:
                raw_blocks.append({
                    "dia_semana": d_num,
                    "orden_bloque": 1,
                    "hora_entrada": ent_str,
                    "hora_salida": sal_str,
                    "tolerancia_min": None
                })
        summary = format_schedule_summary(raw_blocks)
        return {
            "id": None,
            "horario_id": None,
            "nombre": f"{(area_row.get('turno') or 'Estándar').strip()} — {area_row.get('nombre')}",
            "horario_nombre": f"{(area_row.get('turno') or 'Estándar').strip()} — {area_row.get('nombre')}",
            "descripcion": "",
            "tolerancia_min": tol_val,
            "es_plantilla": True,
            "bloques": raw_blocks,
            "bloques_por_dia": _compile_blocks_by_day(raw_blocks, tol_val),
            "dias_laborales": set(summary["dias_laborales"]),
            "dias_laborales_str": summary["dias_laborales_str"],
            "horas_semanales": summary["horas_semanales"],
            "es_mixto": summary["es_mixto"],
            "resumen_corto": summary["resumen_corto"],
            "resumen_detalle": summary["resumen_detalle"],
            "origen": "AREA"
        }

    def_hid = (
        resolver.get("default_schedule_by_branch", {}).get(emp_suc_id)
        if emp_suc_id is not None
        else None
    ) or resolver.get("default_schedule_id")
    if def_hid and def_hid in resolver["schedules_by_id"]:
        sched = resolver["schedules_by_id"][def_hid]
        return {
            **sched,
            "horario_id": def_hid,
            "horario_nombre": sched["nombre"],
            "origen": "DEFAULT"
        }

    return {
        "id": None,
        "horario_id": None,
        "nombre": "Sin horario",
        "horario_nombre": "Sin horario",
        "descripcion": "",
        "tolerancia_min": default_tol,
        "es_plantilla": True,
        "bloques": [],
        "bloques_por_dia": {},
        "dias_laborales": set(),
        "dias_laborales_str": "",
        "horas_semanales": 0.0,
        "es_mixto": False,
        "resumen_corto": (emp_row.get("turno") if emp_row else None) or "Sin horario definido",
        "resumen_detalle": "",
        "origen": "SIN_HORARIO"
    }


def evaluate_day_blocks(
    day_date: datetime.date,
    day_recs: List[Any],
    day_blocks: List[Dict[str, Any]],
    default_tolerance: int = 10
) -> Dict[str, Any]:
    """
    Evalúa todas las checadas válidas de un día calendario contra los bloques del día:
    - 0 bloques (descanso): nunca marca retardo ni falta; empareja checadas consecutivas para horas.
    - 1 bloque: evaluación directa entrada/salida, horas trabajadas y horas extra efectivas.
    - >=2 bloques: asignación por punto medio entre bloques con rebalanceo de frontera;
      máximo 1 retardo por día en Pre-Nómina; ausencia en bloque completo solo reporta horas trabajadas.
    """
    day_str = day_date.strftime("%Y-%m-%d")
    horario_dia = (
        "Descanso"
        if not day_blocks
        else " / ".join(f"{b['hora_entrada_str']}-{b['hora_salida_str']}" for b in day_blocks)
    )

    parsed_recs: List[Tuple[datetime.datetime, Any]] = []
    unparsed_recs: List[Any] = []
    for rec in day_recs or []:
        dt_val = _parse_event_naive_dt(_row_get(rec, "fecha_hora_evento"))
        if dt_val is None:
            unparsed_recs.append(rec)
        else:
            parsed_recs.append((dt_val, rec))
    parsed_recs.sort(key=lambda item: (item[0], int(_row_get(item[1], "id") or 0)))

    punch_statuses: Dict[Any, str] = {}
    for rec in unparsed_recs:
        rid = _row_get(rec, "id")
        if rid is not None:
            punch_statuses[rid] = "JUSTIFICADO (MANUAL)" if bool(_row_get(rec, "es_manual")) else "PUNTUAL"

    es_manual_dia = any(bool(_row_get(r, "es_manual")) for r in (day_recs or []))
    notas_dia = [
        str(_row_get(r, "nota_incidencia")).strip()
        for r in (day_recs or [])
        if _row_get(r, "nota_incidencia") and str(_row_get(r, "nota_incidencia")).strip()
    ]
    nota_incidencia_dia = " • ".join(dict.fromkeys(notas_dia)) if notas_dia else ""

    first_rec = parsed_recs[0][1] if parsed_recs else (day_recs[0] if day_recs else None)
    first_metodo = (_row_get(first_rec, "metodo") or "BIOMETRÍA") if first_rec else "BIOMETRÍA"
    used_relojes = list(dict.fromkeys((_row_get(r, "reloj_nombre") or "Terminal") for _, r in parsed_recs))
    first_reloj = " → ".join(used_relojes) if used_relojes else ((_row_get(first_rec, "reloj_nombre") or "Terminal") if first_rec else "Terminal")

    if not parsed_recs:
        return {
            "fecha": day_str,
            "entrada": "—",
            "salida": "—",
            "horas": 0.0,
            "worked_sec": 0.0,
            "extra_sec": 0.0,
            "total_checadas": len(day_recs or []),
            "es_descanso": len(day_blocks) == 0,
            "es_retardo": False,
            "minutos_retardo": 0,
            "es_incompleto": False,
            "es_manual": es_manual_dia,
            "estatus_entrada": "SIN REGISTRO",
            "tipos_incidencia": [],
            "nota_incidencia": nota_incidencia_dia,
            "tiene_incidencia": bool(nota_incidencia_dia),
            "horario_dia": horario_dia,
            "bloques_detalle": [],
            "punch_statuses": punch_statuses,
            "metodo": first_metodo,
            "reloj": first_reloj
        }

    # Caso 1: Día de descanso o sin bloques definidos
    if len(day_blocks) == 0:
        worked_sec = 0.0
        for idx in range(0, len(parsed_recs), 2):
            dt_in, rec_in = parsed_recs[idx]
            rid_in = _row_get(rec_in, "id")
            if rid_in is not None:
                punch_statuses[rid_in] = "JUSTIFICADO (MANUAL)" if bool(_row_get(rec_in, "es_manual")) else "PUNTUAL"
            if idx + 1 < len(parsed_recs):
                dt_out, rec_out = parsed_recs[idx + 1]
                rid_out = _row_get(rec_out, "id")
                if rid_out is not None:
                    punch_statuses[rid_out] = "SALIDA / REGISTRO"
                worked_sec += max(0.0, (dt_out - dt_in).total_seconds())

        es_incompleto = (len(parsed_recs) % 2 == 1)
        entrada = parsed_recs[0][0].strftime("%H:%M:%S")
        salida = "Sin salida" if es_incompleto else parsed_recs[-1][0].strftime("%H:%M:%S")
        estatus_entrada = "JUSTIFICADO (MANUAL)" if bool(_row_get(parsed_recs[0][1], "es_manual")) else "PUNTUAL"
        tipos_incidencia: List[str] = []
        if es_incompleto:
            tipos_incidencia.append("DÍA INCOMPLETO (Sin salida)")
        if es_manual_dia:
            tipos_incidencia.append("JUSTIFICADO / MANUAL")

        return {
            "fecha": day_str,
            "entrada": entrada,
            "salida": salida,
            "horas": round(worked_sec / 3600.0, 1),
            "worked_sec": worked_sec,
            "extra_sec": 0.0,
            "total_checadas": len(parsed_recs),
            "es_descanso": True,
            "es_retardo": False,
            "minutos_retardo": 0,
            "es_incompleto": es_incompleto,
            "es_manual": es_manual_dia,
            "estatus_entrada": estatus_entrada,
            "tipos_incidencia": tipos_incidencia,
            "nota_incidencia": nota_incidencia_dia,
            "tiene_incidencia": bool(tipos_incidencia or nota_incidencia_dia),
            "horario_dia": horario_dia,
            "bloques_detalle": [],
            "punch_statuses": punch_statuses,
            "metodo": first_metodo,
            "reloj": first_reloj
        }

    # Caso 2: Un solo bloque en el día
    if len(day_blocks) == 1:
        blk = day_blocks[0]
        dt_sched_in = datetime.datetime.combine(day_date, blk["hora_entrada"])
        dt_sched_out = datetime.datetime.combine(day_date, blk["hora_salida"])
        tol = int(blk["tolerancia_min"]) if blk.get("tolerancia_min") is not None else int(default_tolerance)
        dt_limit = dt_sched_in + datetime.timedelta(minutes=tol)

        dt0, rec0 = parsed_recs[0]
        is_man0 = bool(_row_get(rec0, "es_manual"))
        es_retardo = False
        min_retardo = 0
        if dt0 <= dt_limit:
            estatus_entrada = "PUNTUAL"
        elif is_man0:
            estatus_entrada = "JUSTIFICADO (MANUAL)"
        else:
            diff_min = max(1, int(round((dt0 - dt_sched_in).total_seconds() / 60)))
            estatus_entrada = f"RETARDO (+{diff_min} min)"
            es_retardo = True
            min_retardo = diff_min

        rid0 = _row_get(rec0, "id")
        if rid0 is not None:
            punch_statuses[rid0] = estatus_entrada
        for _, rec_rest in parsed_recs[1:]:
            rid_r = _row_get(rec_rest, "id")
            if rid_r is not None:
                punch_statuses[rid_r] = "SALIDA / REGISTRO"

        entrada = dt0.strftime("%H:%M:%S")
        is_incompleto = (len(parsed_recs) == 1)
        worked_sec = 0.0
        extra_sec = 0.0
        if is_incompleto:
            salida = "Sin salida"
        else:
            dt_last = parsed_recs[-1][0]
            salida = dt_last.strftime("%H:%M:%S")
            worked_sec = max(0.0, (dt_last - dt0).total_seconds())
            eff_start = max(dt0, dt_sched_in)
            eff_worked = max(0.0, (dt_last - eff_start).total_seconds())
            sched_sec = max(0.0, (dt_sched_out - dt_sched_in).total_seconds())
            extra_sec = max(0.0, eff_worked - sched_sec)

        horas_dia = round(worked_sec / 3600.0, 1)
        tipos_incidencia = []
        if es_retardo:
            tipos_incidencia.append(estatus_entrada)
        if is_incompleto:
            tipos_incidencia.append("DÍA INCOMPLETO (Sin salida)")
        if es_manual_dia:
            tipos_incidencia.append("JUSTIFICADO / MANUAL")

        blk_det = [{
            "orden_bloque": 1,
            "horario_bloque": f"{blk['hora_entrada_str']}-{blk['hora_salida_str']}",
            "entrada": entrada,
            "salida": salida,
            "horas": horas_dia,
            "total_checadas": len(parsed_recs),
            "estatus": estatus_entrada,
            "es_retardo": es_retardo,
            "minutos_retardo": min_retardo,
            "es_incompleto": is_incompleto,
            "worked_sec": worked_sec,
            "eff_worked_sec": worked_sec
        }]

        return {
            "fecha": day_str,
            "entrada": entrada,
            "salida": salida,
            "horas": horas_dia,
            "worked_sec": worked_sec,
            "extra_sec": extra_sec,
            "total_checadas": len(parsed_recs),
            "es_descanso": False,
            "es_retardo": es_retardo,
            "minutos_retardo": min_retardo,
            "es_incompleto": is_incompleto,
            "es_manual": es_manual_dia,
            "estatus_entrada": estatus_entrada,
            "tipos_incidencia": tipos_incidencia,
            "nota_incidencia": nota_incidencia_dia,
            "tiene_incidencia": bool(tipos_incidencia or nota_incidencia_dia),
            "horario_dia": horario_dia,
            "bloques_detalle": blk_det,
            "punch_statuses": punch_statuses,
            "metodo": first_metodo,
            "reloj": first_reloj
        }

    # Caso 3: Múltiples bloques en el día (horario partido / mixto)
    k_blocks = len(day_blocks)
    sched_ins = [datetime.datetime.combine(day_date, b["hora_entrada"]) for b in day_blocks]
    sched_outs = [datetime.datetime.combine(day_date, b["hora_salida"]) for b in day_blocks]
    midpoints = [
        sched_outs[i] + (sched_ins[i + 1] - sched_outs[i]) / 2
        for i in range(k_blocks - 1)
    ]

    buckets: List[List[Tuple[datetime.datetime, Any]]] = [[] for _ in range(k_blocks)]
    for dt_val, rec in parsed_recs:
        placed = False
        for i, mp in enumerate(midpoints):
            if dt_val < mp:
                buckets[i].append((dt_val, rec))
                placed = True
                break
        if not placed:
            buckets[k_blocks - 1].append((dt_val, rec))

    # Rebalanceo de frontera para salidas tardías o entradas tempranas entre bloques
    changed = True
    while changed:
        changed = False
        for i in range(k_blocks - 1):
            if len(buckets[i]) == 1 and len(buckets[i + 1]) >= 3 and buckets[i + 1][0][0] < sched_ins[i + 1]:
                buckets[i].append(buckets[i + 1].pop(0))
                changed = True
            elif len(buckets[i]) >= 3 and len(buckets[i + 1]) == 1 and buckets[i][-1][0] > sched_outs[i]:
                buckets[i + 1].insert(0, buckets[i].pop())
                changed = True

    bloques_detalle: List[Dict[str, Any]] = []
    worked_sec_total = 0.0
    eff_worked_sec_total = 0.0
    sched_sec_total = sum(max(0.0, (sched_outs[i] - sched_ins[i]).total_seconds()) for i in range(k_blocks))

    for i, blk in enumerate(day_blocks):
        b_recs = buckets[i]
        blk_label = f"{blk['hora_entrada_str']}-{blk['hora_salida_str']}"
        if not b_recs:
            bloques_detalle.append({
                "orden_bloque": i + 1,
                "horario_bloque": blk_label,
                "entrada": None,
                "salida": None,
                "horas": 0.0,
                "total_checadas": 0,
                "estatus": "SIN REGISTRO",
                "es_retardo": False,
                "minutos_retardo": 0,
                "es_incompleto": False,
                "worked_sec": 0.0,
                "eff_worked_sec": 0.0
            })
            continue

        dt_s_in = sched_ins[i]
        tol = int(blk["tolerancia_min"]) if blk.get("tolerancia_min") is not None else int(default_tolerance)
        dt_limit = dt_s_in + datetime.timedelta(minutes=tol)

        dt_in, rec_in = b_recs[0]
        is_man_in = bool(_row_get(rec_in, "es_manual"))
        blk_retardo = False
        blk_late_min = 0
        if dt_in <= dt_limit:
            blk_status = "PUNTUAL"
        elif is_man_in:
            blk_status = "JUSTIFICADO (MANUAL)"
        else:
            blk_late_min = max(1, int(round((dt_in - dt_s_in).total_seconds() / 60)))
            blk_status = f"RETARDO (+{blk_late_min} min)"
            blk_retardo = True

        rid_in = _row_get(rec_in, "id")
        if rid_in is not None:
            punch_statuses[rid_in] = blk_status
        for _, rec_rest in b_recs[1:]:
            rid_r = _row_get(rec_rest, "id")
            if rid_r is not None:
                punch_statuses[rid_r] = "SALIDA / REGISTRO"

        blk_incompleto = (len(b_recs) == 1)
        blk_worked = 0.0
        blk_eff = 0.0
        if blk_incompleto:
            blk_sal_str = "Sin salida"
        else:
            dt_out = b_recs[-1][0]
            blk_sal_str = dt_out.strftime("%H:%M:%S")
            blk_worked = max(0.0, (dt_out - dt_in).total_seconds())
            eff_start = max(dt_in, dt_s_in)
            blk_eff = max(0.0, (dt_out - eff_start).total_seconds())

        worked_sec_total += blk_worked
        eff_worked_sec_total += blk_eff
        bloques_detalle.append({
            "orden_bloque": i + 1,
            "horario_bloque": blk_label,
            "entrada": dt_in.strftime("%H:%M:%S"),
            "salida": blk_sal_str,
            "horas": round(blk_worked / 3600.0, 1),
            "total_checadas": len(b_recs),
            "estatus": blk_status,
            "es_retardo": blk_retardo,
            "minutos_retardo": blk_late_min,
            "es_incompleto": blk_incompleto,
            "worked_sec": blk_worked,
            "eff_worked_sec": blk_eff
        })

    late_blocks = [b for b in bloques_detalle if b["es_retardo"]]
    es_retardo = len(late_blocks) > 0
    minutos_retardo = sum(b["minutos_retardo"] for b in late_blocks)
    open_blocks = [b for b in bloques_detalle if b["es_incompleto"]]
    es_incompleto = len(open_blocks) > 0

    attended_blocks = [b for b in bloques_detalle if b["total_checadas"] > 0]
    entrada = attended_blocks[0]["entrada"] if attended_blocks else "—"
    if attended_blocks:
        salida = "Sin salida" if attended_blocks[-1]["es_incompleto"] else attended_blocks[-1]["salida"]
    else:
        salida = "—"

    if es_retardo:
        if len(late_blocks) == 1:
            estatus_entrada = f"RETARDO (+{minutos_retardo} min)"
        else:
            estatus_entrada = f"RETARDO (+{minutos_retardo} min · {len(late_blocks)} bloques)"
    elif any(b["estatus"] == "JUSTIFICADO (MANUAL)" for b in attended_blocks):
        estatus_entrada = "JUSTIFICADO (MANUAL)"
    else:
        estatus_entrada = "PUNTUAL"

    tipos_incidencia: List[str] = []
    if es_retardo:
        tipos_incidencia.append(estatus_entrada)
    if es_incompleto:
        open_labels = ", ".join(f"B{b['orden_bloque']}" for b in open_blocks)
        tipos_incidencia.append(f"DÍA INCOMPLETO (Sin salida {open_labels})")
    if es_manual_dia:
        tipos_incidencia.append("JUSTIFICADO / MANUAL")

    extra_sec = max(0.0, eff_worked_sec_total - sched_sec_total)
    return {
        "fecha": day_str,
        "entrada": entrada or "—",
        "salida": salida or "—",
        "horas": round(worked_sec_total / 3600.0, 1),
        "worked_sec": worked_sec_total,
        "extra_sec": extra_sec,
        "total_checadas": len(parsed_recs),
        "es_descanso": False,
        "es_retardo": es_retardo,
        "minutos_retardo": minutos_retardo,
        "es_incompleto": es_incompleto,
        "es_manual": es_manual_dia,
        "estatus_entrada": estatus_entrada,
        "tipos_incidencia": tipos_incidencia,
        "nota_incidencia": nota_incidencia_dia,
        "tiene_incidencia": bool(tipos_incidencia or nota_incidencia_dia),
        "horario_dia": horario_dia,
        "bloques_detalle": bloques_detalle,
        "punch_statuses": punch_statuses,
        "metodo": first_metodo,
        "reloj": first_reloj
    }


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
    rows = conn.execute(
        f"SELECT nombre, horario, tolerancia_min, dias_laborales, prefijo_id, horario_id FROM areas {where_sql}",
        tuple(params)
    ).fetchall()
    resolver = build_schedule_resolver(conn, int(empresa_id or 1), sucursal_id) if empresa_id else None
    conn.close()
    res = {}
    for r in rows:
        t_ent, t_sal = parse_horario(r["horario"])
        raw_dl = (r["dias_laborales"] if "dias_laborales" in r.keys() and r["dias_laborales"] else "1,2,3,4,5")
        dias_set = {int(x.strip()) for x in str(raw_dl).split(",") if x.strip().isdigit()} or {1, 2, 3, 4, 5}
        pref_str = (r["prefijo_id"] if "prefijo_id" in r.keys() and r["prefijo_id"] else "")
        sched = resolve_employee_schedule(resolver, area_name=r["nombre"]) if resolver else None
        if sched and sched.get("bloques_por_dia"):
            first_day = sorted(sched["bloques_por_dia"].keys())[0]
            first_blk = sched["bloques_por_dia"][first_day][0]
            last_blk = sched["bloques_por_dia"][first_day][-1]
            t_ent = first_blk["hora_entrada"]
            t_sal = last_blk["hora_salida"]
            dias_set = sched["dias_laborales"] or dias_set
        res[r["nombre"]] = {
            "hora_entrada": t_ent,
            "hora_salida": t_sal,
            "tolerancia_min": (
                sched["tolerancia_min"]
                if (sched and sched.get("tolerancia_min") is not None)
                else (r["tolerancia_min"] if r["tolerancia_min"] is not None else 10)
            ),
            "dias_laborales": dias_set,
            "dias_laborales_str": str(raw_dl),
            "prefijo_id": str(pref_str).strip(),
            "horario_id": _row_get(r, "horario_id")
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
    row = conn.execute(
        "SELECT area_nombre FROM empleados WHERE codigo_empleado = ? AND empresa_id = ? ORDER BY id ASC LIMIT 1",
        (str(emp_no), empresa_id)
    ).fetchone()
    conn.close()
    return row["area_nombre"] if row else "General"


def get_employee_name(emp_no: str, fallback: str = "Desconocido", empresa_id: int = 1, sucursal_id: Optional[int] = None) -> str:
    conn = get_conn()
    row = conn.execute(
        "SELECT nombre FROM empleados WHERE codigo_empleado = ? AND empresa_id = ? ORDER BY id ASC LIMIT 1",
        (str(emp_no), empresa_id)
    ).fetchone()
    conn.close()
    if row and row["nombre"]:
        return row["nombre"]
    return fallback


def _is_scoped_setting_key(k: str) -> bool:
    if ":" not in k or not k.startswith("u"):
        return False
    prefix = k.split(":", 1)[0][1:]
    return prefix.isdigit()


def get_setting(key: str, default: Any = None, user_id: Optional[int] = None) -> Any:
    conn = get_conn()
    row = None
    if user_id is not None:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (f"u{user_id}:{key}",)).fetchone()
    if row is None:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row is not None:
        return row["value"]
    return default


def get_all_settings(user_id: Optional[int] = None) -> Dict[str, Any]:
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    res: Dict[str, Any] = {}
    for r in rows:
        k = r["key"]
        if not _is_scoped_setting_key(k):
            res[k] = r["value"]
    if user_id is not None:
        prefix = f"u{user_id}:"
        for r in rows:
            k = r["key"]
            if k.startswith(prefix):
                clean_k = k[len(prefix):]
                if clean_k != "smtp_config":
                    res[clean_k] = r["value"]
    res.setdefault("debounce_seconds", "180")
    res.setdefault("tolerancia_minutos", "10")
    res.setdefault("notify_unnamed_employees", "1")
    return res


def set_setting(key: str, value: Any, user_id: Optional[int] = None):
    db_key = f"u{user_id}:{key}" if user_id is not None else str(key)
    conn = get_conn()
    if conn.is_pg:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (db_key, str(value))
        )
    else:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (db_key, str(value)))
    conn.commit()
    conn.close()


def update_settings(data: Dict[str, Any], user_id: Optional[int] = None):
    for k, v in data.items():
        set_setting(str(k), str(v), user_id=user_id)


# ==========================================
# INGESTA ONE-WAY PUSH (RELOJ ➔ SERVIDOR) Y AUTO-DESCUBRIMIENTO
# ==========================================

def get_clock_by_webhook_token(webhook_token: Optional[str] = None, serial_or_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Identifica el reloj checador (y su empresa_id + sucursal_id) a partir del webhook_token
    en la URL Push (/api/v1/webhooks/hikvision/{webhook_token}) o por número de serie/nombre.
    Nunca asigna un evento a otro cliente si el token no coincide.
    """
    conn = get_conn()
    row = None
    if webhook_token:
        row = conn.execute("SELECT * FROM relojes WHERE webhook_token = ?", (webhook_token.strip(),)).fetchone()
    if not row and not webhook_token and serial_or_name:
        row = conn.execute(
            "SELECT * FROM relojes WHERE serie = ? OR LOWER(nombre) = LOWER(?)",
            (serial_or_name.strip(), serial_or_name.strip())
        ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_clock_by_serial(serial: str) -> Optional[Dict[str, Any]]:
    """Busca un reloj ZKTeco ADMS por su número de serie (SN)."""
    clean_sn = (serial or "").strip()
    if not clean_sn:
        return None
    conn = get_conn()
    row = conn.execute("""
        SELECT * FROM relojes
        WHERE LOWER(TRIM(serie)) = LOWER(TRIM(?))
          AND UPPER(COALESCE(marca, 'HIKVISION')) = 'ZKTECO'
        LIMIT 1
    """, (clean_sn,)).fetchone()
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


def resolve_employee_area_by_rules(
    cur: DualCursor,
    empresa_id: int,
    sucursal_id: int,
    emp_no: str,
    reloj_id: Optional[int] = None,
    reloj_nombre: Optional[str] = None
) -> str:
    """
    Resuelve dinámicamente el área de un empleado para su (empresa_id, sucursal_id) siguiendo la cascada:
      1. Por Prefijo Configurable (prefijo_id separado por comas en áreas activas de esa sucursal).
      2. Por Reloj (reloj.area_asignada si existe como área activa en esa misma sucursal).
      3. Fallback de Sucursal (primera área activa de esa misma sucursal).
    Jamás asigna áreas de otra sucursal.
    """
    if not empresa_id or not sucursal_id:
        return "General"

    active_areas = cur.execute("""
        SELECT id, nombre, prefijo_id
        FROM areas
        WHERE empresa_id = ? AND sucursal_id = ? AND COALESCE(activo, 1) = 1
        ORDER BY id ASC
    """, (empresa_id, sucursal_id)).fetchall()
    if not active_areas:
        return "General"

    # 1. Por Prefijo Configurable (prioridad al prefijo más largo y luego al orden de creación)
    clean_emp_no = str(emp_no or "").strip()
    candidates = []
    for a in active_areas:
        raw_pref = (a["prefijo_id"] if "prefijo_id" in a.keys() else "") or ""
        for p in str(raw_pref).split(","):
            pref = p.strip()
            if pref:
                candidates.append((pref, a["nombre"], int(a["id"] or 0)))
    candidates.sort(key=lambda x: (-len(x[0]), x[2]))
    for pref, area_nombre, _ in candidates:
        if clean_emp_no.startswith(pref):
            return area_nombre

    # 2. Por Reloj (area_asignada existente como área activa en la misma sucursal)
    active_by_lower = {
        str(a["nombre"]).strip().lower(): a["nombre"]
        for a in active_areas
        if a["nombre"] and str(a["nombre"]).strip()
    }
    clock_row = None
    if reloj_id:
        clock_row = cur.execute(
            "SELECT area_asignada FROM relojes WHERE id = ? AND empresa_id = ? AND sucursal_id = ? LIMIT 1",
            (reloj_id, empresa_id, sucursal_id)
        ).fetchone()
    if not clock_row and reloj_nombre:
        clock_row = cur.execute(
            "SELECT area_asignada FROM relojes WHERE empresa_id = ? AND sucursal_id = ? AND LOWER(TRIM(nombre)) = LOWER(TRIM(?)) LIMIT 1",
            (empresa_id, sucursal_id, str(reloj_nombre))
        ).fetchone()
    if clock_row and clock_row["area_asignada"]:
        cand_area = str(clock_row["area_asignada"]).strip().lower()
        if cand_area in active_by_lower:
            return active_by_lower[cand_area]

    # 3. Fallback de Sucursal: primera área activa de esa misma sucursal
    return active_areas[0]["nombre"]


def reapply_area_rules_for_branch(empresa_id: int, sucursal_id: Optional[int]) -> Dict[str, Any]:
    """
    Recorre todos los empleados actuales de la sucursal activa y reasigna su area_nombre
    y checadas.area según la cascada configurable de la sucursal.
    """
    if not sucursal_id:
        return {
            "ok": False,
            "error": "No hay una sucursal activa.",
            "total_employees": 0,
            "updated_employees": 0,
            "updated_checkins": 0
        }

    conn = get_conn()
    try:
        cur = conn.cursor()
        emps = cur.execute("""
            SELECT id, codigo_empleado, area_nombre, reloj_asignado
            FROM empleados
            WHERE empresa_id = ? AND sucursal_id = ?
            ORDER BY id ASC
        """, (empresa_id, sucursal_id)).fetchall()

        updated_employees = 0
        updated_checkins = 0

        for emp in emps:
            emp_code = str(emp["codigo_empleado"])
            new_area = resolve_employee_area_by_rules(
                cur,
                empresa_id=empresa_id,
                sucursal_id=sucursal_id,
                emp_no=emp_code,
                reloj_nombre=emp["reloj_asignado"]
            )
            if (emp["area_nombre"] or "") != new_area:
                cur.execute("UPDATE empleados SET area_nombre = ? WHERE id = ?", (new_area, emp["id"]))
                updated_employees += 1

            diff_row = cur.execute("""
                SELECT COUNT(*) as c FROM checadas
                WHERE empresa_id = ? AND codigo_empleado = ? AND COALESCE(area, '') != ?
            """, (empresa_id, emp_code, new_area)).fetchone()
            diff_cnt = int(diff_row["c"]) if diff_row else 0
            if diff_cnt > 0:
                cur.execute("""
                    UPDATE checadas SET area = ?
                    WHERE empresa_id = ? AND codigo_empleado = ?
                """, (new_area, empresa_id, emp_code))
                updated_checkins += diff_cnt

        conn.commit()
        return {
            "ok": True,
            "total_employees": len(emps),
            "updated_employees": updated_employees,
            "updated_checkins": updated_checkins
        }
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()


def import_employees_from_csv_rows(empresa_id: int, sucursal_id: Optional[int], rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Actualiza o crea empleados únicos por empresa (empresa_id, codigo_empleado) desde filas CSV
    y propaga en la misma transacción nombre y area_nombre hacia la tabla checadas en toda la empresa.
    """
    conn = get_conn()
    try:
        cur = conn.cursor()
        branch_rows = cur.execute(
            "SELECT id, nombre, codigo FROM sucursales WHERE empresa_id = ? AND activo = 1 ORDER BY id ASC",
            (empresa_id,)
        ).fetchall()
        if not sucursal_id and not branch_rows:
            return {
                "ok": False,
                "error": "No hay una sucursal activa.",
                "created_employees": 0,
                "updated_employees": 0,
                "unchanged_employees": 0,
                "total_processed": 0,
                "updated_checkins": 0
            }

        fallback_suc_id = int(sucursal_id) if sucursal_id else int(branch_rows[0]["id"])
        branches_by_lower: Dict[str, int] = {}
        for br in branch_rows:
            if br["nombre"]:
                branches_by_lower[str(br["nombre"]).strip().lower()] = int(br["id"])
            if br["codigo"]:
                branches_by_lower[str(br["codigo"]).strip().lower()] = int(br["id"])

        tpl_rows = cur.execute(
            "SELECT id, sucursal_id, nombre FROM horarios WHERE empresa_id = ? AND COALESCE(activo, 1) = 1 AND COALESCE(es_plantilla, 1) = 1 ORDER BY id ASC",
            (empresa_id,)
        ).fetchall()
        templates_by_branch_lower: Dict[Tuple[int, str], int] = {}
        templates_by_lower: Dict[str, int] = {}
        for t in tpl_rows:
            if not t["nombre"]:
                continue
            t_low = str(t["nombre"]).strip().lower()
            t_suc = int(t["sucursal_id"] or 0)
            templates_by_branch_lower[(t_suc, t_low)] = int(t["id"])
            if t_suc == fallback_suc_id or t_low not in templates_by_lower:
                templates_by_lower[t_low] = int(t["id"])

        created_employees = 0
        updated_employees = 0
        unchanged_employees = 0
        updated_checkins = 0

        for row in rows:
            raw_code = str(row.get("codigo_empleado") or "").strip()
            emp_code = raw_code.lstrip("#").strip()
            if not emp_code:
                continue

            nombre_in = str(row.get("nombre") or "").strip()
            has_contpaqi_col = "codigo_contpaqi" in row and row.get("codigo_contpaqi") is not None
            contpaqi_in = str(row.get("codigo_contpaqi") or "").strip()[:7]
            area_in = str(row.get("area_nombre") or row.get("area") or "").strip()
            puesto_in = str(row.get("puesto") or "").strip()
            turno_in = str(row.get("turno") or "").strip()
            has_horario_col = ("horario_nombre" in row) or ("horario" in row)
            raw_horario_in = row.get("horario_nombre") if "horario_nombre" in row else row.get("horario")
            horario_in = str(raw_horario_in or "").strip()
            raw_suc_in = str(row.get("sucursal_base") or row.get("sucursal") or "").strip()
            parsed_suc_id = branches_by_lower.get(raw_suc_in.lower()) if raw_suc_in else None

            existing = cur.execute("""
                SELECT id, sucursal_id, nombre, codigo_contpaqi, area_nombre, puesto, turno, horario_id, reloj_asignado
                FROM empleados
                WHERE empresa_id = ? AND codigo_empleado = ?
                LIMIT 1
            """, (empresa_id, emp_code)).fetchone()

            if existing:
                old_suc_id = int(existing["sucursal_id"] or fallback_suc_id)
                final_suc_id = parsed_suc_id if parsed_suc_id else old_suc_id
                old_name = (existing["nombre"] or "").strip()
                old_contpaqi = (existing["codigo_contpaqi"] or "").strip() if "codigo_contpaqi" in existing.keys() else ""
                old_area = (existing["area_nombre"] or "").strip()
                old_puesto = (existing["puesto"] or "").strip()
                old_turno = (existing["turno"] or "").strip()
                old_horario_id = existing["horario_id"] if "horario_id" in existing.keys() else None

                final_name = nombre_in if nombre_in else (old_name or f"Empleado #{emp_code}")
                final_contpaqi = contpaqi_in if has_contpaqi_col else old_contpaqi
                final_area = area_in if area_in else (
                    old_area or resolve_employee_area_by_rules(
                        cur, empresa_id, final_suc_id, emp_code, reloj_nombre=existing["reloj_asignado"]
                    )
                )
                final_puesto = puesto_in if puesto_in else (old_puesto or "Colaborador")
                final_turno = turno_in if turno_in else (old_turno or "Matutino (08:00 - 17:00)")

                final_horario_id = old_horario_id
                if has_horario_col and horario_in:
                    h_low = horario_in.lower()
                    if horario_in.upper() in ("HEREDAR", "AREA", "ÁREA", "NINGUNO"):
                        final_horario_id = None
                    elif (final_suc_id, h_low) in templates_by_branch_lower:
                        final_horario_id = templates_by_branch_lower[(final_suc_id, h_low)]
                    elif h_low in templates_by_lower:
                        final_horario_id = templates_by_lower[h_low]

                changed = (
                    final_suc_id != old_suc_id
                    or final_name != old_name
                    or final_contpaqi != old_contpaqi
                    or final_area != old_area
                    or final_puesto != old_puesto
                    or final_turno != old_turno
                    or final_horario_id != old_horario_id
                )
                if changed:
                    cur.execute("""
                        UPDATE empleados
                        SET sucursal_id = ?, nombre = ?, codigo_contpaqi = ?, area_nombre = ?, puesto = ?, turno = ?, horario_id = ?
                        WHERE id = ?
                    """, (final_suc_id, final_name, final_contpaqi, final_area, final_puesto, final_turno, final_horario_id, existing["id"]))
                    if old_horario_id and old_horario_id != final_horario_id:
                        cleanup_orphan_custom_schedule(cur, old_horario_id, empresa_id)
                    updated_employees += 1
                else:
                    unchanged_employees += 1
            else:
                final_suc_id = parsed_suc_id if parsed_suc_id else fallback_suc_id
                final_name = nombre_in if nombre_in else f"Empleado #{emp_code}"
                final_contpaqi = contpaqi_in
                final_area = area_in if area_in else resolve_employee_area_by_rules(cur, empresa_id, final_suc_id, emp_code)
                final_puesto = puesto_in if puesto_in else "Colaborador"
                final_turno = turno_in if turno_in else "Matutino (08:00 - 17:00)"
                h_low = horario_in.lower()
                final_horario_id = (
                    templates_by_branch_lower.get((final_suc_id, h_low)) or templates_by_lower.get(h_low)
                    if (has_horario_col and horario_in)
                    else None
                )

                cur.execute("""
                    INSERT INTO empleados (
                        empresa_id, sucursal_id, codigo_empleado, codigo_contpaqi, nombre, area_nombre,
                        puesto, turno, horario_id, pin, tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, 0, 'Sucursal Activa', 'ACTIVO')
                """, (empresa_id, final_suc_id, emp_code, final_contpaqi, final_name, final_area, final_puesto, final_turno, final_horario_id))
                created_employees += 1

            chk_diff_row = cur.execute("""
                SELECT COUNT(*) as c FROM checadas
                WHERE empresa_id = ? AND codigo_empleado = ?
                  AND (COALESCE(nombre, '') != ? OR COALESCE(area, '') != ?)
            """, (empresa_id, emp_code, final_name, final_area)).fetchone()
            chk_diff = int(chk_diff_row["c"]) if chk_diff_row else 0
            if chk_diff > 0:
                cur.execute("""
                    UPDATE checadas
                    SET nombre = ?, area = ?
                    WHERE empresa_id = ? AND codigo_empleado = ?
                """, (final_name, final_area, empresa_id, emp_code))
                updated_checkins += chk_diff

        conn.commit()
        return {
            "ok": True,
            "created_employees": created_employees,
            "updated_employees": updated_employees,
            "unchanged_employees": unchanged_employees,
            "total_processed": created_employees + updated_employees + unchanged_employees,
            "updated_checkins": updated_checkins
        }
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()


def record_checkin(
    serial_no: Optional[int],
    emp_no: str,
    nombre: str,
    tipo_evento: str,
    sub_event_type: int,
    fecha_hora: str,
    reloj_nombre: str = "Terminal Principal",
    debounce_seconds: Optional[int] = None,
    empresa_id: int = 1,
    sucursal_id: int = 1,
    reloj_id: int = 1,
    conn: Optional[DualConnection] = None,
    auto_commit: bool = True,
    update_clock_stats: bool = True
) -> Dict[str, Any]:
    """
    Registra una checada recibida vía Push One-Way desde el reloj físico.
    - Los empleados son únicos por empresa (empresa_id, codigo_empleado) con `sucursal_id` como Sucursal Base.
    - Si el empleado ya existe en la empresa y checa en otro reloj/sucursal, no se duplica su ficha;
      la checada guarda la sucursal y reloj físico reales donde checó y se actualizan sus biometrías.
    - Si aún no existe en la empresa, se auto-registra asignando la sucursal del reloj como Sucursal Base.
    - Aplica el filtro anti-rebote (debounce) a nivel empresa por colaborador.
    """
    owns_conn = conn is None
    if owns_conn:
        conn = get_conn()
    try:
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
            return {"inserted": False, "id": existing["id"], "es_rebote": bool(existing["es_rebote"])}

        # Auto-descubrimiento a nivel EMPRESA (único por empresa_id + codigo_empleado)
        emp_row = cur.execute("""
            SELECT id, sucursal_id, nombre, area_nombre, tiene_huella, tiene_rostro, tiene_tarjeta
            FROM empleados
            WHERE empresa_id = ? AND codigo_empleado = ?
            ORDER BY id ASC
            LIMIT 1
        """, (empresa_id, str(emp_no))).fetchone()

        is_face = 1 if sub_event_type in (75, 104) else 0
        is_fp = 1 if sub_event_type == 38 else 0
        is_card = 1 if sub_event_type == 1 else 0

        if not emp_row:
            default_area = resolve_employee_area_by_rules(
                cur,
                empresa_id=empresa_id,
                sucursal_id=sucursal_id,
                emp_no=str(emp_no),
                reloj_id=reloj_id,
                reloj_nombre=reloj_nombre
            )
            clean_name = f"Empleado #{emp_no}" if is_default_employee_name(nombre, emp_no) else nombre.strip()
            cur.execute("""
                INSERT INTO empleados (
                    empresa_id, sucursal_id, codigo_empleado, nombre, area_nombre, puesto, turno,
                    pin, tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
                ) VALUES (?, ?, ?, ?, ?, 'Colaborador', 'Matutino (08:00 - 17:00)', '', ?, ?, ?, 0, ?, 'ACTIVO')
            """, (empresa_id, sucursal_id, str(emp_no), clean_name, default_area, is_fp, is_face, is_card, reloj_nombre))
            real_name = clean_name
            area_name = default_area
            # Actualizar conteo de usuarios base en la sucursal del reloj
            cur.execute(
                "UPDATE relojes SET total_usuarios = (SELECT COUNT(*) FROM empleados WHERE empresa_id = ? AND sucursal_id = ?) WHERE id = ?",
                (empresa_id, sucursal_id, reloj_id)
            )
        else:
            db_name = (emp_row["nombre"] or "").strip()
            incoming_name = (nombre or "").strip()
            if is_default_employee_name(db_name, emp_no) and not is_default_employee_name(incoming_name, emp_no):
                cur.execute("UPDATE empleados SET nombre = ? WHERE id = ?", (incoming_name, emp_row["id"]))
                cur.execute("""
                    UPDATE checadas SET nombre = ?
                    WHERE empresa_id = ? AND codigo_empleado = ?
                """, (incoming_name, empresa_id, str(emp_no)))
                real_name = incoming_name
            else:
                real_name = db_name or f"Empleado #{emp_no}"
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

        # Calcular anti-rebote comparando contra la última checada válida del empleado en toda la empresa
        es_rebote = 0
        diff_sec = None
        try:
            dt_curr = datetime.datetime.fromisoformat(fecha_hora.replace("Z", "+00:00"))
            prev_rows = cur.execute("""
                SELECT fecha_hora_evento FROM checadas
                WHERE empresa_id = ? AND codigo_empleado = ? AND es_rebote = 0
                ORDER BY fecha_hora_evento DESC LIMIT 5
            """, (empresa_id, str(emp_no))).fetchall()
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

        if update_clock_stats:
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            cur.execute("""
                UPDATE relojes
                SET estado = 'ONLINE', ultima_sincronizacion = ?, total_eventos = COALESCE(total_eventos, 0) + 1
                WHERE id = ?
            """, (now_str, reloj_id))

        if auto_commit:
            conn.commit()

        return {
            "inserted": True,
            "id": new_id,
            "empresa_id": empresa_id,
            "sucursal_id": sucursal_id,
            "reloj_id": reloj_id,
            "serial_no": serial_no,
            "codigo_empleado": str(emp_no),
            "nombre": real_name,
            "sin_nombre": is_default_employee_name(real_name, emp_no),
            "area": area_name,
            "metodo": metodo_short,
            "sub_event_type": sub_event_type,
            "fecha_hora_evento": fecha_hora,
            "es_rebote": bool(es_rebote),
            "diff_sec": diff_sec,
            "es_manual": False,
            "nota_incidencia": ""
        }
    finally:
        if owns_conn:
            conn.close()


def record_checkins_batch(events: List[Dict[str, Any]], clock: Dict[str, Any]) -> Dict[str, Any]:
    """
    Procesa un lote de checadas (ej. ZKTeco ADMS /iclock/cdata?table=ATTLOG) reutilizando
    una única conexión y transacción para acelerar cargas masivas.
    """
    conn = get_conn()
    try:
        cur = conn.cursor()
        sucursal_id = int(clock.get("sucursal_id") or 1)
        empresa_id = int(clock.get("empresa_id") or 1)
        reloj_id = int(clock.get("id") or 1)
        reloj_nombre = clock.get("nombre") or "Terminal"

        suc_row = cur.execute("SELECT debounce_seconds FROM sucursales WHERE id = ?", (sucursal_id,)).fetchone()
        if suc_row and suc_row["debounce_seconds"]:
            debounce_seconds = int(suc_row["debounce_seconds"])
        else:
            try:
                debounce_seconds = int(get_setting("debounce_seconds", 180))
            except (ValueError, TypeError):
                debounce_seconds = 180

        processed = 0
        inserted = 0
        for ev in events:
            res = record_checkin(
                serial_no=ev.get("serial_no"),
                emp_no=str(ev["emp_no"]),
                nombre=ev.get("nombre") or f"Empleado #{ev['emp_no']}",
                tipo_evento=ev.get("tipo_evento") or "ZKTecoADMS",
                sub_event_type=int(ev.get("sub_event_type") or 38),
                fecha_hora=str(ev["fecha_hora"]),
                reloj_nombre=reloj_nombre,
                debounce_seconds=debounce_seconds,
                empresa_id=empresa_id,
                sucursal_id=sucursal_id,
                reloj_id=reloj_id,
                conn=conn,
                auto_commit=False,
                update_clock_stats=False
            )
            processed += 1
            if res.get("inserted"):
                inserted += 1

        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur.execute("""
            UPDATE relojes
            SET estado = 'ONLINE', ultima_sincronizacion = ?, total_eventos = COALESCE(total_eventos, 0) + ?
            WHERE id = ?
        """, (now_str, inserted, reloj_id))

        conn.commit()
        return {"processed": processed, "inserted": inserted}
    except Exception:
        conn._conn.rollback()
        raise
    finally:
        conn.close()


def _evaluate_punch_statuses_for_rows(
    conn: DualConnection,
    rows: List[Any],
    empresa_id: int,
    sucursal_id: Optional[int],
    default_tol: int
) -> Dict[int, str]:
    """Evalúa con el motor multi-bloque todas las checadas válidas del conjunto de filas."""
    keys_needed = set()
    area_hints: Dict[Tuple[str, str], str] = {}
    for r in rows:
        if r["es_rebote"]:
            continue
        raw_dt = r["fecha_hora_evento"] or ""
        dia = raw_dt[:10]
        if not dia:
            continue
        emp_code = str(r["codigo_empleado"])
        k = (emp_code, dia)
        keys_needed.add(k)
        if r["area"] and k not in area_hints:
            area_hints[k] = r["area"]

    if not keys_needed:
        return {}

    dates = sorted(d for _, d in keys_needed)
    min_day, max_day = dates[0], dates[-1]
    resolver = build_schedule_resolver(conn, empresa_id, sucursal_id, default_tol=default_tol)

    c_conds = [
        "empresa_id = ?",
        "es_rebote = 0",
        "substr(fecha_hora_evento, 1, 10) >= ?",
        "substr(fecha_hora_evento, 1, 10) <= ?"
    ]
    c_params: List[Any] = [empresa_id, min_day, max_day]

    valid_rows = conn.execute(f"""
        SELECT id, codigo_empleado, area, reloj_nombre, metodo, fecha_hora_evento, es_manual, nota_incidencia
        FROM checadas
        WHERE {' AND '.join(c_conds)}
        ORDER BY fecha_hora_evento ASC, id ASC
    """, tuple(c_params)).fetchall()

    grouped: Dict[Tuple[str, str], List[Any]] = {}
    for vr in valid_rows:
        v_dia = (vr["fecha_hora_evento"] or "")[:10]
        k = (str(vr["codigo_empleado"]), v_dia)
        if k in keys_needed:
            grouped.setdefault(k, []).append(vr)

    punch_statuses: Dict[int, str] = {}
    for emp_code, dia_str in keys_needed:
        try:
            day_date = datetime.date.fromisoformat(dia_str)
        except Exception:
            continue
        day_recs = grouped.get((emp_code, dia_str), [])
        sched = resolve_employee_schedule(
            resolver,
            emp_code=emp_code,
            area_name=area_hints.get((emp_code, dia_str))
        )
        day_blocks = sched["bloques_por_dia"].get(day_date.isoweekday(), [])
        day_eval = evaluate_day_blocks(
            day_date,
            day_recs,
            day_blocks,
            default_tolerance=sched["tolerancia_min"]
        )
        punch_statuses.update(day_eval["punch_statuses"])
    return punch_statuses


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

    cur.execute("""
        INSERT INTO checadas (
            empresa_id, sucursal_id, reloj_id, serial_no, codigo_empleado, nombre, tipo_evento,
            sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento, es_rebote,
            es_manual, nota_incidencia
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 0, 'MANUAL', ?, ?, ?, 0, 1, ?)
    """, (empresa_id, sucursal_id, str(emp_no), real_name, tipo_evento, area_name, reloj_nombre, clean_dt, nota_incidencia))

    new_id = cur.lastrowid
    conn.commit()

    default_tol = int(get_setting("tolerancia_minutos", 10))
    status_label = "JUSTIFICADO (MANUAL)"
    try:
        day_date = datetime.date.fromisoformat(dia)
        day_recs = conn.execute("""
            SELECT id, codigo_empleado, area, reloj_nombre, metodo, fecha_hora_evento, es_manual, nota_incidencia
            FROM checadas
            WHERE empresa_id = ? AND codigo_empleado = ?
              AND substr(fecha_hora_evento, 1, 10) = ? AND es_rebote = 0
            ORDER BY fecha_hora_evento ASC, id ASC
        """, (empresa_id, str(emp_no), dia)).fetchall()
        resolver = build_schedule_resolver(conn, empresa_id, sucursal_id, default_tol=default_tol)
        sched = resolve_employee_schedule(resolver, emp_code=str(emp_no), area_name=area_name)
        day_blocks = sched["bloques_por_dia"].get(day_date.isoweekday(), [])
        day_eval = evaluate_day_blocks(
            day_date,
            day_recs,
            day_blocks,
            default_tolerance=sched["tolerancia_min"]
        )
        status_label = day_eval["punch_statuses"].get(new_id, status_label)
    except Exception:
        pass
    finally:
        conn.close()

    return {
        "id": new_id,
        "serial_no": None,
        "codigo_empleado": str(emp_no),
        "nombre": real_name,
        "sin_nombre": is_default_employee_name(real_name, emp_no),
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

    branch_rows = conn.execute("SELECT id, nombre FROM sucursales WHERE empresa_id = ?", (empresa_id,)).fetchall()
    branches_map = {int(b["id"]): b["nombre"] for b in branch_rows}

    rows = conn.execute(f"""
        SELECT id, empresa_id, sucursal_id, reloj_id, serial_no, codigo_empleado, nombre, tipo_evento,
               sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento,
               es_rebote, es_manual, nota_incidencia, created_at
        FROM checadas
        WHERE {where_sql}
        ORDER BY fecha_hora_evento DESC, id DESC
        LIMIT ?
    """, tuple(params + [limit])).fetchall()

    default_tol = int(get_setting("tolerancia_minutos", 10))
    punch_statuses = _evaluate_punch_statuses_for_rows(conn, rows, empresa_id, sucursal_id, default_tol)
    conn.close()

    result = []
    for r in rows:
        sub_code = r["sub_event_type"]
        metodo_short, metodo_desc = SUB_EVENT_LABELS.get(sub_code, (r["metodo"] or "BIOMETRÍA", f"Evento #{sub_code}"))
        raw_dt = r["fecha_hora_evento"] or ""
        display_dt = raw_dt.replace("T", " ")[:19]
        emp_code = str(r["codigo_empleado"])
        area_res = r["area"] or get_employee_area(emp_code, empresa_id, sucursal_id)
        is_rebote = bool(r["es_rebote"])
        is_manual = bool(r["es_manual"])

        if is_rebote:
            status_label = "REBOTE IGNORADO (<180s)"
        else:
            status_label = punch_statuses.get(r["id"], "JUSTIFICADO (MANUAL)" if is_manual else "PUNTUAL")

        result.append({
            "id": r["id"],
            "empresa_id": r["empresa_id"],
            "sucursal_id": r["sucursal_id"],
            "sucursal_nombre": branches_map.get(int(r["sucursal_id"] or 0), ""),
            "serial_no": r["serial_no"],
            "codigo_empleado": emp_code,
            "nombre": r["nombre"],
            "sin_nombre": is_default_employee_name(r["nombre"], emp_code),
            "area": area_res,
            "reloj_nombre": r["reloj_nombre"] or "Terminal Principal",
            "tipo_evento": r["tipo_evento"],
            "sub_event_type": sub_code,
            "metodo": r["metodo"] if r["metodo"] == "MANUAL" else metodo_short,
            "metodo_desc": "Incidencia Manual / Justificación" if r["metodo"] == "MANUAL" else metodo_desc,
            "fecha_hora_evento": raw_dt,
            "fecha_hora_display": display_dt,
            "es_rebote": is_rebote,
            "es_manual": is_manual,
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


def _empty_email_config() -> Dict[str, Any]:
    return {
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "smtp_user": "",
        "smtp_password": "",
        "smtp_password_masked": "",
        "has_password": False,
        "smtp_security": "STARTTLS",
        "remitente_nombre": "notificaciones@access.com",
        "remitente_email": "",
        "destinatario_default": "",
        "is_configured": False
    }


def get_email_config(mask_password: bool = True, user_id: Optional[int] = None) -> Dict[str, Any]:
    if user_id is not None:
        raw_json = get_setting("smtp_config", None, user_id=user_id)
        if not raw_json:
            return _empty_email_config()
        try:
            row = json.loads(raw_json)
        except Exception:
            return _empty_email_config()
        pwd = row.get("smtp_password") or ""
        has_pwd = bool(pwd)
        smtp_u = row.get("smtp_user") or ""
        raw_rem = (row.get("remitente_email") or "").strip()
        return {
            "smtp_host": row.get("smtp_host") or "smtp.gmail.com",
            "smtp_port": int(row.get("smtp_port") or 587),
            "smtp_user": smtp_u,
            "smtp_password": "••••••••" if (mask_password and has_pwd) else pwd,
            "smtp_password_masked": "••••••••" if has_pwd else "",
            "has_password": has_pwd,
            "smtp_security": row.get("smtp_security") or "STARTTLS",
            "remitente_nombre": row.get("remitente_nombre") or "notificaciones@access.com",
            "remitente_email": raw_rem if ("@" in raw_rem) else smtp_u,
            "destinatario_default": row.get("destinatario_default") or "",
            "is_configured": bool(row.get("smtp_host") and row.get("smtp_user") and has_pwd)
        }

    conn = get_conn()
    row = conn.execute("SELECT * FROM config_correo WHERE id = 1").fetchone()
    conn.close()
    if not row:
        return _empty_email_config()
    pwd = row["smtp_password"] or ""
    has_pwd = bool(pwd)
    smtp_u = row["smtp_user"] or ""
    raw_rem = (row["remitente_email"] or "").strip()
    return {
        "smtp_host": row["smtp_host"] or "smtp.gmail.com",
        "smtp_port": row["smtp_port"] or 587,
        "smtp_user": smtp_u,
        "smtp_password": "••••••••" if (mask_password and has_pwd) else pwd,
        "smtp_password_masked": "••••••••" if has_pwd else "",
        "has_password": has_pwd,
        "smtp_security": row["smtp_security"] or "STARTTLS",
        "remitente_nombre": row["remitente_nombre"] or "notificaciones@access.com",
        "remitente_email": raw_rem if ("@" in raw_rem) else smtp_u,
        "destinatario_default": row["destinatario_default"] or "",
        "is_configured": bool(row["smtp_host"] and row["smtp_user"] and has_pwd)
    }


def update_email_config(data: Dict[str, Any], user_id: Optional[int] = None) -> Dict[str, Any]:
    current = get_email_config(mask_password=False, user_id=user_id)
    new_pwd = data.get("smtp_password", "")
    if (not new_pwd or new_pwd == "••••••••") and current and current.get("smtp_password"):
        new_pwd = current["smtp_password"]

    smtp_host = (data.get("smtp_host") or "smtp.gmail.com").strip()
    smtp_port = int(data.get("smtp_port") or 587)
    smtp_user = (data.get("smtp_user") or "").strip()
    smtp_security = (data.get("smtp_security") or "STARTTLS").strip()
    remitente_nombre = (data.get("remitente_nombre") or "notificaciones@access.com").strip()
    raw_remitente = (data.get("remitente_email") or "").strip()
    remitente_email = raw_remitente if ("@" in raw_remitente) else smtp_user
    destinatario_default = (data.get("destinatario_default") or "").strip()
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if user_id is not None:
        cfg_obj = {
            "smtp_host": smtp_host,
            "smtp_port": smtp_port,
            "smtp_user": smtp_user,
            "smtp_password": new_pwd,
            "smtp_security": smtp_security,
            "remitente_nombre": remitente_nombre,
            "remitente_email": remitente_email,
            "destinatario_default": destinatario_default,
            "updated_at": now_str
        }
        set_setting("smtp_config", json.dumps(cfg_obj), user_id=user_id)
        return get_email_config(mask_password=True, user_id=user_id)

    conn = get_conn()
    cur = conn.cursor()
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
    branch_rows = conn.execute("SELECT id, nombre FROM sucursales WHERE empresa_id = ?", (empresa_id,)).fetchall()
    branches_map = {int(b["id"]): b["nombre"] for b in branch_rows}

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
            SELECT id, sucursal_id, serial_no, codigo_empleado, nombre, tipo_evento,
                   sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento,
                   es_rebote, es_manual, nota_incidencia, created_at
            FROM checadas
            {where_clause}
            ORDER BY fecha_hora_evento DESC, id DESC
            LIMIT 500
        """
        rows = conn.execute(sql, tuple(params)).fetchall()

        default_tol = int(get_setting("tolerancia_minutos", 10))
        punch_statuses = _evaluate_punch_statuses_for_rows(conn, rows, empresa_id, sucursal_id, default_tol)

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
            emp_code = str(r["codigo_empleado"])
            is_rebote = bool(r["es_rebote"])
            is_manual = bool(r["es_manual"])
            area_res = r["area"] or get_employee_area(emp_code, empresa_id, sucursal_id)

            if is_rebote:
                total_rebotes += 1
            else:
                total_validas += 1

            unique_emps.add(emp_code)
            actual_metodo = "MANUAL" if is_manual else metodo_short
            metodos_count[actual_metodo] = metodos_count.get(actual_metodo, 0) + 1

            if is_rebote:
                status_label = "REBOTE IGNORADO (<180s)"
            else:
                status_label = punch_statuses.get(r["id"], "JUSTIFICADO (MANUAL)" if is_manual else "PUNTUAL")

            records.append({
                "id": r["id"],
                "sucursal_id": r["sucursal_id"],
                "sucursal_nombre": branches_map.get(int(r["sucursal_id"] or 0), ""),
                "serial_no": r["serial_no"],
                "codigo_empleado": emp_code,
                "nombre": r["nombre"],
                "area": area_res,
                "reloj_nombre": r["reloj_nombre"] or "Terminal Principal",
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

        default_tol = int(get_setting("tolerancia_minutos", 10))
        resolver = build_schedule_resolver(conn, empresa_id, sucursal_id, default_tol=default_tol)

        now_dt = datetime.datetime.now()
        today_date = now_dt.date()
        now_time = now_dt.time()
        eval_dt_start: Optional[datetime.date] = None
        eval_dt_end: Optional[datetime.date] = None
        try:
            if start_date and str(start_date).strip():
                eval_dt_start = datetime.date.fromisoformat(str(start_date).strip()[:10])
            if end_date and str(end_date).strip():
                eval_dt_end = datetime.date.fromisoformat(str(end_date).strip()[:10])
        except ValueError:
            eval_dt_start, eval_dt_end = None, None
        if eval_dt_start and not eval_dt_end:
            eval_dt_end = today_date
        if eval_dt_start and eval_dt_end:
            if eval_dt_start > eval_dt_end:
                eval_dt_start, eval_dt_end = eval_dt_end, eval_dt_start
            max_absence_date = min(eval_dt_end, today_date)
        else:
            max_absence_date = None

        emp_summary_rows = []
        total_validas_global = 0
        total_rebotes_global = 0
        total_retardos_global = 0
        total_faltas_global = 0
        total_incompletos_global = 0
        total_horas_global = 0.0

        for emp in employees_list:
            emp_code = str(emp["codigo_empleado"])
            # Cruce multi-sucursal: incluir todas las checadas del colaborador en cualquier reloj de la empresa
            c_conditions = ["empresa_id = ?", "codigo_empleado = ?"]
            c_params: List[Any] = [empresa_id, emp_code]
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
                ORDER BY fecha_hora_evento ASC, id ASC
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
            minutos_retardo_total = 0
            dias_incompletos_emp = 0
            horas_trabajadas_emp = 0.0
            emp_area_name = emp["area_nombre"] or "General"
            sched = resolve_employee_schedule(
                resolver,
                emp_code=emp_code,
                area_name=emp_area_name,
                emp_horario_id=_row_get(emp, "horario_id")
            )
            tolerancia_emp = sched["tolerancia_min"]
            horario_esperado = sched["resumen_corto"]
            horario_detalle = sched["resumen_detalle"]

            dias_detalle: List[Dict[str, Any]] = []

            for day_key, day_recs in days_dict.items():
                try:
                    day_date = datetime.date.fromisoformat(day_key)
                except ValueError:
                    continue
                day_blocks = sched["bloques_por_dia"].get(day_date.isoweekday(), [])
                day_eval = evaluate_day_blocks(day_date, day_recs, day_blocks, default_tolerance=tolerancia_emp)

                if day_eval["es_retardo"]:
                    retardos_emp += 1
                    minutos_retardo_total += day_eval["minutos_retardo"]
                if day_eval["es_incompleto"]:
                    dias_incompletos_emp += 1
                horas_trabajadas_emp += (day_eval["worked_sec"] / 3600.0)

                dias_detalle.append({
                    "fecha": day_key,
                    "entrada": day_eval["entrada"],
                    "salida": day_eval["salida"],
                    "horas": day_eval["horas"],
                    "total_checadas": day_eval["total_checadas"],
                    "estatus_entrada": day_eval["estatus_entrada"],
                    "es_retardo": day_eval["es_retardo"],
                    "minutos_retardo": day_eval["minutos_retardo"],
                    "es_incompleto": day_eval["es_incompleto"],
                    "es_manual": day_eval["es_manual"],
                    "tiene_incidencia": day_eval["tiene_incidencia"],
                    "tipos_incidencia": day_eval["tipos_incidencia"],
                    "nota_incidencia": day_eval["nota_incidencia"],
                    "horario_dia": day_eval["horario_dia"],
                    "bloques_detalle": day_eval["bloques_detalle"],
                    "metodo": day_eval["metodo"],
                    "reloj": day_eval["reloj"]
                })

            dias_detalle.sort(key=lambda x: x["fecha"], reverse=True)
            incidencias_detalle = [d for d in dias_detalle if d["tiene_incidencia"]]

            faltas_emp = 0
            if eval_dt_start and max_absence_date and eval_dt_start <= max_absence_date:
                curr_eval_d = eval_dt_start
                while curr_eval_d <= max_absence_date:
                    d_str = curr_eval_d.strftime("%Y-%m-%d")
                    if d_str not in days_dict:
                        day_blocks = sched["bloques_por_dia"].get(curr_eval_d.isoweekday(), [])
                        if day_blocks:
                            last_exit = day_blocks[-1]["hora_salida"]
                            if _is_unjustified_absence_day(
                                current_date=curr_eval_d,
                                today_date=today_date,
                                now_time=now_time,
                                max_absence_date=max_absence_date,
                                hora_salida=last_exit,
                                dias_laborales={curr_eval_d.isoweekday()}
                            ):
                                faltas_emp += 1
                    curr_eval_d += datetime.timedelta(days=1)

            total_retardos_global += retardos_emp
            total_faltas_global += faltas_emp
            total_incompletos_global += dias_incompletos_emp
            total_horas_global += horas_trabajadas_emp

            first_check = validas[0]["fecha_hora_evento"].replace("T", " ")[:19] if validas else "Sin registro"
            last_check = validas[-1]["fecha_hora_evento"].replace("T", " ")[:19] if validas else "Sin registro"

            relojes_used = [r["reloj_nombre"] for r in emp_records if r["reloj_nombre"]]
            reloj_preferido = max(set(relojes_used), key=relojes_used.count) if relojes_used else (emp["reloj_asignado"] or "Terminal Principal")

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
                "sucursal_id": emp["sucursal_id"],
                "sucursal_base_nombre": branches_map.get(int(emp["sucursal_id"] or 0), "Sin sucursal"),
                "area_nombre": emp["area_nombre"],
                "puesto": emp["puesto"],
                "turno": emp["turno"],
                "horario_id": sched["horario_id"],
                "horario_nombre": sched["horario_nombre"],
                "horario_origen": sched["origen"],
                "es_horario_mixto": sched["es_mixto"],
                "dias_asistidos": dias_asistidos,
                "dias_activos": dias_asistidos,
                "retardos": retardos_emp,
                "faltas": faltas_emp,
                "dias_incompletos": dias_incompletos_emp,
                "horas_trabajadas": round(horas_trabajadas_emp, 1),
                "total_validas": len(validas),
                "total_rebotes": len(rebotes),
                "primera_checada": first_check,
                "ultima_checada": last_check,
                "reloj_preferido": reloj_preferido,
                "metodo_preferido": metodo_preferido,
                "estatus": status_str,
                "minutos_retardo_total": minutos_retardo_total,
                "tolerancia_min": tolerancia_emp,
                "horario_esperado": horario_esperado,
                "horario_detalle": horario_detalle,
                "incidencias_detalle": incidencias_detalle,
                "dias_detalle": dias_detalle
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
                "total_faltas": total_faltas_global,
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
                "sucursal_id": clk["sucursal_id"],
                "sucursal_nombre": branches_map.get(int(clk["sucursal_id"] or 0), ""),
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
            a_suc_id = int(a["sucursal_id"] or 0)
            if area and area != "TODAS" and a_name != area:
                continue

            emp_cnt = conn.execute(
                "SELECT COUNT(*) as c FROM empleados WHERE empresa_id = ? AND sucursal_id = ? AND area_nombre = ?",
                (empresa_id, a_suc_id, a_name)
            ).fetchone()["c"]
            total_emp_global += emp_cnt

            c_conds = ["empresa_id = ?", "sucursal_id = ?", "area = ?"]
            c_params = [empresa_id, a_suc_id, a_name]
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
                "sucursal_id": a_suc_id,
                "sucursal_nombre": branches_map.get(a_suc_id, ""),
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


def _is_unjustified_absence_day(
    current_date: datetime.date,
    today_date: datetime.date,
    now_time: datetime.time,
    max_absence_date: datetime.date,
    hora_salida: Optional[datetime.time],
    dias_laborales: set
) -> bool:
    """Evalúa si un día sin checadas corresponde a una falta injustificada (nunca en futuro ni antes de hora_salida hoy)."""
    if current_date > max_absence_date:
        return False
    exit_time = hora_salida or datetime.time(17, 0)
    if current_date == today_date and now_time <= exit_time:
        return False
    return current_date.isoweekday() in (dias_laborales or {1, 2, 3, 4, 5})


def generate_contpaqi_txt(
    empresa_id: int,
    sucursal_id: Optional[int],
    start_date: Optional[str],
    end_date: Optional[str],
    tipo_periodo: str = "Quincenal",
    numero_periodo: int = 1,
    ejercicio: int = 2026,
    conceptos_map: Optional[Dict[str, str]] = None,
    area_nombre: Optional[str] = None
) -> str:
    """
    Genera el archivo TXT de ancho fijo (Maestro-Detalle) para importar incidencias
    a CONTPAQi Nóminas respetando posiciones absolutas (103 chars Maestro, 147 chars Detalle, CRLF).
    """
    cmap = {
        "falta": "Faltas injustificadas",
        "retardo": "Retardos",
        "horas_extra": "Horas extras dobles"
    }
    if conceptos_map:
        for k, v in conceptos_map.items():
            if v and str(v).strip():
                cmap[k] = str(v).strip()

    now_dt = datetime.datetime.now()
    today_date = now_dt.date()
    now_time = now_dt.time()
    try:
        dt_end = datetime.date.fromisoformat((end_date or "").strip()[:10]) if end_date else today_date
    except ValueError:
        dt_end = today_date
    try:
        dt_start = datetime.date.fromisoformat((start_date or "").strip()[:10]) if start_date else (dt_end - datetime.timedelta(days=14))
    except ValueError:
        dt_start = dt_end - datetime.timedelta(days=14)
    if dt_start > dt_end:
        dt_start, dt_end = dt_end, dt_start

    max_absence_date = min(dt_end, today_date)

    start_str = dt_start.strftime("%Y-%m-%d")
    end_str = dt_end.strftime("%Y-%m-%d")

    date_range: List[datetime.date] = []
    curr_d = dt_start
    while curr_d <= dt_end:
        date_range.append(curr_d)
        curr_d += datetime.timedelta(days=1)

    conn = get_conn()
    emp_conds = ["empresa_id = ?", "COALESCE(estado, 'ACTIVO') = 'ACTIVO'"]
    emp_params: List[Any] = [empresa_id]
    if sucursal_id:
        emp_conds.append("sucursal_id = ?")
        emp_params.append(sucursal_id)
    if area_nombre and str(area_nombre).strip().upper() not in ("", "TODAS", "ALL"):
        emp_conds.append("area_nombre = ?")
        emp_params.append(str(area_nombre).strip())

    employees_list = conn.execute(
        f"SELECT * FROM empleados WHERE {' AND '.join(emp_conds)} ORDER BY id ASC",
        tuple(emp_params)
    ).fetchall()

    default_tol = int(get_setting("tolerancia_minutos", 10))
    resolver = build_schedule_resolver(conn, empresa_id, sucursal_id, default_tol=default_tol)
    lines: List[str] = []

    for emp in employees_list:
        emp_code_bio = str(emp["codigo_empleado"]).strip()
        # Cruce multi-sucursal: considerar todas las checadas válidas del empleado en cualquier reloj de la empresa
        c_conds = [
            "empresa_id = ?",
            "codigo_empleado = ?",
            "es_rebote = 0",
            "substr(fecha_hora_evento, 1, 10) >= ?",
            "substr(fecha_hora_evento, 1, 10) <= ?"
        ]
        c_params: List[Any] = [empresa_id, emp_code_bio, start_str, end_str]

        chk_rows = conn.execute(
            f"SELECT id, fecha_hora_evento, es_manual FROM checadas WHERE {' AND '.join(c_conds)} ORDER BY fecha_hora_evento ASC, id ASC",
            tuple(c_params)
        ).fetchall()

        days_dict: Dict[str, List[Any]] = {}
        for r in chk_rows:
            day_k = (r["fecha_hora_evento"] or "")[:10]
            if day_k:
                days_dict.setdefault(day_k, []).append(r)

        sched = resolve_employee_schedule(
            resolver,
            emp_code=emp_code_bio,
            area_name=emp["area_nombre"] or "General",
            emp_horario_id=_row_get(emp, "horario_id")
        )
        tol_min = sched["tolerancia_min"]

        emp_incidences: List[Tuple[str, float, str]] = []
        for d in date_range:
            day_str = d.strftime("%Y-%m-%d")
            fecha_dd_mm_aaaa = d.strftime("%d/%m/%Y")
            day_recs = days_dict.get(day_str, [])
            day_blocks = sched["bloques_por_dia"].get(d.isoweekday(), [])

            if not day_recs:
                if day_blocks:
                    last_exit = day_blocks[-1]["hora_salida"]
                    if _is_unjustified_absence_day(
                        current_date=d,
                        today_date=today_date,
                        now_time=now_time,
                        max_absence_date=max_absence_date,
                        hora_salida=last_exit,
                        dias_laborales={d.isoweekday()}
                    ):
                        emp_incidences.append((cmap["falta"], 1.00, fecha_dd_mm_aaaa))
                continue

            day_eval = evaluate_day_blocks(d, day_recs, day_blocks, default_tolerance=tol_min)
            if day_eval["es_retardo"]:
                emp_incidences.append((cmap["retardo"], 1.00, fecha_dd_mm_aaaa))
            if day_blocks and day_eval["extra_sec"] >= 1800:
                extra_hours = round(day_eval["extra_sec"] / 3600.0, 2)
                emp_incidences.append((cmap["horas_extra"], extra_hours, fecha_dd_mm_aaaa))

        if not emp_incidences:
            continue

        emp_contpaqi = (emp["codigo_contpaqi"] if "codigo_contpaqi" in emp.keys() else "") or ""
        export_code = emp_contpaqi.strip() or emp_code_bio
        master_line = ("E" + (" " * 7) + export_code[:7].ljust(7)).ljust(103)[:103]
        lines.append(master_line)

        for concepto_desc, valor, fecha_fmt in emp_incidences:
            detail_line = (
                "D"
                + " "
                + str(tipo_periodo)[:22].ljust(22)
                + " "
                + str(numero_periodo)[:3].rjust(3)
                + " "
                + "2"
                + (" " * 19)
                + str(concepto_desc)[:33].ljust(33)
                + " "
                + f"{float(valor):.2f}"[:15].rjust(15)
                + " "
                + fecha_fmt[:15].ljust(15)
                + " "
                + str(ejercicio)[:4].ljust(4)
                + (" " * 28)
            )
            lines.append(detail_line.ljust(147)[:147])

    conn.close()
    if not lines:
        return ""
    return "\r\n".join(lines) + "\r\n"
