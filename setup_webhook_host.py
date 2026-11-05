"""
Configuración del Destinatario HTTP / Webhook para Eventos Push en Vivo
Dispositivo: Hikvision DS-K1T320MFWX-B (IP 192.168.11.195)
Endpoint ISAPI: /ISAPI/Event/notification/httpHosts/1
"""

import sys
import socket
import xml.etree.ElementTree as ET
import requests
from requests.auth import HTTPDigestAuth
import config


def detect_local_ip(target_ip: str = config.HIK_HOST) -> str:
    """Detecta automáticamente la IP local activa en la subred del reloj."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Se conecta virtualmente al host destino sin enviar tráfico UDP
        s.connect((target_ip, 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = "127.0.0.1"
    finally:
        s.close()
    return local_ip


def get_current_http_hosts(base_url: str, auth: HTTPDigestAuth):
    """Lee la lista actual de hosts HTTP configurados en el reloj."""
    url = f"{base_url}/ISAPI/Event/notification/httpHosts"
    try:
        resp = requests.get(url, auth=auth, timeout=(5.0, 10.0))
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        print(f"[-] Error al consultar httpHosts: {e}")
        return None


def configure_http_host(base_url: str, auth: HTTPDigestAuth, host_id: int = 1,
                       webhook_ip: str = None, webhook_port: int = 8000,
                       webhook_url: str = "/api/v1/webhooks/hikvision"):
    """
    Configura el destinatario HTTP #1 en el terminal Hikvision para recibir
    notificaciones en tiempo real de checadas (AccessControllerEvent).
    """
    if not webhook_ip:
        webhook_ip = detect_local_ip(config.HIK_HOST)

    print("=" * 65)
    print(" HIKVISION ISAPI - CONFIGURACIÓN DE DESTINATARIO HTTP / WEBHOOK")
    print("=" * 65)
    print(f"Dispositivo Reloj:       {base_url}")
    print(f"IP Local Detectada (PC): {webhook_ip}")
    print(f"Puerto Receptor:         {webhook_port}")
    print(f"Ruta URL Webhook:        {webhook_url}")

    # 1. Leer configuración previa
    print("\n[1] Consultando configuración previa de hosts de notificación...")
    prev_xml = get_current_http_hosts(base_url, auth)
    if prev_xml:
        print("    [+] Configuración actual leída correctamente.")

    # 2. Construir XML con suscripción a AccessControllerEvent
    xml_payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotification version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>{host_id}</id>
<url>{webhook_url}</url>
<protocolType>HTTP</protocolType>
<parameterFormatType>XML</parameterFormatType>
<addressingFormatType>ipaddress</addressingFormatType>
<hostName>{webhook_ip}</hostName>
<ipAddress>{webhook_ip}</ipAddress>
<portNo>{webhook_port}</portNo>
<httpAuthenticationMethod>none</httpAuthenticationMethod>
<SubscribeEvent>
<heartbeat>30</heartbeat>
<eventMode>all</eventMode>
<EventList>
<Event>
<type>AccessControllerEvent</type>
<minorAlarm></minorAlarm>
<minorException></minorException>
<minorOperation></minorOperation>
<minorEvent></minorEvent>
<pictureURLType>binary</pictureURLType>
</Event>
</EventList>
</SubscribeEvent>
</HttpHostNotification>"""

    put_url = f"{base_url}/ISAPI/Event/notification/httpHosts/{host_id}"
    headers = {"Content-Type": "application/xml"}
    print(f"\n[2] Aplicando configuración a Host #{host_id} (PUT {put_url})...")

    try:
        resp = requests.put(put_url, auth=auth, headers=headers, data=xml_payload.encode("utf-8"), timeout=(5.0, 10.0))
        if resp.status_code == 200:
            print("    [+] Configuración aplicada exitosamente en el reloj (HTTP 200 OK).")
        else:
            print(f"    [-] Error al aplicar configuración (HTTP {resp.status_code}):\n{resp.text}")
            return False

    except Exception as e:
        print(f"    [-] Error en la petición PUT: {e}")
        return False

    # 3. Verificación posterior vía GET
    print(f"\n[3] Verificando confirmación en {put_url}...")
    try:
        resp_check = requests.get(put_url, auth=auth, timeout=(5.0, 10.0))
        if resp_check.status_code == 200:
            root = ET.fromstring(resp_check.content)
            conf = {}
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if elem.text and elem.text.strip():
                    conf[tag] = elem.text.strip()

            print("\n" + "=" * 65)
            print("          CONFIRMACIÓN DE DESTINATARIO HTTP EN EL RELOJ")
            print("=" * 65)
            print(f"  • Host ID:         {conf.get('id', host_id)}")
            print(f"  • Protocolo:       {conf.get('protocolType', 'HTTP')}")
            print(f"  • Dirección IP:    {conf.get('ipAddress', 'N/A')}")
            print(f"  • Puerto Destino:  {conf.get('portNo', 'N/A')}")
            print(f"  • URL Endpoint:    {conf.get('url', 'N/A')}")
            print(f"  • Modo de Eventos: {conf.get('eventMode', 'all')}")
            print("=" * 65)
            print(f"[+] El reloj Hikvision ahora enviará las checadas en vivo a: http://{webhook_ip}:{webhook_port}{webhook_url}")
            return True
        else:
            print(f"    [-] No se pudo leer la confirmación: HTTP {resp_check.status_code}")
            return False
    except Exception as e:
        print(f"    [-] Error al verificar confirmación: {e}")
        return False


if __name__ == "__main__":
    auth = HTTPDigestAuth(config.HIK_USER, config.HIK_PASS)
    configure_http_host(config.BASE_URL, auth)
