"""
Extracción de Historial de Checadas para Recuperación Offline
Protocolo ISAPI - Hikvision DS-K1T320MFWX-B
Endpoint: POST /ISAPI/AccessControl/AcsEvent?format=json
"""

import sys
import json
import argparse
import requests
from requests.auth import HTTPDigestAuth
import config

# Mapeo de códigos de eventos menores más comunes en terminales Hikvision (Major = 5: Control de Acceso)
HIK_MINOR_EVENT_MAP = {
    0: "Todos los eventos menores",
    1: "Autenticación por tarjeta exitosa",
    2: "Tarjeta inválida / no registrada",
    3: "Tarjeta y contraseña exitosa",
    4: "Tarjeta y contraseña fallida",
    9: "Apertura por botón / clave",
    15: "Alarma de coacción",
    21: "Acceso concedido / Cerrojo abierto",
    22: "Cerrojo asegurado / Puerta cerrada",
    25: "Compuerta/Puerta abierta",
    26: "Compuerta/Puerta cerrada",
    38: "Huella dactilar válida (Acceso permitido)",
    39: "Huella dactilar inválida",
    40: "Tarjeta + Huella válida",
    41: "Tarjeta + Huella fallida",
    75: "Reconocimiento facial exitoso (Acceso permitido)",
    76: "Reconocimiento facial fallido",
    77: "Rostro + Contraseña exitoso",
    78: "Rostro + Tarjeta exitoso",
    79: "Rostro + Huella exitoso",
    96: "Límite máximo de personas",
    104: "Autenticación biométrica / Rostro vivo",
    117: "Fallo de detección rostro vivo (Antispoofing)",
    151: "Detección presencia humana / Sensor IR",
    181: "Autenticación por contraseña/PIN exitosa",
}


def parse_event_list(raw_info_list):
    """Normaliza la lista de eventos recibida (objeto individual o lista)."""
    if isinstance(raw_info_list, dict):
        return [raw_info_list]
    elif isinstance(raw_info_list, list):
        return raw_info_list
    return []


def query_acs_events(base_url: str, auth: HTTPDigestAuth, search_id: str,
                     position: int, max_results: int, major: int, minor: int):
    """Realiza la petición HTTP ISAPI."""
    url = f"{base_url}/ISAPI/AccessControl/AcsEvent?format=json"
    payload = {
        "AcsEventCond": {
            "searchID": search_id,
            "searchResultPosition": position,
            "maxResults": max_results,
            "major": major,
            "minor": minor
        }
    }
    headers = {"Content-Type": "application/json"}
    resp = requests.post(url, auth=auth, headers=headers, json=payload, timeout=(5.0, 15.0))
    return resp


