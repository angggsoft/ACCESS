"""
Pruebas de Integración: Horarios Parciales, Partidos y Mixtos Multi-Bloque en ACCESS
Verifica migración automática, CRUD de horarios, herencia Área -> Empleado,
evaluación multi-bloque (reglas de retardo único/día y asistencia parcial),
Pre-Nómina, Bitácora, Exportación CONTPAQi y limpieza de horarios huérfanos.
"""

import sys
import tempfile
import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
import core.database as db
import main


def run_tests():
    orig_db_file = db.DB_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        temp_db = Path(tmpdir) / "test_mixed_schedules.db"
        db.DB_FILE = temp_db
        try:
            db.init_db()
            client = TestClient(main.app)

            # 1. Autenticarse como CLIENTE_RH semilla (rh.demo) y crear empresa/sucursal
            r_login = client.post("/api/auth/login", json={"username": "rh.demo", "password": "quodo123"})
            assert r_login.status_code == 200, f"Login failed: {r_login.text}"
            token = r_login.json()["token"]
            headers = {"Authorization": f"Bearer {token}"}

            r_comp = client.post(
                "/api/companies",
                json={"nombre": "Quodo Test Mixto", "sucursal_inicial": "Matriz"},
                headers=headers
            )
            assert r_comp.status_code == 200, r_comp.text
            emp_id = r_comp.json()["company"]["empresa_id"]
            suc_id = r_comp.json()["company"]["sucursal_id"]

            # 2. Verificar migración automática idempotente de áreas legacy sin horario_id
            conn = db.get_conn()
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO areas (empresa_id, sucursal_id, codigo, nombre, responsable, turno, horario, tolerancia_min, dias_laborales, horario_id, ubicacion)
                VALUES (?, ?, 'AREA-LEG', 'Soporte Legacy', 'RH', 'Especial', '09:00 - 18:00', 15, '1,2,3,4,5,6', NULL, 'Matriz')
            """, (emp_id, suc_id))
            legacy_area_id = cur.lastrowid
            conn.commit()
            conn.close()

            db.init_db()
            db.init_db()  # Idempotencia

            conn = db.get_conn()
            leg_row = conn.execute("SELECT horario_id FROM areas WHERE id = ?", (legacy_area_id,)).fetchone()
            assert leg_row and leg_row["horario_id"] is not None, "Área legacy no migrada"
            migrated_blocks = conn.execute(
                "SELECT dia_semana, hora_entrada, hora_salida FROM horario_bloques WHERE horario_id = ? ORDER BY dia_semana ASC",
                (leg_row["horario_id"],)
            ).fetchall()
            assert len(migrated_blocks) == 6
            assert migrated_blocks[0]["hora_entrada"] == "09:00" and migrated_blocks[0]["hora_salida"] == "18:00"
            # Verificar que no se duplicaron horarios en la segunda corrida
            cnt_same = conn.execute(
                "SELECT COUNT(*) as c FROM horarios WHERE empresa_id = ? AND sucursal_id = ? AND nombre = 'Especial — Soporte Legacy'",
                (emp_id, suc_id)
            ).fetchone()["c"]
            assert cnt_same == 1, f"Se duplicó plantilla en migración: {cnt_same}"
            conn.close()
            print("OK 1: Migración automática de áreas legacy idempotente")

            # 3. Crear área 'Administrativo' (08:00 - 17:00, 10 min, Lun-Vie)
            r_area = client.post(
                "/api/areas",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "codigo": "AREA-ADM",
                    "nombre": "Administrativo",
                    "responsable": "Angel",
                    "turno": "Matutino",
                    "horario": "08:00 - 17:00",
                    "tolerancia_min": 10,
                    "dias_laborales": "1,2,3,4,5"
                },
                headers=headers
            )
            assert r_area.status_code == 200, r_area.text

            # 4. CRUD de horarios via API + validaciones de rechazo 400
            r_bad_empty = client.post(
                "/api/schedules",
                json={"empresa_id": emp_id, "sucursal_id": suc_id, "nombre": "Vacío", "tolerancia_min": 10, "bloques": []},
                headers=headers
            )
            assert r_bad_empty.status_code == 400

            r_bad_night = client.post(
                "/api/schedules",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "nombre": "Nocturno",
                    "tolerancia_min": 10,
                    "bloques": [{"dia_semana": 1, "hora_entrada": "22:00", "hora_salida": "06:00"}]
                },
                headers=headers
            )
            assert r_bad_night.status_code == 400

            r_bad_overlap = client.post(
                "/api/schedules",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "nombre": "Solapado",
                    "tolerancia_min": 10,
                    "bloques": [
                        {"dia_semana": 1, "hora_entrada": "08:00", "hora_salida": "11:00"},
                        {"dia_semana": 1, "hora_entrada": "11:00", "hora_salida": "15:00"}
                    ]
                },
                headers=headers
            )
            assert r_bad_overlap.status_code == 400

            r_tpl = client.post(
                "/api/schedules",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "nombre": "Plantilla Prueba",
                    "tolerancia_min": 10,
                    "bloques": [
                        {"dia_semana": 1, "hora_entrada": "08:00", "hora_salida": "12:00"},
                        {"dia_semana": 1, "hora_entrada": "14:00", "hora_salida": "18:00"}
                    ]
                },
                headers=headers
            )
            assert r_tpl.status_code == 200, r_tpl.text
            tpl_id = r_tpl.json()["schedule"]["id"]

            r_list_sch = client.get(f"/api/schedules?empresa_id={emp_id}&sucursal_id={suc_id}", headers=headers)
            assert r_list_sch.status_code == 200
            assert any(s["id"] == tpl_id for s in r_list_sch.json()["schedules"])

            # Proteger horario asignado a un área contra eliminación
            r_area_tpl = client.post(
                "/api/areas",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "codigo": "AREA-TPL",
                    "nombre": "Área Temporal",
                    "horario_id": tpl_id
                },
                headers=headers
            )
            assert r_area_tpl.status_code == 200, r_area_tpl.text
            r_del_used = client.delete(f"/api/schedules/{tpl_id}", headers=headers)
            assert r_del_used.status_code == 400

            # Cambiar el área temporal a otro horario y ahora sí eliminar la plantilla
            area_tpl_id = next(
                a["id"] for a in client.get(f"/api/areas?empresa_id={emp_id}&sucursal_id={suc_id}", headers=headers).json()["areas"]
                if a["nombre"] == "Área Temporal"
            )
            client.delete(f"/api/areas/{area_tpl_id}", headers=headers)
            r_del_ok = client.delete(f"/api/schedules/{tpl_id}", headers=headers)
            assert r_del_ok.status_code == 200, r_del_ok.text
            print("OK 2: CRUD /api/schedules, validaciones 400 y protección de borrado")

            # 5. Escenario completo del usuario:
            # Lun(1)/Mié(3)/Vie(5): 08:00-11:00 y 15:00-18:00
            # Mar(2)/Jue(4): 13:00-18:00
            # Sáb(6)/Dom(7): Descanso
            user_blocks = [
                {"dia_semana": 1, "hora_entrada": "08:00", "hora_salida": "11:00"},
                {"dia_semana": 1, "hora_entrada": "15:00", "hora_salida": "18:00"},
                {"dia_semana": 2, "hora_entrada": "13:00", "hora_salida": "18:00"},
                {"dia_semana": 3, "hora_entrada": "08:00", "hora_salida": "11:00"},
                {"dia_semana": 3, "hora_entrada": "15:00", "hora_salida": "18:00"},
                {"dia_semana": 4, "hora_entrada": "13:00", "hora_salida": "18:00"},
                {"dia_semana": 5, "hora_entrada": "08:00", "hora_salida": "11:00"},
                {"dia_semana": 5, "hora_entrada": "15:00", "hora_salida": "18:00"},
            ]
            r_emp_mix = client.post(
                "/api/employees",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "codigo_empleado": "101",
                    "codigo_contpaqi": "101",
                    "nombre": "Usuario Mixto",
                    "area_nombre": "Administrativo",
                    "puesto": "Sistemas",
                    "horario_mode": "personalizado",
                    "horario_tolerancia_min": 10,
                    "horario_bloques": user_blocks
                },
                headers=headers
            )
            assert r_emp_mix.status_code == 200, r_emp_mix.text
            custom_hid = r_emp_mix.json()["horario_id"]
            assert custom_hid is not None

            # Empleado #102 en la misma área Administrativo heredando 08:00-17:00
            r_emp_area = client.post(
                "/api/employees",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "codigo_empleado": "102",
                    "codigo_contpaqi": "102",
                    "nombre": "Colaborador Área",
                    "area_nombre": "Administrativo",
                    "puesto": "Auxiliar",
                    "horario_mode": "area"
                },
                headers=headers
            )
            assert r_emp_area.status_code == 200, r_emp_area.text

            # Checadas de Prueba (Semana 1: 2026-10-05 al 2026-10-11, Semana 2: 2026-10-12 al 2026-10-18)
            def push(emp_code, ts_iso, nombre="Colaborador"):
                res = db.record_checkin(
                    serial_no=None,
                    emp_no=emp_code,
                    nombre=nombre,
                    tipo_evento="AccessControllerEvent",
                    sub_event_type=75,
                    fecha_hora=ts_iso,
                    reloj_nombre="Reloj Test",
                    empresa_id=emp_id,
                    sucursal_id=suc_id,
                    reloj_id=1
                )
                assert res["inserted"] and not res["es_rebote"], f"Checkin failed for {emp_code} @ {ts_iso}: {res}"

            # --- Semana 1 ---
            # Lunes 2026-10-05: 4 checadas puntuales -> 6.1h (NO 10.0h), 0 retardos, 0 incompletos
            for t in ("08:02:00", "11:01:00", "14:58:00", "18:03:00"):
                push("101", f"2026-10-05T{t}-06:00", "Usuario Mixto")

            # Martes 2026-10-06: 13:05, 18:00 -> PUNTUAL, 4.9h
            for t in ("13:05:00", "18:00:00"):
                push("101", f"2026-10-06T{t}-06:00", "Usuario Mixto")

            # Miércoles 2026-10-07: puntual en B1, retardo en B2 (15:25) -> 1 retardo (+25 min), 5.6h
            for t in ("08:00:00", "11:00:00", "15:25:00", "18:00:00"):
                push("101", f"2026-10-07T{t}-06:00", "Usuario Mixto")

            # Jueves 2026-10-08: puntual 13:00, 18:00 -> 5.0h
            for t in ("13:00:00", "18:00:00"):
                push("101", f"2026-10-08T{t}-06:00", "Usuario Mixto")

            # Viernes 2026-10-09: retardo en AMBOS bloques (08:20 y 15:25) -> 1 solo retardo, 45 min acumulados
            for t in ("08:20:00", "11:00:00", "15:25:00", "18:00:00"):
                push("101", f"2026-10-09T{t}-06:00", "Usuario Mixto")

            # --- Semana 2 ---
            # Lunes 2026-10-12: asistencia parcial solo tarde (15:02, 18:00) -> 0 retardos, 0 faltas, 0 incompletos, 3.0h
            for t in ("15:02:00", "18:00:00"):
                push("101", f"2026-10-12T{t}-06:00", "Usuario Mixto")

            # Martes 2026-10-13: puntual 13:00, 18:00 -> 5.0h
            for t in ("13:00:00", "18:00:00"):
                push("101", f"2026-10-13T{t}-06:00", "Usuario Mixto")

            # Miércoles 2026-10-14: olvido salida B1 (08:00, 15:00, 18:00) -> 1 incompleto, 0 retardos, 3.0h
            for t in ("08:00:00", "15:00:00", "18:00:00"):
                push("101", f"2026-10-14T{t}-06:00", "Usuario Mixto")

            # Jueves 2026-10-15: SIN checadas -> 1 falta

            # Viernes 2026-10-16: rebalanceo de frontera (08:00, 13:15, 15:00, 18:00) -> 0 incompletos, 0 retardos, 8.2h (8.25h reales) y 2.25h extra
            for t in ("08:00:00", "13:15:00", "15:00:00", "18:00:00"):
                push("101", f"2026-10-16T{t}-06:00", "Usuario Mixto")

            # Checadas de #102 (hereda 08:00-17:00 del área Administrativo)
            push("102", "2026-10-05T08:05:00-06:00", "Colaborador Área")
            push("102", "2026-10-05T17:05:00-06:00", "Colaborador Área")
            push("102", "2026-10-06T13:05:00-06:00", "Colaborador Área")
            push("102", "2026-10-06T18:00:00-06:00", "Colaborador Área")

            # Verificar list_checadas() para 2026-10-07 15:25:00
            live_recs = db.list_checadas(limit=100, empresa_id=emp_id, sucursal_id=suc_id)
            wed_b2_in = next(
                r for r in live_recs
                if r["codigo_empleado"] == "101" and r["fecha_hora_display"] == "2026-10-07 15:25:00"
            )
            assert wed_b2_in["estatus_prenomina"] == "RETARDO (+25 min)", wed_b2_in

            # Verificar Reporte Pre-Nómina
            rep = db.get_report_dataset(
                report_type="empleados",
                start_date="2026-10-05",
                end_date="2026-10-18",
                empresa_id=emp_id,
                sucursal_id=suc_id
            )
            row_101 = next(r for r in rep["data"] if r["codigo_empleado"] == "101")
            row_102 = next(r for r in rep["data"] if r["codigo_empleado"] == "102")

            assert row_101["horario_origen"] == "PERSONALIZADO"
            assert row_101["retardos"] == 2, f"Expected 2 retardos (Wed + Fri single), got {row_101['retardos']}"
            assert row_101["minutos_retardo_total"] == 70, f"Expected 25 + 45 = 70 min, got {row_101['minutos_retardo_total']}"
            assert row_101["dias_incompletos"] == 1, f"Expected 1 incompleto (Wed W2), got {row_101['dias_incompletos']}"
            assert row_101["faltas"] == 1, f"Expected 1 falta (Thu 2026-10-15, Sat/Sun=0), got {row_101['faltas']}"

            days_101 = {d["fecha"]: d for d in row_101["dias_detalle"]}
            assert days_101["2026-10-05"]["horas"] == 6.1 and not days_101["2026-10-05"]["es_retardo"] and not days_101["2026-10-05"]["es_incompleto"]
            assert days_101["2026-10-06"]["horas"] == 4.9 and not days_101["2026-10-06"]["es_retardo"]
            assert days_101["2026-10-07"]["horas"] == 5.6 and days_101["2026-10-07"]["es_retardo"] and days_101["2026-10-07"]["minutos_retardo"] == 25
            assert days_101["2026-10-09"]["es_retardo"] and days_101["2026-10-09"]["minutos_retardo"] == 45
            assert days_101["2026-10-12"]["horas"] == 3.0 and not days_101["2026-10-12"]["es_retardo"] and not days_101["2026-10-12"]["es_incompleto"]
            assert days_101["2026-10-14"]["horas"] == 3.0 and not days_101["2026-10-14"]["es_retardo"] and days_101["2026-10-14"]["es_incompleto"]
            assert days_101["2026-10-16"]["horas"] == round(8.25, 1) and not days_101["2026-10-16"]["es_retardo"] and not days_101["2026-10-16"]["es_incompleto"]
            assert len(days_101["2026-10-16"]["bloques_detalle"]) == 2
            assert days_101["2026-10-16"]["bloques_detalle"][0]["salida"] == "13:15:00"
            assert days_101["2026-10-16"]["bloques_detalle"][1]["entrada"] == "15:00:00"

            # Verificar herencia de área para #102
            assert row_102["horario_origen"] == "AREA"
            assert row_102["retardos"] == 1, f"Expected #102 1 retardo on Tue 13:05 vs 08:00, got {row_102['retardos']}"
            days_102 = {d["fecha"]: d for d in row_102["dias_detalle"]}
            assert days_102["2026-10-05"]["horas"] == 9.0 and not days_102["2026-10-05"]["es_retardo"]
            assert days_102["2026-10-06"]["es_retardo"]
            print("OK 3: Evaluación multi-bloque, reglas 1 y 2, rebalanceo y herencia de área")

            # 6. Verificar CONTPAQi (.txt)
            txt = db.generate_contpaqi_txt(
                empresa_id=emp_id,
                sucursal_id=suc_id,
                start_date="2026-10-05",
                end_date="2026-10-18"
            )
            lines = txt.splitlines()
            # Extraer líneas de detalle de #101 (hasta antes del maestro de #102)
            idx_101 = next(i for i, ln in enumerate(lines) if ln.startswith("E") and "101" in ln[:20])
            idx_102 = next(i for i, ln in enumerate(lines) if ln.startswith("E") and "102" in ln[:20])
            det_101 = lines[idx_101 + 1:idx_102]

            fri_retardos = [ln for ln in det_101 if "Retardos" in ln and "09/10/2026" in ln]
            wed_retardos = [ln for ln in det_101 if "Retardos" in ln and "07/10/2026" in ln]
            thu_faltas = [ln for ln in det_101 if "Faltas injustificadas" in ln and "15/10/2026" in ln]
            mon_partial_faltas = [ln for ln in det_101 if "Faltas injustificadas" in ln and "12/10/2026" in ln]
            weekend_faltas = [ln for ln in det_101 if "Faltas injustificadas" in ln and ("10/10/2026" in ln or "11/10/2026" in ln or "17/10/2026" in ln or "18/10/2026" in ln)]
            fri_extras = [ln for ln in det_101 if "Horas extras dobles" in ln and "16/10/2026" in ln]

            assert len(fri_retardos) == 1, f"Viernes debe emitir exactamente 1 retardo: {fri_retardos}"
            assert len(wed_retardos) == 1, f"Miércoles debe emitir 1 retardo: {wed_retardos}"
            assert len(thu_faltas) == 1, f"Jueves 15 debe emitir 1 falta: {thu_faltas}"
            assert len(mon_partial_faltas) == 0, f"Lunes parcial no debe emitir falta: {mon_partial_faltas}"
            assert len(weekend_faltas) == 0, f"Fines de semana no deben emitir falta: {weekend_faltas}"
            assert len(fri_extras) == 1 and "2.25" in fri_extras[0], f"Viernes 16 debe emitir 2.25h extras: {fri_extras}"
            print("OK 4: Exportación CONTPAQi (.txt) exacta con retardos únicos, faltas y horas extra")

            # 7. Verificar desvinculación y limpieza de horario personalizado huérfano al volver a heredar del área
            r_revert = client.post(
                "/api/employees",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "codigo_empleado": "101",
                    "nombre": "Usuario Mixto",
                    "area_nombre": "Administrativo",
                    "horario_mode": "area"
                },
                headers=headers
            )
            assert r_revert.status_code == 200, r_revert.text
            conn = db.get_conn()
            orphan_h = conn.execute("SELECT id FROM horarios WHERE id = ?", (custom_hid,)).fetchone()
            orphan_b = conn.execute("SELECT id FROM horario_bloques WHERE horario_id = ?", (custom_hid,)).fetchall()
            conn.close()
            assert orphan_h is None and len(orphan_b) == 0, "El horario personalizado huérfano no fue limpiado"
            print("OK 5: Limpieza de horario personalizado huérfano al volver a Heredar del Área")

            # 8. Verificar CSV template + import con columna horario_nombre
            r_tpl2 = client.post(
                "/api/schedules",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_id,
                    "nombre": "Medio Tiempo Tarde",
                    "tolerancia_min": 5,
                    "bloques": [{"dia_semana": d, "hora_entrada": "13:00", "hora_salida": "18:00"} for d in (1, 2, 3, 4, 5)]
                },
                headers=headers
            )
            assert r_tpl2.status_code == 200
            csv_body = (
                "codigo_empleado,nombre,codigo_contpaqi,area_nombre,puesto,turno,horario_nombre\r\n"
                "101,Usuario Mixto,101,Administrativo,Sistemas,Tarde,Medio Tiempo Tarde\r\n"
            )
            r_imp = client.post(
                "/api/employees/import-csv",
                json={"empresa_id": emp_id, "sucursal_id": suc_id, "csv_content": csv_body},
                headers=headers
            )
            assert r_imp.status_code == 200, r_imp.text
            r_csv_dl = client.get(f"/api/employees/template-csv?empresa_id={emp_id}&sucursal_id={suc_id}", headers=headers)
            assert r_csv_dl.status_code == 200
            csv_text = r_csv_dl.content.decode("utf-8-sig")
            assert "horario_nombre" in csv_text.splitlines()[0]
            assert "Medio Tiempo Tarde" in csv_text
            print("OK 6: CSV template e importación de horario_nombre")

            # 9. OK 7: Sucursal nueva crea 'Horario Matutino' por defecto y protege contra eliminar el único horario
            r_br2 = client.post(
                "/api/branches",
                json={"empresa_id": emp_id, "nombre": "Sucursal Norte"},
                headers=headers
            )
            assert r_br2.status_code == 200, r_br2.text
            suc2_id = r_br2.json()["branch"]["id"]

            r_sch2 = client.get(f"/api/schedules?empresa_id={emp_id}&sucursal_id={suc2_id}", headers=headers)
            assert r_sch2.status_code == 200
            sch2_list = r_sch2.json()["schedules"]
            assert len(sch2_list) == 1
            mat_sched = sch2_list[0]
            assert mat_sched["nombre"] == "Horario Matutino"
            assert mat_sched["resumen_corto"] == "08:00 - 17:00"
            assert mat_sched["dias_laborales"] == "1,2,3,4,5"

            areas_br2 = client.get(f"/api/areas?empresa_id={emp_id}&sucursal_id={suc2_id}", headers=headers).json()["areas"]
            assert len(areas_br2) == 1 and areas_br2[0]["horario_id"] == mat_sched["id"]
            r_del_area_br2 = client.delete(f"/api/areas/{areas_br2[0]['id']}", headers=headers)
            assert r_del_area_br2.status_code == 200

            r_del_last = client.delete(f"/api/schedules/{mat_sched['id']}", headers=headers)
            assert r_del_last.status_code == 400, f"Debió bloquear borrado del único horario: {r_del_last.text}"
            print("OK 7: Sucursal nueva inicia con Horario Matutino y nunca puede quedar con 0 horarios")

            # 10. OK 8: Crear área nueva enviando solo nombre asigna automáticamente Horario Matutino por defecto
            r_ventas = client.post(
                "/api/areas",
                json={"empresa_id": emp_id, "sucursal_id": suc2_id, "nombre": "Ventas"},
                headers=headers
            )
            assert r_ventas.status_code == 200, r_ventas.text
            ventas_area = next(
                a for a in client.get(f"/api/areas?empresa_id={emp_id}&sucursal_id={suc2_id}", headers=headers).json()["areas"]
                if a["nombre"] == "Ventas"
            )
            assert ventas_area["horario_id"] == mat_sched["id"]
            assert ventas_area["horario_nombre"] == "Horario Matutino"
            assert ventas_area["horario"] == "08:00 - 17:00"
            print("OK 8: Área creada sin horario explícito hereda automáticamente Horario Matutino")

            # 11. OK 9: Área con horario_id roto (999999) es reparada por init_db()
            conn = db.get_conn()
            conn.execute("UPDATE areas SET horario_id = 999999 WHERE id = ?", (ventas_area["id"],))
            conn.commit()
            conn.close()

            db.init_db()
            conn = db.get_conn()
            repaired_row = conn.execute("SELECT horario_id, horario FROM areas WHERE id = ?", (ventas_area["id"],)).fetchone()
            conn.close()
            assert repaired_row["horario_id"] == mat_sched["id"], f"No se reparó área rota: {dict(repaired_row)}"
            assert repaired_row["horario"] == "08:00 - 17:00"
            print("OK 9: Área con horario_id roto reparada automáticamente por init_db()")

            # 12. OK 10: Colaborador con área inexistente resuelve al Horario Matutino (DEFAULT)
            r_emp_def = client.post(
                "/api/employees",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc2_id,
                    "codigo_empleado": "201",
                    "nombre": "Colaborador Sin Área",
                    "area_nombre": "Área Inexistente",
                    "horario_mode": "area"
                },
                headers=headers
            )
            assert r_emp_def.status_code == 200, r_emp_def.text
            emps_br2 = client.get(f"/api/employees?empresa_id={emp_id}&sucursal_id={suc2_id}", headers=headers).json()["employees"]
            emp_201 = next(e for e in emps_br2 if e["codigo_empleado"] == "201")
            assert emp_201["horario_origen"] == "DEFAULT", emp_201
            assert emp_201["horario_nombre"] == "Horario Matutino"

            db.record_checkin(None, "201", "Colaborador Sin Área", "AccessControllerEvent", 75, "2026-10-05T08:25:00-06:00", "Reloj Norte", empresa_id=emp_id, sucursal_id=suc2_id, reloj_id=1)
            db.record_checkin(None, "201", "Colaborador Sin Área", "AccessControllerEvent", 75, "2026-10-05T17:00:00-06:00", "Reloj Norte", empresa_id=emp_id, sucursal_id=suc2_id, reloj_id=1)

            rep_br2 = db.get_report_dataset(
                report_type="empleados",
                start_date="2026-10-05",
                end_date="2026-10-05",
                empresa_id=emp_id,
                sucursal_id=suc2_id
            )
            row_201 = next(r for r in rep_br2["data"] if r["codigo_empleado"] == "201")
            assert row_201["horario_origen"] == "DEFAULT"
            assert row_201["retardos"] == 1 and row_201["minutos_retardo_total"] == 25
            assert row_201["horas_trabajadas"] == 8.6
            print("OK 10: Colaborador con área inexistente usa Horario Matutino por defecto en Pre-Nómina")

            print("\n=== TODAS LAS PRUEBAS DE HORARIOS MIXTOS PASARON (100%) ===")
        finally:
            db.DB_FILE = orig_db_file


if __name__ == "__main__":
    run_tests()
