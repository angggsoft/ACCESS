"""
Simulador de Notificación Push de Hikvision hacia el backend FastAPI
Permite validar el procesamiento de eventos de asistencia y fotos de checada en tiempo real
sin requerir reconfigurar la red del dispositivo físico inmediatamente.
"""

import io
import requests
from PIL import Image

SERVER_URL = "http://127.0.0.1:8000/ISAPI/Event/notification/alertStream"

def generate_sample_face_image():
    """Genera una imagen JPEG básica para simular la captura del rostro en la checada."""
    img = Image.new("RGB", (200, 200), color=(73, 109, 137))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    buf.seek(0)
    return buf.getvalue()

def test_push_multipart():
    print(f"[*] Enviando evento simulado Multipart/form-data a {SERVER_URL}...")
    
    event_xml = """<?xml version="1.0" encoding="utf-8"?>
    <EventNotificationAlert version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
        <ipAddress>192.168.11.195</ipAddress>
        <portNo>80</portNo>
        <protocol>HTTP</protocol>
        <macAddress>48:ea:63:xx:xx:xx</macAddress>
        <channelID>1</channelID>
        <dateTime>2026-11-05T13:45:00-06:00</dateTime>
        <activePostCount>1</activePostCount>
        <eventType>AccessControllerEvent</eventType>
        <eventState>active</eventState>
        <eventDescription>Access Controller Event</eventDescription>
        <AccessControllerEvent>
            <majorEventType>5</majorEventType>
            <subEventType>75</subEventType>
            <name>Carlos Mendez</name>
            <cardReaderNo>1</cardReaderNo>
            <doorNo>1</doorNo>
            <currentVerifyMode>face</currentVerifyMode>
            <employeeNoString>EMP-00102</employeeNoString>
            <serialNo>102</serialNo>
            <userType>normal</userType>
            <mask>yes</mask>
        </AccessControllerEvent>
    </EventNotificationAlert>
    """
    
    image_bytes = generate_sample_face_image()
    
    files = {
        "event_log": (None, event_xml, "text/xml"),
        "picture": ("face_capture.jpg", image_bytes, "image/jpeg")
    }
    
    try:
        r = requests.post(SERVER_URL, files=files, timeout=5)
        print(f"[+] Código de Respuesta del Backend: {r.status_code}")
        print(f"[+] Contenido de Respuesta: {r.json()}")
    except Exception as e:
        print(f"[-] Error enviando evento: {e}")

if __name__ == "__main__":
    test_push_multipart()
