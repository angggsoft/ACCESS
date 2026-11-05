"""
ACCESS — Capa de Persistencia SQLite y Sincronización ISAPI
Base de datos: pruebas_checador.db
"""

import sqlite3
import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
import config

DB_FILE = Path(__file__).parent.parent / "pruebas_checador.db"

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


def record_checkin(serial_no: Optional[int], emp_no: str, nombre: str,
                   tipo_evento: str, sub_event_type: int,
                   fecha_hora: str, reloj_nombre: str = "Cerro Gordo",
                   debounce_seconds: int = 180) -> Dict[str, Any]:
    """
    Registra una checada evitando duplicados por serial_no o (codigo_empleado + fecha_hora_evento)
    y calculando automáticamente el filtro anti-rebote (debounce).
    """
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
