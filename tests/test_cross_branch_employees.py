"""
Pruebas de Integración: Empleados por Empresa con Sucursal Base y Cruce Multi-Sucursal
Verifica:
  1. Migración/deduplicación idempotente de empleados duplicados por (empresa_id, codigo_empleado).
  2. Auto-descubrimiento único por empresa (checar en segunda sucursal no duplica empleado, fusiona biometrías).
  3. Anti-rebote multi-sucursal (<180s entre terminales de distinta sucursal).
  4. Resolución de horario propio/área de la sucursal base cuando se consulta bitácora/monitor de otra sucursal.
  5. Cruce completo de jornada en Pre-Nómina (entrada en Sucursal A + salida en Sucursal B) y CONTPAQi (.txt).
  6. Cambio de Sucursal Base vía POST /api/employees y CSV con columna `sucursal_base`, y `overview` multi-sucursal.
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
import core.database as db
import main


def run_tests():
    orig_db_file = db.DB_FILE
    with tempfile.TemporaryDirectory() as tmpdir:
        temp_db = Path(tmpdir) / "test_cross_branch.db"
        db.DB_FILE = temp_db
        try:
            db.init_db()
            client = TestClient(main.app)

            # 1. Autenticarse como CLIENTE_RH y crear empresa con 2 sucursales: Matriz y Norte
            r_login = client.post("/api/auth/login", json={"username": "rh.demo", "password": "quodo123"})
            assert r_login.status_code == 200, r_login.text
            headers = {"Authorization": f"Bearer {r_login.json()['token']}"}

            r_comp = client.post(
                "/api/companies",
                json={"nombre": "Empresa Demo MultiSucursal", "sucursal_inicial": "Matriz"},
                headers=headers
            )
            assert r_comp.status_code == 200, r_comp.text
            emp_id = r_comp.json()["company"]["empresa_id"]
            suc_matriz = r_comp.json()["company"]["sucursal_id"]

            r_br2 = client.post(
                "/api/branches",
                json={"empresa_id": emp_id, "nombre": "Norte"},
                headers=headers
            )
            assert r_br2.status_code == 200, r_br2.text
            suc_norte = r_br2.json()["branch"]["id"]

            # Crear área en Matriz con horario 08:00 - 17:00, tol 10 min
            r_area = client.post(
                "/api/areas",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_matriz,
                    "codigo": "AREA-TI",
                    "nombre": "Administrativo",
                    "turno": "Matutino",
                    "horario": "08:00 - 17:00",
                    "tolerancia_min": 10,
                    "dias_laborales": "1,2,3,4,5"
                },
                headers=headers
            )
            assert r_area.status_code == 200, r_area.text

            # Registrar relojes en ambas sucursales
            r_clk1 = client.post(
                "/api/devices",
                json={"empresa_id": emp_id, "sucursal_id": suc_matriz, "nombre": "Reloj Matriz", "marca": "ZKTECO", "serie": "ZK-MAT-01"},
                headers=headers
            )
            assert r_clk1.status_code == 200, r_clk1.text
            clk_matriz_id = r_clk1.json()["id"]

            r_clk2 = client.post(
                "/api/devices",
                json={"empresa_id": emp_id, "sucursal_id": suc_norte, "nombre": "Reloj Norte", "marca": "HIKVISION"},
                headers=headers
            )
            assert r_clk2.status_code == 200, r_clk2.text
            clk_norte_id = r_clk2.json()["id"]

            # 2. Auto-descubrimiento en Matriz con huella (ZKTeco) -> Base Branch = Matriz
            res1 = db.record_checkin(
                None, "120020", "Empleado #120020", "ZKTecoADMS", 38,
                "2026-11-16T08:05:00-06:00", "Reloj Matriz",
                empresa_id=emp_id, sucursal_id=suc_matriz, reloj_id=clk_matriz_id
            )
            assert res1["inserted"] and not res1["es_rebote"]

            # Asignar área Administrativo y nombre real al colaborador
            r_upd = client.post(
                "/api/employees",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_matriz,
                    "codigo_empleado": "120020",
                    "nombre": "Colaborador Demo",
                    "area_nombre": "Administrativo",
                    "horario_mode": "area"
                },
                headers=headers
            )
            assert r_upd.status_code == 200, r_upd.text

            # 3. Checada en Norte con rostro (Hikvision) -> NO debe duplicar empleado, debe fusionar rostro=1
            res2 = db.record_checkin(
                None, "120020", "Colaborador Demo", "AccessControllerEvent", 75,
                "2026-11-16T17:05:00-06:00", "Reloj Norte",
                empresa_id=emp_id, sucursal_id=suc_norte, reloj_id=clk_norte_id
            )
            assert res2["inserted"] and not res2["es_rebote"]

            # Anti-rebote cross-sucursal: si intenta checar en Matriz 30s después de Norte -> es_rebote=True
            res_bounce = db.record_checkin(
                None, "120020", "Colaborador Demo", "ZKTecoADMS", 38,
                "2026-11-16T17:05:30-06:00", "Reloj Matriz",
                empresa_id=emp_id, sucursal_id=suc_matriz, reloj_id=clk_matriz_id
            )
            assert res_bounce["inserted"] and res_bounce["es_rebote"]

            conn = db.get_conn()
            emps = conn.execute(
                "SELECT * FROM empleados WHERE empresa_id = ? AND codigo_empleado = '120020'",
                (emp_id,)
            ).fetchall()
            conn.close()
            assert len(emps) == 1, f"Se esperaba 1 solo empleado en la empresa, hay {len(emps)}"
            assert emps[0]["sucursal_id"] == suc_matriz
            assert emps[0]["tiene_huella"] == 1 and emps[0]["tiene_rostro"] == 1
            print("OK 1: Empleado único por empresa + fusión biométrica + anti-rebote cross-sucursal")

            # 4. Monitor / Bitácora en Norte debe evaluar la checada de las 17:05 como SALIDA / REGISTRO (cruzada con 08:05 en Matriz)
            recs_norte = db.list_checadas(limit=20, empresa_id=emp_id, sucursal_id=suc_norte)
            punch_1705 = next(r for r in recs_norte if r["codigo_empleado"] == "120020")
            assert punch_1705["estatus_prenomina"] == "SALIDA / REGISTRO", punch_1705
            assert punch_1705["sucursal_nombre"] == "Norte"
            print("OK 2: Monitor en sucursal secundaria evalúa jornada cruzada con sucursal base")

            # 5. Pre-Nómina (Todas las sucursales = 0 y Sucursal Base = Matriz) cruza entrada Matriz + salida Norte sin duplicar
            for q_suc in (0, suc_matriz):
                r_rep = client.get(
                    f"/api/reports/query?type=empleados&start_date=2026-11-16&end_date=2026-11-16&empresa_id={emp_id}&sucursal_id={q_suc}",
                    headers=headers
                )
                assert r_rep.status_code == 200, r_rep.text
                rows_120 = [r for r in r_rep.json()["report"]["data"] if r["codigo_empleado"] == "120020"]
                assert len(rows_120) == 1, f"No debe duplicarse para sucursal_id={q_suc}: {rows_120}"
                row = rows_120[0]
                assert row["sucursal_base_nombre"] == "Matriz"
                assert row["horas_trabajadas"] == 9.0, row
                assert row["dias_incompletos"] == 0 and row["retardos"] == 0, row
                assert row["dias_detalle"][0]["reloj"] == "Reloj Matriz → Reloj Norte", row["dias_detalle"][0]

            # CONTPAQi no debe generar falta ni retardo porque el día tiene entrada en Matriz y salida en Norte
            r_txt = client.get(
                f"/api/reports/export-contpaqi?empresa_id={emp_id}&sucursal_id=0&start_date=2026-11-16&end_date=2026-11-16",
                headers=headers
            )
            assert r_txt.status_code == 200 and r_txt.text.strip() == "", f"No debió emitir incidencias: {r_txt.text}"
            print("OK 3: Pre-Nómina (empresa completa y sucursal base) y CONTPAQi cruzan checadas sin duplicar")

            # 6. Overview (con sucursal_id=0 y específica) y /api/employees?all_branches=true
            r_ov_all = client.get(f"/api/dashboard/overview?empresa_id={emp_id}&sucursal_id=0", headers=headers)
            assert r_ov_all.status_code == 200 and r_ov_all.json()["active_sucursal_id"] == 0
            assert len(r_ov_all.json()["devices"]) == 2

            r_ov = client.get(f"/api/dashboard/overview?empresa_id={emp_id}&sucursal_id={suc_norte}", headers=headers)
            assert r_ov.status_code == 200, r_ov.text
            ov = r_ov.json()
            assert any(e["codigo_empleado"] == "120020" and e["sucursal_base_nombre"] == "Matriz" for e in ov["company_employees"])
            assert len(ov["company_devices"]) == 2

            # Cambiar sucursal base vía POST /api/employees y luego restaurar vía CSV `sucursal_base`
            r_move = client.post(
                "/api/employees",
                json={
                    "empresa_id": emp_id,
                    "sucursal_id": suc_norte,
                    "codigo_empleado": "120020",
                    "nombre": "Colaborador Demo",
                    "area_nombre": "Administrativo",
                    "horario_mode": "area"
                },
                headers=headers
            )
            assert r_move.status_code == 200 and r_move.json()["sucursal_id"] == suc_norte

            csv_body = (
                "codigo_empleado,nombre,codigo_contpaqi,area_nombre,puesto,turno,horario_nombre,sucursal_base\r\n"
                "120020,Colaborador Demo,120020,Administrativo,Sistemas,Matutino,,Matriz\r\n"
            )
            r_csv = client.post(
                "/api/employees/import-csv",
                json={"empresa_id": emp_id, "sucursal_id": 0, "csv_content": csv_body},
                headers=headers
            )
            assert r_csv.status_code == 200, r_csv.text
            r_all_emps = client.get(f"/api/employees?empresa_id={emp_id}&all_branches=true", headers=headers)
            assert r_all_emps.status_code == 200
            e120 = next(e for e in r_all_emps.json()["employees"] if e["codigo_empleado"] == "120020")
            assert e120["sucursal_id"] == suc_matriz and e120["sucursal_base_nombre"] == "Matriz"
            print("OK 4: Reasignación de Sucursal Base por API y CSV + overview multi-sucursal (sucursal_id=0)")

            # 7. Verificar deduplicación automática de init_db() conservando primer registro histórico
            conn = db.get_conn()
            cur = conn.cursor()
            cur.execute("DROP INDEX IF EXISTS ux_empleados_empresa_codigo")
            cur.execute("""
                INSERT INTO empleados (empresa_id, sucursal_id, codigo_empleado, nombre, area_nombre, tiene_huella, tiene_rostro)
                VALUES (?, ?, '9999', 'Empleado #9999', 'General', 1, 0)
            """, (emp_id, suc_norte))
            cur.execute("""
                INSERT INTO empleados (empresa_id, sucursal_id, codigo_empleado, nombre, area_nombre, tiene_huella, tiene_rostro)
                VALUES (?, ?, '9999', 'Maria Lopez', 'Administrativo', 0, 1)
            """, (emp_id, suc_matriz))
            conn.commit()
            conn.close()

            db.init_db()
            conn = db.get_conn()
            dedup = conn.execute(
                "SELECT * FROM empleados WHERE empresa_id = ? AND codigo_empleado = '9999'",
                (emp_id,)
            ).fetchall()
            conn.close()
            assert len(dedup) == 1
            assert dedup[0]["nombre"] == "Maria Lopez" and dedup[0]["sucursal_id"] == suc_norte
            assert dedup[0]["tiene_huella"] == 1 and dedup[0]["tiene_rostro"] == 1
            print("OK 5: Deduplicación automática idempotente en init_db() (conserva primer registro histórico)")

            print("\n=== TODAS LAS PRUEBAS MULTI-SUCURSAL PASARON (100%) ===")
        finally:
            db.DB_FILE = orig_db_file


if __name__ == "__main__":
    run_tests()
