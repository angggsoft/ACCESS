"""
Configuración de Conexión Wi-Fi en Terminal Hikvision DS-K1T320MFWX-B
Permite desconectar el cable de red físico (Ethernet) y operar de forma inalámbrica.
"""

import time
import xml.etree.ElementTree as ET
import requests
from requests.auth import HTTPDigestAuth
import config


def get_auth():
    return HTTPDigestAuth(config.HIK_USER, config.HIK_PASS)


def get_interface_status(if_id: int = 2):
    """Consulta el estado actual de la interfaz de red."""
    url = f"{config.BASE_URL}/ISAPI/System/Network/interfaces/{if_id}"
    try:
        resp = requests.get(url, auth=get_auth(), timeout=10)
        if resp.status_code == 200:
            root = ET.fromstring(resp.content)
            info = {}
            for elem in root.iter():
                tag = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
                if elem.text and elem.text.strip():
                    info[tag] = elem.text.strip()
            return info
    except Exception as e:
        print(f"[-] Error consultando interfaz {if_id}: {e}")
    return None


def configure_wifi(ssid: str = "TBS", password: str = "TBSCUAU2025", use_dhcp: bool = True):
    """
    Configura la interfaz inalámbrica (Interface #2) en el reloj.
    """
    url = f"{config.BASE_URL}/ISAPI/System/Network/interfaces/2"
    
    print("=" * 65)
    print(" HIKVISION ISAPI - CONFIGURACIÓN DE RED WI-FI")
    print("=" * 65)
    print(f"Dispositivo:         {config.BASE_URL}")
    print(f"Red Wi-Fi (SSID):    {ssid}")
    print(f"Seguridad:           WPA2-Personal")
    print(f"Modo de IP:          {'DHCP (Dinámica)' if use_dhcp else 'Estática (192.168.11.196)'}")
    print("=" * 65)

    if use_dhcp:
        xml_payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<NetworkInterface version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>2</id>
<IPAddress>
<ipVersion>v4</ipVersion>
<addressingType>dynamic</addressingType>
</IPAddress>
<Wireless version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<enabled>true</enabled>
<ssid>{ssid}</ssid>
<WirelessSecurity>
<securityMode>WPA2-personal</securityMode>
<WPA>
<sharedKey>{password}</sharedKey>
<wpaKeyLength>{len(password)}</wpaKeyLength>
</WPA>
</WirelessSecurity>
</Wireless>
</NetworkInterface>"""
    else:
        xml_payload = f"""<?xml version="1.0" encoding="UTF-8"?>
<NetworkInterface version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<id>2</id>
<IPAddress>
<ipVersion>v4</ipVersion>
<addressingType>static</addressingType>
<ipAddress>192.168.11.196</ipAddress>
<subnetMask>255.255.255.0</subnetMask>
<DefaultGateway>
<ipAddress>192.168.11.5</ipAddress>
</DefaultGateway>
<PrimaryDNS>
<ipAddress>8.8.8.8</ipAddress>
</PrimaryDNS>
<SecondaryDNS>
<ipAddress>8.8.4.4</ipAddress>
</SecondaryDNS>
<DNSEnable>false</DNSEnable>
</IPAddress>
<Wireless version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<enabled>true</enabled>
<ssid>{ssid}</ssid>
<WirelessSecurity>
<securityMode>WPA2-personal</securityMode>
<WPA>
<sharedKey>{password}</sharedKey>
<wpaKeyLength>{len(password)}</wpaKeyLength>
</WPA>
</WirelessSecurity>
</Wireless>
</NetworkInterface>"""

    headers = {"Content-Type": "application/xml"}
    print("\n[*] Enviando credenciales Wi-Fi al terminal...")
    try:
        resp = requests.put(url, auth=get_auth(), headers=headers, data=xml_payload.encode("utf-8"), timeout=15)
        if resp.status_code == 200:
            print("[+] Configuración Wi-Fi guardada exitosamente en el reloj.")
        else:
            print(f"[-] Error al guardar Wi-Fi (HTTP {resp.status_code}):\n{resp.text}")
            return False
    except Exception as e:
        print(f"[-] Excepción enviando configuración: {e}")
        return False

    # Esperar unos segundos a que la antena se asocie al punto de acceso
    print("\n[*] Esperando a que el reloj se asocie al router Wi-Fi 'TBS'...")
    for i in range(1, 8):
        time.sleep(3)
        st = get_interface_status(2)
        if st:
            ip = st.get("ipAddress", "0.0.0.0")
            print(f"    Intento {i}/7: IP Wi-Fi = {ip}")
            if ip and ip != "0.0.0.0" and ip != "192.168.1.252":
                print("\n" + "=" * 65)
                print("          ¡CONEXIÓN WI-FI ESTABLECIDA CON ÉXITO!")
                print("=" * 65)
                print(f"  • Red (SSID):     {ssid}")
                print(f"  • IP Asignada:    {ip}")
                print(f"  • Dirección MAC:  {st.get('macAddress', 'N/A')}")
                print(f"  • Modo de IP:     {st.get('addressingType', 'N/A')}")
                print("=" * 65)
                return ip

    print("\n[i] El reloj está asociándose en segundo plano. Consultando estado final...")
    final_st = get_interface_status(2)
    if final_st:
        print(f"Estado final interfaz 2: {final_st}")
    return None


if __name__ == "__main__":
    configure_wifi()
