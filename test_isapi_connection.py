"""
Diagnóstico de Red y Dispositivo Hikvision ISAPI
Dispositivo: DS-K1T320MFWX-B (o compatible ISAPI)
"""

import sys
import json
import argparse
import xml.etree.ElementTree as ET
import requests
from requests.auth import HTTPDigestAuth
import config


def strip_ns(tag: str) -> str:
    """Remueve namespace XML para búsqueda genérica."""
    return tag.split("}")[-1] if "}" in tag else tag


def parse_device_info(response: requests.Response) -> dict:
    """Parsea la respuesta de /ISAPI/System/deviceInfo en formato XML o JSON."""
    content_type = response.headers.get("Content-Type", "")
    info = {
        "deviceName": "N/A",
        "model": "N/A",
        "serialNumber": "N/A",
        "macAddress": "N/A",
        "firmwareVersion": "N/A",
        "firmwareReleasedDate": "N/A",
    }

    if "json" in content_type:
        data = response.json()
        root = data.get("DeviceInfo", data)
        for key in info.keys():
            if key in root:
                info[key] = root[key]
        return info

    # Por defecto parsear XML
    try:
        root = ET.fromstring(response.content)
        for elem in root.iter():
            clean_tag = strip_ns(elem.tag)
            if clean_tag in info and elem.text:
                info[clean_tag] = elem.text.strip()
    except ET.ParseError as err:
        print(f"[-] Error parseando XML de deviceInfo: {err}")
    return info


def check_device_info(base_url: str, auth: HTTPDigestAuth):
    """Consulta GET /ISAPI/System/deviceInfo"""
    url = f"{base_url}/ISAPI/System/deviceInfo"
    print(f"\n[1] Consultando información básica del dispositivo...")
    print(f"    URL: {url}")
    
    try:
        resp = requests.get(url, auth=auth, timeout=(5.0, 10.0))
        if resp.status_code == 401:
            print("    [!] ERROR 401: No autorizado. Verifica usuario y contraseña.")
            print(f"    [!] Encabezado WWW-Authenticate: {resp.headers.get('WWW-Authenticate')}")
            return False, None
        
        resp.raise_for_status()
        info = parse_device_info(resp)
        
        print("\n" + "=" * 60)
        print("          DATOS DEL DISPOSITIVO HIKVISION")
        print("=" * 60)
        print(f"  • Modelo:                {info['model']}")
        print(f"  • Nombre del Dispositivo: {info['deviceName']}")
        print(f"  • Número de Serie:       {info['serialNumber']}")
        print(f"  • Dirección MAC:         {info['macAddress']}")
        print(f"  • Versión de Firmware:   {info['firmwareVersion']}")
        if info['firmwareReleasedDate'] != "N/A":
            print(f"  • Fecha de Firmware:     {info['firmwareReleasedDate']}")
        print("=" * 60)
        return True, info
        
    except requests.exceptions.RequestException as e:
        print(f"    [-] Error de conexión con el dispositivo: {e}")
        return False, None


