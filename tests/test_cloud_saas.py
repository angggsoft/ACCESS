"""
Pruebas de Integración: ACCESS Cloud SaaS (Multi-Empresa, TOTP 5 min, Roles y One-Way Push)
"""
from fastapi.testclient import TestClient
import main
import core.database as db

client = TestClient(main.app)


def run_tests():
    # 1. Admin SaaS login & strict privacy block (403 on company data)
    r_admin = client.post("/api/auth/login", json={"email": "admin@access.com", "password": "admin123"})
    assert r_admin.status_code == 200, r_admin.text
    admin_tok = r_admin.json()["token"]
    headers_admin = {"Authorization": f"Bearer {admin_tok}"}

    r_admin_users = client.get("/api/admin/users", headers=headers_admin)
    assert r_admin_users.status_code == 200
    print("1. Admin SaaS /api/admin/users OK:", r_admin_users.json()["kpis"])

    for confidential_url in ["/api/dashboard/overview", "/api/companies", "/api/devices", "/api/employees", "/api/attendance/records"]:
        r_blk = client.get(confidential_url, headers=headers_admin)
        assert r_blk.status_code == 403, f"Expected 403 on {confidential_url}, got {r_blk.status_code}"
    print("2. Admin SaaS blocked (403) on all confidential company routes.")

    # 2. Expired RH user block (402)
    r_exp = client.post("/api/auth/login", json={"email": "vencido@empresa.com", "password": "123456"})
    assert r_exp.status_code == 200
    exp_tok = r_exp.json()["token"]
    r_exp_dash = client.get("/api/dashboard/overview", headers={"Authorization": f"Bearer {exp_tok}"})
    assert r_exp_dash.status_code == 402
    print("3. Expired RH user blocked (402):", r_exp_dash.json()["detail"])

    # 3. Owner RH user & 5-minute Dynamic Invitation Key (TOTP)
    r_owner = client.post("/api/auth/login", json={"email": "angel.flores@quodo.mx", "password": "123456"})
    assert r_owner.status_code == 200
    owner_tok = r_owner.json()["token"]
    h_owner = {"Authorization": f"Bearer {owner_tok}"}

    # Verify RH user cannot access /api/admin/users
    r_rh_admin = client.get("/api/admin/users", headers=h_owner)
    assert r_rh_admin.status_code == 403

    r_totp = client.get("/api/companies/2/invite-totp", headers=h_owner)
    assert r_totp.status_code == 200
    inv = r_totp.json()["invitation"]
    print("4. Company #2 TOTP generated:", inv["codigo_invitacion"], "Key:", inv["clave_dinamica"], "Expires in:", inv["expires_in_seconds"], "s")

    # 4. Second RH user joining Company #2 with Dynamic Key
    r_areli = client.post("/api/auth/login", json={"email": "areli.martinez@quodo.mx", "password": "admin123"})
    areli_tok = r_areli.json()["token"]
    h_areli = {"Authorization": f"Bearer {areli_tok}"}

    r_bad_join = client.post(
        "/api/companies/join",
        json={"codigo_invitacion": inv["codigo_invitacion"], "clave_dinamica": "000000"},
        headers=h_areli
    )
    assert r_bad_join.status_code == 400
    print("5. Invalid TOTP key rejected:", r_bad_join.json()["detail"])

    r_good_join = client.post(
        "/api/companies/join",
        json={"codigo_invitacion": inv["codigo_invitacion"], "clave_dinamica": inv["clave_dinamica"]},
        headers=h_areli
    )
    assert r_good_join.status_code == 200
    print("6. Valid 5-min TOTP key accepted:", r_good_join.json()["message"])

    # 5. One-Way Push Webhook with Auto-Discovery of new employee
    xml_push = """<?xml version="1.0" encoding="UTF-8"?>
<EventNotificationAlert>
  <eventType>AccessControllerEvent</eventType>
  <AccessControllerEvent>
    <majorEventType>5</majorEventType>
    <subEventType>75</subEventType>
    <employeeNoString>999</employeeNoString>
    <name>Colaborador Enrolado En Reloj</name>
    <serialNo>54321</serialNo>
  </AccessControllerEvent>
</EventNotificationAlert>"""
    r_wh = client.post(
        "/api/v1/webhooks/hikvision/hik_cerrogordo_01",
        content=xml_push.encode("utf-8"),
        headers={"Content-Type": "application/xml"}
    )
    assert r_wh.status_code == 200
    print("7. One-Way Push Webhook & Employee Auto-Discovery OK:", r_wh.json())


if __name__ == "__main__":
    run_tests()
