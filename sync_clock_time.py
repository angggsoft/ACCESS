"""
Sincronización de Fecha y Hora del Reloj Checador Hikvision DS-K1T320MFWX-B
Endpoint: PUT /ISAPI/System/time
Zona Horaria: México Central (CST / UTC-6)
"""

import sys
import json
import datetime
import xml.etree.ElementTree as ET
import requests
from requests.auth import HTTPDigestAuth
import config


def get_current_local_iso() -> str:
    """Obtiene la hora actual del sistema en formato ISO 8601 con offset -06:00."""
    now = datetime.datetime.now()
    # Genera formato YYYY-MM-DDTHH:MM:SS-06:00
    iso_str = now.strftime("%Y-%m-%dT%H:%M:%S-06:00")
    return iso_str


def get_clock_time(base_url: str, auth: HTTPDigestAuth):
    """Consulta GET /ISAPI/System/time y retorna la hora reportada por el reloj."""
    url = f"{base_url}/ISAPI/System/time"
    try:
        resp = requests.get(url, auth=auth, timeout=(5.0, 10.0))
        if resp.status_code != 200:
            print(f"[-] Error al consultar hora del reloj (HTTP {resp.status_code}): {resp.text}")
            return None
            
        content_type = resp.headers.get("Content-Type", "")
        if "json" in content_type:
            data = resp.json()
            time_obj = data.get("Time", data)
            return {
                "localTime": time_obj.get("localTime"),
                "timeZone": time_obj.get("timeZone"),
                "timeMode": time_obj.get("timeMode")
            }
        else:
            # Parse XML
            root = ET.fromstring(resp.content)
            res = {}
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if elem.text:
                    res[tag] = elem.text.strip()
            return {
                "localTime": res.get("localTime"),
                "timeZone": res.get("timeZone"),
                "timeMode": res.get("timeMode")
            }
    except Exception as e:
        print(f"[-] Excepción en GET /ISAPI/System/time: {e}")
        return None


def sync_time(base_url: str, auth: HTTPDigestAuth):
    url = f"{base_url}/ISAPI/System/time"
    local_iso = get_current_local_iso()
    time_zone = "CST+6:00:00"
    
    print("=" * 60)
    print(" HIKVISION ISAPI - SINCRONIZACIÓN DE FECHA Y HORA")
    print("=" * 60)
    print(f"Destino:            {base_url}")
    print(f"Hora Local Sistema: {local_iso}")
    print(f"Zona Horaria:       {time_zone}")

    # 1. Consultar hora antes del cambio
    before_time = get_clock_time(base_url, auth)
    if before_time:
        print(f"\n[i] Hora actual en el reloj antes de sincronizar:")
        print(f"    • localTime: {before_time.get('localTime')}")
        print(f"    • timeZone:  {before_time.get('timeZone')}")
        print(f"    • timeMode:  {before_time.get('timeMode')}")

    # 2. Intentar actualizar vía JSON
    json_payload = {
        "Time": {
            "timeMode": "manual",
            "localTime": local_iso,
            "timeZone": time_zone
        }
    }
    
    print(f"\n[*] Enviando actualización PUT {url}...")
    headers_json = {"Content-Type": "application/json"}
    
    try:
        resp = requests.put(url, auth=auth, headers=headers_json, json=json_payload, timeout=(5.0, 10.0))
        success = False
        
        if resp.status_code == 200:
            print("    [+] Sincronización exitosa vía JSON.")
            success = True
        else:
            print(f"    [i] Respuesta con JSON (HTTP {resp.status_code}), reintentando con formato XML nativo...")
            # Fallback con XML nativo ISAPI
            xml_payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<timeMode>manual</timeMode>
<localTime>{local_iso}</localTime>
<timeZone>{time_zone}</timeZone>
</Time>"""
            headers_xml = {"Content-Type": "application/xml"}
            resp_xml = requests.put(url, auth=auth, headers=headers_xml, data=xml_payload.encode("utf-8"), timeout=(5.0, 10.0))
            if resp_xml.status_code == 200:
                print("    [+] Sincronización exitosa vía XML nativo.")
                success = True
            else:
                print(f"    [-] Error en actualización con XML (HTTP {resp_xml.status_code}): {resp_xml.text}")
                return False

    except Exception as e:
        print(f"[-] Error enviando PUT /ISAPI/System/time: {e}")
        return False

    # 3. GET de comprobación
    print("\n[*] Realizando GET /ISAPI/System/time de comprobación...")
    after_time = get_clock_time(base_url, auth)
    if after_time:
        print("\n" + "=" * 60)
        print("          HORA CONFIRMADA EN EL DISPOSITIVO")
        print("=" * 60)
        print(f"  • localTime: {after_time.get('localTime')}")
        print(f"  • timeZone:  {after_time.get('timeZone')}")
        print(f"  • timeMode:  {after_time.get('timeMode')}")
        print("=" * 60)
        print("[+] El reloj Hikvision ha sido calibrado correctamente con la hora del sistema.")
        return True
    else:
        print("[-] No se pudo comprobar la hora posterior a la sincronización.")
        return False


if __name__ == "__main__":
    auth = HTTPDigestAuth(config.HIK_USER, config.HIK_PASS)
    sync_time(config.BASE_URL, auth)