def pull_events(base_url: str, auth: HTTPDigestAuth, search_id: str = "test-pull-1",
                position: int = 0, max_results: int = 30, major: int = 5, minor: int = 0,
                latest: bool = False, attendance_only: bool = False):
    """
    Ejecuta consulta paginada a /ISAPI/AccessControl/AcsEvent?format=json
    """
    print(f"\n[+] Consultando eventos de asistencia en memoria interna...")
    print(f"    URL:     {base_url}/ISAPI/AccessControl/AcsEvent?format=json")
    print(f"    Filtro:  Major={major} (Control de Acceso), Minor={minor}")

    try:
        # Si se piden los últimos eventos, primero consultamos el total de eventos
        target_position = position
        if latest:
            resp_probe = query_acs_events(base_url, auth, search_id, 0, 1, major, minor)
            if resp_probe.status_code == 200:
                total = resp_probe.json().get("AcsEvent", {}).get("totalMatches", 0)
                target_position = max(0, total - max_results)
                print(f"    [i] Modo --latest activado: consultando desde posición {target_position} de {total} totales.")

        resp = query_acs_events(base_url, auth, search_id, target_position, max_results, major, minor)
        
        if resp.status_code == 401:
            print("    [!] ERROR 401: No autorizado. Verifica credenciales Digest.")
            return False, []
            
        if resp.status_code != 200:
            print(f"    [-] Error HTTP {resp.status_code}: {resp.text}")
            return False, []
            
        data = resp.json()
        acs_event = data.get("AcsEvent", {})
        status_str = acs_event.get("responseStatusStrg", "Unknown")
        num_matches = acs_event.get("numOfMatches", 0)
        total_matches = acs_event.get("totalMatches", 0)
        
        print("\n" + "=" * 95)
        print("          HISTORIAL DE CHECADAS (PULL ISAPI / RECOVERY)")
        print("=" * 95)
        print(f"  • Estado de consulta:                    {status_str}")
        print(f"  • Total de eventos en memoria del reloj: {total_matches}")
        print(f"  • Posición de inicio consultada:         {target_position}")
        print(f"  • Eventos obtenidos en esta página:     {num_matches}")
        print("=" * 95)
        
        raw_list = acs_event.get("InfoList", [])
        events = parse_event_list(raw_list)
        
        if attendance_only:
            # Filtrar solo eventos con número de empleado o checadas biométricas exitosas
            events = [
                ev for ev in events
                if (ev.get("employeeNoString") or ev.get("employeeNo"))
                or ev.get("minor") in [1, 3, 38, 40, 75, 77, 78, 79]
            ]
            print(f"  [i] Filtro --attendance-only activo: Mostrando {len(events)} checadas de empleados.")

        if not events:
            print("\n  [i] No se encontraron eventos en el rango solicitado.")
            return True, []
            
        print(f"{'Fecha y Hora':<25} | {'No. Emp':<10} | {'Nombre':<20} | {'Método':<10} | {'Descripción':<25}")
        print("-" * 105)
        
        for ev in events:
            event_time = ev.get("time", "N/A")
            emp_no = ev.get("employeeNoString") or str(ev.get("employeeNo", "N/A"))
            emp_name = ev.get("name") or ("Desconocido" if emp_no == "N/A" else "")
            minor_code = ev.get("minor", 0)
            verify_mode = ev.get("currentVerifyMode", ev.get("verifyMode", "N/A"))
            minor_desc = HIK_MINOR_EVENT_MAP.get(minor_code, f"Evento Minor #{minor_code}")
            
            print(f"{event_time:<25} | {emp_no:<10} | {emp_name[:20]:<20} | {verify_mode:<10} | {minor_desc[:25]:<25}")
            
        print("=" * 105)
        print(f"[+] Total procesados para pre-nómina: {len(events)} registros.")
        return True, events
        
    except requests.exceptions.RequestException as e:
        print(f"    [-] Error de conexión con el reloj: {e}")
        return False, []
    except json.JSONDecodeError:
        print(f"    [-] La respuesta no contiene JSON válido:\n{resp.text[:300]}")
        return False, []


def main():
    parser = argparse.ArgumentParser(description="Pull Attendance Events from Hikvision DS-K1T320MFWX-B")
    parser.add_argument("--host", default=config.HIK_HOST, help="IP del dispositivo")
    parser.add_argument("--port", type=int, default=config.HIK_PORT, help="Puerto HTTP del dispositivo")
    parser.add_argument("--user", default=config.HIK_USER, help="Usuario ISAPI (ej: admin)")
    parser.add_argument("--password", default=config.HIK_PASS, help="Contraseña ISAPI")
    parser.add_argument("--max", type=int, default=30, help="Cantidad máxima de eventos a recuperar")
    parser.add_argument("--position", type=int, default=0, help="Posición de inicio del cursor")
    parser.add_argument("--latest", action="store_true", help="Obtener los eventos más recientes")
    parser.add_argument("--attendance-only", action="store_true", help="Filtrar solo checadas con empleado")
    parser.add_argument("--major", type=int, default=5, help="Código mayor de evento (5 = Control de acceso)")
    parser.add_argument("--minor", type=int, default=0, help="Código menor de evento (0 = Todos)")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}" if args.port != 80 else f"http://{args.host}"
    password = args.password

    print("=" * 60)
    print(" HIKVISION ISAPI - EXTRACCIÓN DE EVENTOS OFFLINE")
    print("=" * 60)
    print(f"Destino:    {base_url}")
    print(f"Usuario:    {args.user}")
    print(f"Password:   {'*' * len(password) if password else '[NO CONFIGURADA]'}")

    if not password:
        print("\n[!] ADVERTENCIA: La contraseña no está configurada en .env ni fue provista via --password.")
        sys.exit(1)

    auth = HTTPDigestAuth(args.user, password)
    pull_events(
        base_url=base_url,
        auth=auth,
        search_id="test-pull-1",
        position=args.position,
        max_results=args.max,
        major=args.major,
        minor=args.minor,
        latest=args.latest,
        attendance_only=args.attendance_only
    )


if __name__ == "__main__":
    main()
