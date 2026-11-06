"""
ACCESS — Capa de Persistencia SQLite y Sincronización ISAPI
Base de datos de producción: access.db
"""

import sqlite3
import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
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


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    # 1. Tabla de checadas (compatible con versión previa y columnas extendidas)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS checadas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serial_no INTEGER,
            codigo_empleado TEXT,
            nombre TEXT,
            tipo_evento TEXT,
            sub_event_type INTEGER,
            fecha_hora_evento TEXT,
            es_rebote INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # Asegurar columnas adicionales en checadas si no existen
    existing_cols = [r["name"] for r in cur.execute("PRAGMA table_info(checadas)").fetchall()]
    if "metodo" not in existing_cols:
        cur.execute("ALTER TABLE checadas ADD COLUMN metodo TEXT DEFAULT 'BIOMETRÍA'")
    if "area" not in existing_cols:
        cur.execute("ALTER TABLE checadas ADD COLUMN area TEXT DEFAULT 'General'")
    if "reloj_nombre" not in existing_cols:
        cur.execute("ALTER TABLE checadas ADD COLUMN reloj_nombre TEXT DEFAULT 'Cerro Gordo'")

    # 2. Tabla de Áreas / Departamentos
    cur.execute("""
        CREATE TABLE IF NOT EXISTS areas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT UNIQUE,
            nombre TEXT NOT NULL,
            responsable TEXT,
            turno TEXT,
            horario TEXT,
            tolerancia_min INTEGER DEFAULT 10,
            ubicacion TEXT,
            activo INTEGER DEFAULT 1
        );
    """)

    # 3. Tabla de Relojes Checadores (ISAPI)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS relojes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            modelo TEXT,
            serie TEXT,
            mac TEXT,
            firmware TEXT,
            ip TEXT NOT NULL,
            puerto INTEGER DEFAULT 80,
            usuario TEXT DEFAULT 'admin',
            password TEXT,
            red_tipo TEXT DEFAULT 'Wi-Fi (TBS)',
            area_asignada TEXT DEFAULT 'Operaciones Cerro Gordo',
            ubicacion TEXT DEFAULT 'Acceso Principal',
            estado TEXT DEFAULT 'ONLINE',
            total_eventos INTEGER DEFAULT 0,
            total_usuarios INTEGER DEFAULT 0,
            ultima_sincronizacion TEXT
        );
    """)

    # 4. Tabla de Empleados
    cur.execute("""
        CREATE TABLE IF NOT EXISTS empleados (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo_empleado TEXT UNIQUE NOT NULL,
            nombre TEXT NOT NULL,
            area_nombre TEXT DEFAULT 'TI y Sistemas',
            puesto TEXT DEFAULT 'Especialista',
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

    # 5. Tabla de Configuración y Preferencias del Sistema
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
        ("operator_role", "Ingeniero de Sistemas y Hardware"),
        ("operator_email", "angel.flores@quodo.mx"),
        ("operator_shift", "Mixto (08:00 - 17:30)"),
        ("sound_alerts", "1"),
        ("auto_scroll", "1")
    ]
    cur.executemany("""
        INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
    """, default_settings)

    # 6. Tabla de Configuración de Correo (SMTP)
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
        INSERT OR IGNORE INTO config_correo (id, smtp_host, smtp_port, smtp_user, smtp_password, smtp_security, remitente_nombre, remitente_email, destinatario_default)
        VALUES (1, 'smtp.gmail.com', 587, '', '', 'STARTTLS', 'ACCESS - Control Biométrico', '', '')
    """)

    # Semillas por defecto para Áreas
    areas_count = cur.execute("SELECT COUNT(*) as c FROM areas").fetchone()["c"]
    if areas_count == 0:
        default_areas = [
            ("AREA-TI", "TI y Sistemas", "Angel Flores", "Mixto / Ingeniería", "08:00 - 17:30", 15, "Corporativo / CEDIS"),
            ("AREA-CG", "Operaciones Cerro Gordo", "Areli Martinez", "Matutino Operativo", "07:00 - 15:30", 10, "Planta Cerro Gordo"),
            ("AREA-ALM", "Almacén y Logística CEDIS", "Carlos Mendoza", "Matutino Almacén", "07:00 - 15:30", 10, "CEDIS Matriz"),
            ("AREA-ADM", "Administración y RH", "Ernestina", "Oficina Central", "08:30 - 18:00", 10, "Oficinas Generales"),
        ]
        cur.executemany("""
            INSERT INTO areas (codigo, nombre, responsable, turno, horario, tolerancia_min, ubicacion)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, default_areas)

    # Semilla por defecto para Reloj físico real
    relojes_count = cur.execute("SELECT COUNT(*) as c FROM relojes").fetchone()["c"]
    if relojes_count == 0:
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur.execute("""
            INSERT INTO relojes (
                nombre, modelo, serie, mac, firmware, ip, puerto, usuario, password,
                red_tipo, area_asignada, ubicacion, estado, total_eventos, total_usuarios, ultima_sincronizacion
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            "Cerro Gordo",
            "DS-K1T320MFWX-B",
            "DS-K1T320MFWX-B20240701V030502ENFX6280429",
            "60:56:ee:ec:a6:5c",
            "V3.5.2 build 240701",
            config.HIK_HOST,
            config.HIK_PORT,
            config.HIK_USER,
            config.HIK_PASS,
            "Wi-Fi (TBS)",
            "Operaciones Cerro Gordo",
            "Acceso Principal • Escritorio TI",
            "ONLINE",
            169,
            3,
            now_str
        ))

    # Semillas por defecto para Empleados reales del reloj
    emp_count = cur.execute("SELECT COUNT(*) as c FROM empleados").fetchone()["c"]
    if emp_count == 0:
        default_emps = [
            ("1", "Areli Martinez", "Operaciones Cerro Gordo", "Coordinadora de Operaciones", "Matutino (07:00 - 15:30)", "", 1, 1, 0, 1, "Cerro Gordo", "ACTIVO"),
            ("2", "ernestina", "Administración y RH", "Analista de Asistencia", "Oficina (08:30 - 18:00)", "", 1, 1, 0, 0, "Cerro Gordo", "ACTIVO"),
            ("3", "Angel Flores", "TI y Sistemas", "Ingeniero de Sistemas y Hardware", "Mixto (08:00 - 17:30)", "123456", 1, 0, 0, 1, "Cerro Gordo", "ACTIVO"),
        ]
        cur.executemany("""
            INSERT INTO empleados (
                codigo_empleado, nombre, area_nombre, puesto, turno, pin,
                tiene_huella, tiene_rostro, tiene_tarjeta, admin_ui, reloj_asignado, estado
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, default_emps)

    # Actualizar nombres, áreas y métodos en checadas y catálogos existentes con correcta acentuación
    cur.execute("UPDATE checadas SET nombre = 'Angel Flores' WHERE codigo_empleado = '3' AND (nombre = 'Ingeniero TI' OR nombre IS NULL)")
    cur.execute("UPDATE checadas SET metodo = 'HUELLA' WHERE sub_event_type = 38")
    cur.execute("UPDATE checadas SET metodo = 'ROSTRO' WHERE sub_event_type IN (75, 104)")
    cur.execute("UPDATE checadas SET metodo = 'PIN' WHERE sub_event_type IN (9, 181)")
    cur.execute("UPDATE checadas SET metodo = 'TARJETA' WHERE sub_event_type = 1")
    cur.execute("UPDATE areas SET turno = 'Mixto / Ingeniería' WHERE codigo = 'AREA-TI'")
    cur.execute("UPDATE areas SET nombre = 'Almacén y Logística CEDIS', turno = 'Matutino Almacén' WHERE codigo = 'AREA-ALM'")
    cur.execute("UPDATE areas SET nombre = 'Administración y RH' WHERE codigo = 'AREA-ADM'")
    cur.execute("UPDATE empleados SET area_nombre = 'Administración y RH' WHERE codigo_empleado = '2'")
    cur.execute("UPDATE relojes SET ubicacion = 'Acceso Principal • Escritorio TI' WHERE id = 1")

    conn.commit()
    conn.close()


init_db()


def get_employee_area(emp_no: str) -> str:
    conn = get_conn()
    row = conn.execute("SELECT area_nombre FROM empleados WHERE codigo_empleado = ?", (str(emp_no),)).fetchone()
    conn.close()
    return row["area_nombre"] if row else "Operaciones Cerro Gordo"


def get_employee_name(emp_no: str, fallback: str = "Desconocido") -> str:
    conn = get_conn()
    row = conn.execute("SELECT nombre FROM empleados WHERE codigo_empleado = ?", (str(emp_no),)).fetchone()
    conn.close()
    if row and row["nombre"]:
        return row["nombre"]
    return fallback


def get_setting(key: str, default: Any = None) -> Any:
    """Obtiene un parámetro de configuración del sistema."""
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    if row is not None:
        return row["value"]
    return default


def get_all_settings() -> Dict[str, Any]:
    """Obtiene todos los parámetros de configuración."""
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    res = {r["key"]: r["value"] for r in rows}
    res.setdefault("debounce_seconds", "180")
    res.setdefault("tolerancia_minutos", "10")
    res.setdefault("operator_name", "Angel Flores")
    res.setdefault("operator_role", "Ingeniero de Sistemas y Hardware")
    res.setdefault("operator_email", "angel.flores@quodo.mx")
    res.setdefault("operator_shift", "Mixto (08:00 - 17:30)")
    return res


def set_setting(key: str, value: Any):
    """Guarda o actualiza un parámetro de configuración."""
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
    conn.commit()
    conn.close()


def update_settings(data: Dict[str, Any]):
    """Actualiza múltiples parámetros de configuración."""
    conn = get_conn()
    for k, v in data.items():
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (str(k), str(v)))
    conn.commit()
    conn.close()


