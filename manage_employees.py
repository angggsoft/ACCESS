"""
Gestión de Empleados y Enrolamiento Remoto ISAPI
Dispositivo: Hikvision DS-K1T320MFWX-B (IP 192.168.11.195)
"""

import os
import sys
import json
import argparse
from pathlib import Path
import requests
from requests.auth import HTTPDigestAuth
import config


def get_auth():
    return HTTPDigestAuth(config.HIK_USER, config.HIK_PASS)


def list_employees():
    """Consulta y despliega la lista detallada de usuarios en el reloj."""
    url = f"{config.BASE_URL}/ISAPI/AccessControl/UserInfo/Search?format=json"
    payload = {
        "UserInfoSearchCond": {
            "searchID": "search-emp",
            "searchResultPosition": 0,
            "maxResults": 30
        }
    }
    resp = requests.post(url, auth=get_auth(), json=payload, timeout=10)
    if resp.status_code != 200:
        print(f"[-] Error consultando usuarios (HTTP {resp.status_code}): {resp.text}")
        return

    data = resp.json().get("UserInfoSearch", {})
    users = data.get("UserInfo", [])
    if isinstance(users, dict):
        users = [users]

    print("\n" + "=" * 85)
    print(f"{'No.':<8} | {'Nombre':<25} | {'Tipo':<10} | {'Admin UI':<10} | {'Rostro':<8} | {'Huella':<8}")
    print("-" * 85)
    for u in users:
        emp_no = str(u.get("employeeNo", "N/A"))
        name = str(u.get("name", "N/A"))
        utype = str(u.get("userType", "normal"))
        ui_right = "SÍ" if u.get("localUIRight") else "NO"
        has_face = "SÍ" if u.get("numOfFace", 0) > 0 else "NO"
        has_fp = "SÍ" if u.get("numOfFP", 0) > 0 else "NO"
        print(f"{emp_no:<8} | {name:<25} | {utype:<10} | {ui_right:<10} | {has_face:<8} | {has_fp:<8}")
    print("=" * 85 + "\n")


def create_or_update_employee(emp_no: str, name: str, pin: str = "123456", is_admin: bool = True):
    """
    Crea o actualiza un empleado con PIN numérico y permisos de menú táctil (localUIRight).
    """
    url = f"{config.BASE_URL}/ISAPI/AccessControl/UserInfo/SetUp?format=json"
    payload = {
        "UserInfo": {
            "employeeNo": emp_no,
            "name": name,
            "userType": "normal",
            "closeDelayEnabled": False,
            "Valid": {
                "enable": True,
                "beginTime": "2026-01-01T00:00:00",
                "endTime": "2036-12-31T23:59:59",
                "timeType": "local"
            },
            "belongGroup": "",
            "password": pin,
            "doorRight": "1",
            "RightPlan": [
                {
                    "doorNo": 1,
                    "planTemplateNo": "1"
                }
            ],
            "localUIRight": is_admin,
            "gender": "male"
        }
    }
    
    print(f"[*] Registrando empleado #{emp_no} ({name}) con PIN numérico '{pin}'...")
    resp = requests.put(url, auth=get_auth(), json=payload, timeout=10)
    if resp.status_code == 200:
        print(f"[+] ¡Empleado #{emp_no} '{name}' registrado exitosamente en el reloj!")
        print(f"    • PIN Teclado Numérico: {pin}")
        print(f"    • Acceso a Menú Admin en Pantalla: {'HABILITADO' if is_admin else 'DESHABILITADO'}")
        return True
    else:
        print(f"[-] Error al registrar empleado (HTTP {resp.status_code}): {resp.text}")
        return False


def upload_face_picture(emp_no: str, image_path: str):
    """
    Enrola el rostro de un empleado en la biblioteca de rostros (FDLib) del reloj.
    Requiere una imagen JPG nítida del rostro.
    """
    img_file = Path(image_path)
    if not img_file.exists():
        print(f"[-] Archivo de imagen no encontrado: {image_path}")
        return False

    url = f"{config.BASE_URL}/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json"
    face_record_json = {
        "faceLibType": "blackFD",
        "FDID": "1",
        "FPID": emp_no
    }

    print(f"[*] Subiendo fotografía {img_file.name} para empleado #{emp_no}...")
    with open(img_file, "rb") as f:
        files = {
            "FaceDataRecord": (None, json.dumps(face_record_json), "application/json"),
            "img": (img_file.name, f, "image/jpeg")
        }
        resp = requests.post(url, auth=get_auth(), files=files, timeout=15)

    if resp.status_code in [200, 201]:
        print(f"[+] ¡Rostro enrolado con éxito para el empleado #{emp_no}!")
        print(f"    El reloj ahora te reconocerá automáticamente al colocarte frente a la cámara.")
        return True
    else:
        print(f"[-] Error al subir rostro (HTTP {resp.status_code}): {resp.text}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Gestor de Empleados y Enrolamiento Hikvision ISAPI")
    subparsers = parser.add_subparsers(dest="command")

    # Listar
    subparsers.add_parser("list", help="Listar empleados en el reloj")

    # Crear / Actualizar
    add_parser = subparsers.add_parser("add", help="Crear empleado con PIN y permisos")
    add_parser.add_argument("--emp", required=True, help="Número de empleado (ej: 3)")
    add_parser.add_argument("--name", required=True, help="Nombre del empleado")
    add_parser.add_argument("--pin", default="123456", help="PIN numérico para teclado (ej: 123456)")
    add_parser.add_argument("--admin", action="store_true", default=True, help="Dar permisos de menú en pantalla")

    # Subir Foto Rostro
    face_parser = subparsers.add_parser("face", help="Enrolar rostro enviando imagen JPG")
    face_parser.add_argument("--emp", required=True, help="Número de empleado")
    face_parser.add_argument("--image", required=True, help="Ruta al archivo .jpg con el rostro")

    args = parser.parse_args()

    if args.command == "list" or not args.command:
        list_employees()
    elif args.command == "add":
        create_or_update_employee(args.emp, args.name, args.pin, args.admin)
    elif args.command == "face":
        upload_face_picture(args.emp, args.image)


if __name__ == "__main__":
    main()