def check_user_info(base_url: str, auth: HTTPDigestAuth, max_results: int = 30):
    """Consulta POST /ISAPI/AccessControl/UserInfo/Search?format=json"""
    url = f"{base_url}/ISAPI/AccessControl/UserInfo/Search?format=json"
    payload = {
        "UserInfoSearchCond": {
            "searchID": "1",
            "searchResultPosition": 0,
            "maxResults": max_results
        }
    }
    headers = {"Content-Type": "application/json"}
    
    print(f"\n[2] Consultando lista de usuarios y empleados registrados...")
    print(f"    URL: {url}")
    print(f"    Payload: {json.dumps(payload)}")
    
    try:
        resp = requests.post(url, auth=auth, headers=headers, json=payload, timeout=(5.0, 15.0))
        
        if resp.status_code == 401:
            print("    [!] ERROR 401: No autorizado al consultar usuarios.")
            return False
            
        if resp.status_code != 200:
            print(f"    [-] El reloj respondió con status {resp.status_code}: {resp.text}")
            # Intentar fallback de capabilities
            check_access_capabilities(base_url, auth)
            return False
            
        data = resp.json()
        search_result = data.get("UserInfoSearch", {})
        status_str = search_result.get("responseStatusStrg", "Unknown")
        num_matches = search_result.get("numOfMatches", 0)
        total_matches = search_result.get("totalMatches", 0)
        
        print(f"    [+] Estado de respuesta: {status_str}")
        print(f"    [+] Total de usuarios registrados en el reloj: {total_matches}")
        print(f"    [+] Usuarios retornados en esta página: {num_matches}")
        
        user_list = search_result.get("UserInfo", [])
        if isinstance(user_list, dict):
            # Si sólo hay un usuario, Hikvision puede retornar dict en vez de list
            user_list = [user_list]
            
        if not user_list:
            print("\n    [!] No hay empleados registrados actualmente en el reloj.")
            return True
            
        print("\n" + "=" * 70)
        print(f"{'No. Empleado':<15} | {'Nombre':<30} | {'Tipo de Usuario':<15}")
        print("-" * 70)
        for u in user_list:
            emp_no = str(u.get("employeeNo", "N/A"))
            name = str(u.get("name", "N/A"))
            user_type = str(u.get("userType", "normal"))
            print(f"{emp_no:<15} | {name:<30} | {user_type:<15}")
        print("=" * 70)
        return True
        
    except requests.exceptions.RequestException as e:
        print(f"    [-] Error consultando usuarios: {e}")
        return False
    except json.JSONDecodeError:
        print(f"    [-] Respuesta no es JSON válido: {resp.text[:200]}")
        return False


def check_access_capabilities(base_url: str, auth: HTTPDigestAuth):
    """Consulta GET /ISAPI/AccessControl/capabilities como diagnóstico complementario."""
    url = f"{base_url}/ISAPI/AccessControl/capabilities"
    print(f"\n[i] Consultando capacidades de Control de Acceso: {url}")
    try:
        resp = requests.get(url, auth=auth, timeout=(5.0, 10.0))
        if resp.status_code == 200:
            print("    [+] Capacidades obtenidas con éxito.")
            print(f"    Contenido previo: {resp.text[:300]}...")
        else:
            print(f"    [-] Código de estado: {resp.status_code}")
    except Exception as e:
        print(f"    [-] Error en capabilities: {e}")


def main():
    parser = argparse.ArgumentParser(description="Test ISAPI Connection - Hikvision DS-K1T320MFWX-B")
    parser.add_argument("--host", default=config.HIK_HOST, help="IP del dispositivo")
    parser.add_argument("--port", type=int, default=config.HIK_PORT, help="Puerto HTTP del dispositivo")
    parser.add_argument("--user", default=config.HIK_USER, help="Usuario ISAPI (ej: admin)")
    parser.add_argument("--password", default=config.HIK_PASS, help="Contraseña ISAPI")
    args = parser.parse_args()

    base_url = f"http://{args.host}:{args.port}" if args.port != 80 else f"http://{args.host}"
    password = args.password

    print("=" * 60)
    print(" HIKVISION ISAPI - DIAGNÓSTICO DE RED Y CONECTIVIDAD")
    print("=" * 60)
    print(f"Destino:    {base_url}")
    print(f"Usuario:    {args.user}")
    print(f"Password:   {'*' * len(password) if password else '[NO CONFIGURADA]'}")

    if not password:
        print("\n[!] ADVERTENCIA: La contraseña no está configurada en .env ni fue provista via --password.")
        print("    Para configurarla, edita el archivo .env o ejecuta:")
        print("    python test_isapi_connection.py --password TU_CONTRASEÑA\n")
        sys.exit(1)

    auth = HTTPDigestAuth(args.user, password)
    
    # 1. Device Info
    success, _ = check_device_info(base_url, auth)
    if not success:
        print("\n[-] Diagnóstico fallido en el paso 1. Revisa credenciales o red.")
        sys.exit(1)
        
    # 2. User Info
    check_user_info(base_url, auth)
    print("\n[+] Diagnóstico de dispositivo y usuarios completado exitosamente.")


if __name__ == "__main__":
    main()