def record_checkin(serial_no: Optional[int], emp_no: str, nombre: str,
                   tipo_evento: str, sub_event_type: int,
                   fecha_hora: str, reloj_nombre: str = "Cerro Gordo",
                   debounce_seconds: Optional[int] = None) -> Dict[str, Any]:
    """
    Registra una checada evitando duplicados por serial_no o (codigo_empleado + fecha_hora_evento)
    y calculando automáticamente el filtro anti-rebote (debounce).
    """
    if debounce_seconds is None:
        try:
            debounce_seconds = int(get_setting("debounce_seconds", 180))
        except (ValueError, TypeError):
            debounce_seconds = 180

    conn = get_conn()
    cur = conn.cursor()

    # Verificar si ya existe exactamente el mismo evento (por fecha_hora_evento y empleado)
    existing = cur.execute("""
        SELECT id, es_rebote FROM checadas
        WHERE codigo_empleado = ? AND fecha_hora_evento = ?
        LIMIT 1
    """, (str(emp_no), fecha_hora)).fetchone()

    if existing:
        conn.close()
        return {"inserted": False, "id": existing["id"], "es_rebote": bool(existing["es_rebote"])}

    # Resolver nombre real y área desde tabla de empleados
    real_name = get_employee_name(emp_no, nombre)
    area_name = get_employee_area(emp_no)
    metodo_short, _ = SUB_EVENT_LABELS.get(sub_event_type, ("BIOMETRÍA", f"Evento #{sub_event_type}"))

    # Calcular anti-rebote comparando contra la última checada válida del empleado
    es_rebote = 0
    diff_sec = None
    try:
        dt_curr = datetime.datetime.fromisoformat(fecha_hora.replace("Z", "+00:00"))
        prev_rows = cur.execute("""
            SELECT fecha_hora_evento FROM checadas
            WHERE codigo_empleado = ? AND es_rebote = 0
            ORDER BY fecha_hora_evento DESC LIMIT 5
        """, (str(emp_no),)).fetchall()
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
            serial_no, codigo_empleado, nombre, tipo_evento,
            sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento, es_rebote
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        serial_no, str(emp_no), real_name, tipo_evento,
        sub_event_type, metodo_short, area_name, reloj_nombre, fecha_hora, es_rebote
    ))
    new_id = cur.lastrowid
    conn.commit()
    conn.close()

    return {
        "inserted": True,
        "id": new_id,
        "serial_no": serial_no,
        "codigo_empleado": str(emp_no),
        "nombre": real_name,
        "area": area_name,
        "metodo": metodo_short,
        "sub_event_type": sub_event_type,
        "fecha_hora_evento": fecha_hora,
        "es_rebote": bool(es_rebote),
        "diff_sec": diff_sec
    }


