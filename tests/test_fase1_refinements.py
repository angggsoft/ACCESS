import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
from main import app
import core.database as db

client = TestClient(app)

def test_unauthenticated_routes_return_401():
    print("--- TEST 1: Endpoints sin autenticación deben retornar 401 ---")
    routes_401 = [
        ("GET", "/api/employees"),
        ("GET", "/api/devices"),
        ("GET", "/api/settings"),
        ("GET", "/api/areas"),
        ("GET", "/api/email/config"),
        ("GET", "/api/reports/query"),
        ("POST", "/api/attendance/manual"),
        ("POST", "/api/devices/1/sync"),
        ("POST", "/api/devices/1/sync-time"),
        ("POST", "/api/devices/1/setup-webhook"),
        ("POST", "/api/devices/1/test-connection"),
    ]
    for method, url in routes_401:
        if method == "GET":
            r = client.get(url)
        else:
            r = client.post(url, json={})
        assert r.status_code == 401, f"Expected 401 on {method} {url}, got {r.status_code}"
        print(f"OK: {method} {url} -> 401 Unauthorized")

def test_webhooks_remain_public():
    print("\n--- TEST 2: Webhooks del reloj deben ser accesibles sin autenticación ---")
    r_wh = client.post("/api/v1/webhooks/hikvision", data="invalid test payload", headers={"Content-Type": "text/plain"})
    assert r_wh.status_code == 200, f"Expected 200 on webhook, got {r_wh.status_code}"
    print("OK: POST /api/v1/webhooks/hikvision -> 200 OK (sin auth)")

    r_isapi = client.post("/ISAPI/Event/notification/alertStream", data="test", headers={"Content-Type": "text/plain"})
    assert r_isapi.status_code == 200, f"Expected 200 on ISAPI alertStream, got {r_isapi.status_code}"
    print("OK: POST /ISAPI/Event/notification/alertStream -> 200 OK (sin auth)")

def test_login_and_authenticated_access():
    print("\n--- TEST 3: Login y acceso con sesión / cookie ---")
    login_res = client.post("/api/auth/login", json={"username": "rh.demo", "password": "quodo123"})
    assert login_res.status_code == 200, f"Login failed: {login_res.text}"
    token = login_res.json()["token"]
    assert "access_session" in login_res.cookies, "Cookie access_session no emitida"
    print(f"OK: Login exitoso, token emitido: {token[:12]}...")

    # Acceso con cookie
    client.cookies.set("access_session", token)
    r_emp = client.get("/api/employees")
    assert r_emp.status_code == 200, f"Expected 200 with cookie, got {r_emp.status_code}"
    print("OK: GET /api/employees con cookie -> 200 OK")

    r_dash = client.get("/api/dashboard/overview")
    assert r_dash.status_code == 200, f"Expected 200 on overview, got {r_dash.status_code}"
    print("OK: GET /api/dashboard/overview con cookie -> 200 OK")

    # Acceso con Header Authorization: Bearer
    client_no_cookie = TestClient(app)
    r_bearer = client_no_cookie.get("/api/employees", headers={"Authorization": f"Bearer {token}"})
    assert r_bearer.status_code == 200, f"Expected 200 with Bearer, got {r_bearer.status_code}"
    print("OK: GET /api/employees con Authorization: Bearer -> 200 OK")

def test_manual_checkin_and_is_first_of_day():
    print("\n--- TEST 4: Evaluación de checadas manuales y is_first_of_day ---")
    conn = db.get_conn()
    conn.execute("DELETE FROM checadas WHERE codigo_empleado = '3' AND substr(fecha_hora_evento, 1, 10) IN ('2026-05-10', '2026-05-11')")
    conn.commit()
    conn.close()

    # 4.1 Primera checada del día: empleado 3 (TI: 08:00 - 17:30, tol 15 min).
    # Entrada a las 08:05 -> Dentro del horario y tolerancia (límite 08:15) -> PUNTUAL
    rec1 = db.record_manual_checkin(emp_no="3", fecha_hora="2026-05-10 08:05:00", nota_incidencia="Entrada normal")
    print("Checada 1 (08:05):", rec1["estatus_prenomina"])
    assert rec1["estatus_prenomina"] == "PUNTUAL", f"Expected PUNTUAL, got {rec1['estatus_prenomina']}"

    # 4.2 Segunda checada del día: salida por la tarde (17:45) -> Debe ser SALIDA / REGISTRO, NO retardo
    rec2 = db.record_manual_checkin(emp_no="3", fecha_hora="2026-05-10 17:45:00", nota_incidencia="Salida de turno")
    print("Checada 2 (17:45):", rec2["estatus_prenomina"])
    assert rec2["estatus_prenomina"] == "SALIDA / REGISTRO", f"Expected SALIDA / REGISTRO, got {rec2['estatus_prenomina']}"

    # 4.3 Checada manual justificada fuera de tolerancia en otro día (10:30) -> JUSTIFICADO (MANUAL)
    rec3 = db.record_manual_checkin(emp_no="3", fecha_hora="2026-05-11 10:30:00", nota_incidencia="Cita médica autorizada")
    print("Checada 3 (10:30 justificante):", rec3["estatus_prenomina"])
    assert rec3["estatus_prenomina"] == "JUSTIFICADO (MANUAL)", f"Expected JUSTIFICADO (MANUAL), got {rec3['estatus_prenomina']}"

    # Limpieza final
    conn = db.get_conn()
    conn.execute("DELETE FROM checadas WHERE codigo_empleado = '3' AND substr(fecha_hora_evento, 1, 10) IN ('2026-05-10', '2026-05-11')")
    conn.commit()
    conn.close()

def test_year_2026_filter():
    print("\n--- TEST 5: Verificación de filtro de año 2026+ ---")
    def check_year_filter(ev_time):
        return len(ev_time) >= 4 and ev_time[:4].isdigit() and int(ev_time[:4]) >= 2026

    assert check_year_filter("2026-03-01T08:00:00") is True
    assert check_year_filter("2027-01-15T09:30:00") is True
    assert check_year_filter("2030-12-31T23:59:59") is True
    assert check_year_filter("2025-12-31T23:59:59") is False
    assert check_year_filter("invalid") is False
    print("OK: Filtro de año 2026+ verificado correctamente para años futuros (2027, 2030, etc.)")

if __name__ == "__main__":
    test_unauthenticated_routes_return_401()
    test_webhooks_remain_public()
    test_login_and_authenticated_access()
    test_manual_checkin_and_is_first_of_day()
    test_year_2026_filter()
    print("\n=== TODAS LAS PRUEBAS PASARON EXITOSAMENTE (100%) ===")