def list_checadas(limit: int = 100) -> List[Dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute("""
        SELECT id, serial_no, codigo_empleado, nombre, tipo_evento,
               sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento, es_rebote, created_at
        FROM checadas
        ORDER BY fecha_hora_evento DESC, id DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()

    result = []
    for r in rows:
        sub_code = r["sub_event_type"]
        metodo_short, metodo_desc = SUB_EVENT_LABELS.get(sub_code, (r["metodo"] or "BIOMETRÍA", f"Evento #{sub_code}"))
        # Formatear hora legible
        raw_dt = r["fecha_hora_evento"] or ""
        display_dt = raw_dt.replace("T", " ")[:19]
        result.append({
            "id": r["id"],
            "serial_no": r["serial_no"],
            "codigo_empleado": r["codigo_empleado"],
            "nombre": r["nombre"],
            "area": r["area"] or get_employee_area(r["codigo_empleado"]),
            "reloj_nombre": r["reloj_nombre"] or "Cerro Gordo",
            "tipo_evento": r["tipo_evento"],
            "sub_event_type": sub_code,
            "metodo": metodo_short,
            "metodo_desc": metodo_desc,
            "fecha_hora_evento": raw_dt,
            "fecha_hora_display": display_dt,
            "es_rebote": bool(r["es_rebote"]),
            "estatus_prenomina": "REBOTE IGNORADO (<180s)" if r["es_rebote"] else "VÁLIDO (En Turno)",
            "created_at": r["created_at"]
        })
    return result


def get_dashboard_summary() -> Dict[str, Any]:
    conn = get_conn()
    total_checadas = conn.execute("SELECT COUNT(*) as c FROM checadas").fetchone()["c"]
    validas = conn.execute("SELECT COUNT(*) as c FROM checadas WHERE es_rebote = 0").fetchone()["c"]
    rebotes = conn.execute("SELECT COUNT(*) as c FROM checadas WHERE es_rebote = 1").fetchone()["c"]
    total_empleados = conn.execute("SELECT COUNT(*) as c FROM empleados").fetchone()["c"]
    con_huella = conn.execute("SELECT COUNT(*) as c FROM empleados WHERE tiene_huella = 1").fetchone()["c"]
    con_rostro = conn.execute("SELECT COUNT(*) as c FROM empleados WHERE tiene_rostro = 1").fetchone()["c"]
    total_relojes = conn.execute("SELECT COUNT(*) as c FROM relojes").fetchone()["c"]
    relojes_online = conn.execute("SELECT COUNT(*) as c FROM relojes WHERE estado = 'ONLINE'").fetchone()["c"]
    total_areas = conn.execute("SELECT COUNT(*) as c FROM areas").fetchone()["c"]
    conn.close()

    return {
        "total_checadas": total_checadas,
        "checadas_hoy": total_checadas,
        "checadas_validas": validas,
        "validas_hoy": validas,
        "rebotes_ignorados": rebotes,
        "rebotes_hoy": rebotes,
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
    status_filter: Optional[str] = None
) -> Dict[str, Any]:
    conn = get_conn()

    # Filtros base
    conditions = []
    params = []

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
                   sub_event_type, metodo, area, reloj_nombre, fecha_hora_evento, es_rebote, created_at
            FROM checadas
            {where_clause}
            ORDER BY fecha_hora_evento DESC, id DESC
            LIMIT 500
        """
        rows = conn.execute(sql, params).fetchall()

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
            is_rebote = bool(r["es_rebote"])
            if is_rebote:
                total_rebotes += 1
            else:
                total_validas += 1

            unique_emps.add(str(r["codigo_empleado"]))
            metodos_count[metodo_short] = metodos_count.get(metodo_short, 0) + 1

            records.append({
                "id": r["id"],
                "serial_no": r["serial_no"],
                "codigo_empleado": r["codigo_empleado"],
                "nombre": r["nombre"],
                "area": r["area"] or get_employee_area(r["codigo_empleado"]),
                "reloj_nombre": r["reloj_nombre"] or "Cerro Gordo",
                "tipo_evento": r["tipo_evento"],
                "sub_event_type": sub_code,
                "metodo": metodo_short,
                "metodo_desc": metodo_desc,
                "fecha_hora_evento": raw_dt,
                "fecha_hora_display": display_dt,
                "es_rebote": is_rebote,
                "estatus_prenomina": "REBOTE IGNORADO" if is_rebote else "VÁLIDO",
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
        emp_query = "SELECT * FROM empleados"
        emp_params = []
        emp_conds = []
        if employee_id and employee_id != "TODOS":
            emp_conds.append("codigo_empleado = ?")
            emp_params.append(str(employee_id))
        if area and area != "TODAS":
            emp_conds.append("area_nombre = ?")
            emp_params.append(area)
        if emp_conds:
            emp_query += f" WHERE {' AND '.join(emp_conds)}"
        emp_query += " ORDER BY CAST(codigo_empleado AS INTEGER) ASC"
        employees_list = conn.execute(emp_query, emp_params).fetchall()

        emp_summary_rows = []
        total_validas_global = 0
        total_rebotes_global = 0

        for emp in employees_list:
            emp_code = str(emp["codigo_empleado"])
            c_conditions = ["codigo_empleado = ?"]
            c_params = [emp_code]
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
                SELECT id, fecha_hora_evento, es_rebote, metodo, reloj_nombre
                FROM checadas
                WHERE {' AND '.join(c_conditions)}
                ORDER BY fecha_hora_evento ASC
            """
            emp_records = conn.execute(c_sql, c_params).fetchall()

            validas = [r for r in emp_records if not r["es_rebote"]]
            rebotes = [r for r in emp_records if r["es_rebote"]]
            total_validas_global += len(validas)
            total_rebotes_global += len(rebotes)

            distinct_days = len(set(r["fecha_hora_evento"][:10] for r in validas if r["fecha_hora_evento"]))
            first_check = validas[0]["fecha_hora_evento"].replace("T", " ")[:19] if validas else "Sin registro"
            last_check = validas[-1]["fecha_hora_evento"].replace("T", " ")[:19] if validas else "Sin registro"

            relojes_used = [r["reloj_nombre"] for r in emp_records if r["reloj_nombre"]]
            reloj_preferido = max(set(relojes_used), key=relojes_used.count) if relojes_used else (emp["reloj_asignado"] or "Cerro Gordo")

            metodos_used = [r["metodo"] for r in emp_records if r["metodo"]]
            metodo_preferido = max(set(metodos_used), key=metodos_used.count) if metodos_used else ("ROSTRO" if emp["tiene_rostro"] else ("HUELLA" if emp["tiene_huella"] else "PIN"))

            status_str = "PRESENTE / REGISTRO AL DÍA" if len(validas) >= 2 else ("MARCAJE PARCIAL" if len(validas) == 1 else "SIN REGISTROS")

            emp_summary_rows.append({
                "codigo_empleado": emp["codigo_empleado"],
                "nombre": emp["nombre"],
                "area_nombre": emp["area_nombre"],
                "puesto": emp["puesto"],
                "turno": emp["turno"],
                "total_validas": len(validas),
                "total_rebotes": len(rebotes),
                "dias_activos": distinct_days,
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
                "promedio_checadas": round(total_validas_global / max(len(employees_list), 1), 1)
            },
            "headers": ["Código", "Colaborador", "Área", "Turno", "Válidas", "Rebotes", "Días", "Primera Checada", "Última Checada", "Estatus"],
            "data": emp_summary_rows
        }

    # 3. AUDITORÍA POR RELOJ CHECADOR
    elif report_type == "relojes":
        relojes_list = conn.execute("SELECT * FROM relojes ORDER BY id ASC").fetchall()
        clock_rows = []
        total_events_period = 0

        for clk in relojes_list:
            clk_name = clk["nombre"]
            c_conds = ["reloj_nombre = ?"]
            c_params = [clk_name]
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
            c_rows = conn.execute(c_sql, c_params).fetchall()
            validas = sum(1 for r in c_rows if not r["es_rebote"])
            rebotes = sum(1 for r in c_rows if r["es_rebote"])
            users_set = set(str(r["codigo_empleado"]) for r in c_rows)
            total_events_period += len(c_rows)

            metodos_count = {}
            for r in c_rows:
                m = r["metodo"] or "OTRO"
                metodos_count[m] = metodos_count.get(m, 0) + 1

            last_ev = c_rows[0]["fecha_hora_evento"].replace("T", " ")[:19] if c_rows else (clk["ultima_sincronizacion"] or "Sin actividad")

            clock_rows.append({
                "id": clk["id"],
                "nombre": clk["nombre"],
                "ip": clk["ip"],
                "modelo": clk["modelo"],
                "ubicacion": clk["ubicacion"],
                "estado": clk["estado"],
                "total_eventos_periodo": len(c_rows),
                "validas": validas,
                "rebotes": rebotes,
                "usuarios_distintos": len(users_set),
                "metodos": metodos_count,
                "ultima_actividad": last_ev
            })

        conn.close()
        return {
            "type": "relojes",
            "title": "Auditoría de Actividad por Reloj Checador",
            "summary": {
                "total_relojes": len(relojes_list),
                "relojes_online": sum(1 for c in clock_rows if c["estado"] == "ONLINE"),
                "total_eventos_periodo": total_events_period,
                "promedio_por_reloj": round(total_events_period / max(len(relojes_list), 1), 1)
            },
            "headers": ["Reloj", "IP", "Modelo", "Ubicación", "Eventos", "Válidas", "Rebotes", "Usuarios", "Última Actividad", "Estado"],
            "data": clock_rows
        }

    # 4. ASISTENCIA POR ÁREA / DEPARTAMENTO
    elif report_type == "areas":
        areas_list = conn.execute("SELECT * FROM areas ORDER BY id ASC").fetchall()
        area_rows = []
        total_headcount = 0
        total_validas_all = 0

        for a in areas_list:
            a_nombre = a["nombre"]
            emps_in_area = conn.execute("SELECT codigo_empleado FROM empleados WHERE area_nombre = ?", (a_nombre,)).fetchall()
            headcount = len(emps_in_area)
            total_headcount += headcount

            c_conds = ["area = ?"]
            c_params = [a_nombre]
            if start_date:
                c_conds.append("substr(fecha_hora_evento, 1, 10) >= ?")
                c_params.append(start_date)
            if end_date:
                c_conds.append("substr(fecha_hora_evento, 1, 10) <= ?")
                c_params.append(end_date)
            if reloj and reloj != "TODOS":
                c_conds.append("reloj_nombre = ?")
                c_params.append(reloj)

            c_sql = f"SELECT es_rebote, codigo_empleado FROM checadas WHERE {' AND '.join(c_conds)}"
            c_rows = conn.execute(c_sql, c_params).fetchall()

            validas = sum(1 for r in c_rows if not r["es_rebote"])
            rebotes = sum(1 for r in c_rows if r["es_rebote"])
            total_validas_all += validas

            present_emp_ids = set(str(r["codigo_empleado"]) for r in c_rows if not r["es_rebote"])
            present_count = len(present_emp_ids)
            cobertura_pct = round((present_count / headcount * 100) if headcount > 0 else 0, 1)

            area_rows.append({
                "id": a["id"],
                "codigo": a["codigo"],
                "nombre": a["nombre"],
                "responsable": a["responsable"],
                "turno": a["turno"],
                "horario": a["horario"],
                "plantilla": headcount,
                "colaboradores_presentes": present_count,
                "cobertura_pct": cobertura_pct,
                "total_validas": validas,
                "total_rebotes": rebotes
            })

        conn.close()
        return {
            "type": "areas",
            "title": "Consolidado de Asistencia por Área / Turno",
            "summary": {
                "total_areas": len(areas_list),
                "plantilla_total": total_headcount,
                "total_marcajes_validos": total_validas_all,
                "cobertura_promedio": round(sum(a["cobertura_pct"] for a in area_rows) / max(len(areas_list), 1), 1)
            },
            "headers": ["Código", "Área / Departamento", "Responsable", "Turno", "Horario", "Plantilla", "Presentes", "Cobertura %", "Marcajes Válidos"],
            "data": area_rows
        }

    conn.close()
    return {"type": "desconocido", "summary": {}, "headers": [], "data": []}
