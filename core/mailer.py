"""
ACCESS — Servicio de Envío de Correos y Generación de Reportes (SMTP)
Soporta Gmail (Contraseñas de aplicación), Outlook / Office 365 y servidores SMTP corporativos.
"""

import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from email.utils import formatdate
from datetime import datetime
from typing import Dict, Any, Optional

import core.database as db


def send_email_message(
    to_email: str,
    subject: str,
    html_content: str,
    text_content: Optional[str] = None,
    attachment_filename: Optional[str] = None,
    attachment_bytes: Optional[bytes] = None,
    config_override: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Envía un correo electrónico mediante el servidor SMTP configurado en la base de datos.
    """
    cfg = config_override or db.get_email_config(mask_password=False)

    host = (cfg.get("smtp_host") or "").strip()
    port = int(cfg.get("smtp_port") or 587)
    user = (cfg.get("smtp_user") or "").strip()
    password = (cfg.get("smtp_password") or "").strip()
    security = (cfg.get("smtp_security") or "STARTTLS").strip().upper()
    sender_name = (cfg.get("remitente_nombre") or "ACCESS - Control Biométrico").strip()
    sender_email = (cfg.get("remitente_email") or user).strip()

    if not host:
        return {"ok": False, "error": "No se ha configurado el servidor SMTP (Host)."}
    if not user or not password:
        return {"ok": False, "error": "Faltan credenciales de correo (Usuario o Contraseña de aplicación)."}
    if not to_email or "@" not in to_email:
        return {"ok": False, "error": "El correo destinatario no es válido."}

    # Crear el mensaje MIME
    msg = MIMEMultipart("mixed")
    msg["From"] = f'"{sender_name}" <{sender_email}>'
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)

    # Contenedor alternativo para texto plano y HTML
    msg_alt = MIMEMultipart("alternative")
    plain_fallback = text_content or "Por favor visualice este correo en un cliente compatible con HTML."
    msg_alt.attach(MIMEText(plain_fallback, "plain", "utf-8"))
    msg_alt.attach(MIMEText(html_content, "html", "utf-8"))
    msg.attach(msg_alt)

    # Adjuntar archivo si existe
    if attachment_filename and attachment_bytes:
        part = MIMEApplication(attachment_bytes, Name=attachment_filename)
        part["Content-Disposition"] = f'attachment; filename="{attachment_filename}"'
        msg.attach(part)

    try:
        if security == "SSL/TLS" or port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as server:
                server.login(user, password)
                server.sendmail(sender_email, [to_email], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=15) as server:
                server.ehlo()
                if security != "NONE":
                    context = ssl.create_default_context()
                    server.starttls(context=context)
                    server.ehlo()
                server.login(user, password)
                server.sendmail(sender_email, [to_email], msg.as_string())

        return {"ok": True, "message": f"Correo enviado exitosamente a {to_email}"}

    except smtplib.SMTPAuthenticationError as e:
        return {
            "ok": False,
            "error": "Fallo de autenticación con el servidor SMTP. "
                     "Verifica que el usuario y la contraseña de aplicación sean correctos. "
                     f"Detalle: {e}"
        }
    except smtplib.SMTPConnectError as e:
        return {
            "ok": False,
            "error": f"No se pudo conectar al servidor SMTP {host}:{port}. Revisa el host y puerto. Detalle: {e}"
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"Error al conectar o enviar el correo: {str(e)}"
        }


def generate_report_html(
    report_title: str,
    filters_desc: str,
    summary_kpis: list,
    headers: list,
    rows: list,
    notes: Optional[str] = None
) -> str:
    """
    Genera una plantilla HTML limpia y ejecutiva para los reportes enviados por correo.
    """
    now_str = datetime.now().strftime("%d/%m/%Y %H:%M:%S")

    # Tarjetas de KPI
    kpis_html = ""
    for k in summary_kpis:
        kpis_html += f"""
        <td style="background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; padding: 14px 18px; text-align: left; vertical-align: top;">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748B; font-weight: 700; margin-bottom: 4px;">{k.get('label', '')}</div>
            <div style="font-size: 20px; font-weight: 800; color: #0F172A; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">{k.get('value', '0')}</div>
            <div style="font-size: 10px; color: #94A3B8; margin-top: 2px;">{k.get('hint', '')}</div>
        </td>
        """

    # Filas de tabla
    table_headers_html = "".join([f'<th style="background-color: #0F172A; color: #FFFFFF; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; text-align: left;">{h}</th>' for h in headers])
    
    table_rows_html = ""
    for idx, r in enumerate(rows[:200]): # Mostrar hasta 200 filas en el cuerpo
        bg_color = "#FFFFFF" if idx % 2 == 0 else "#F8FAFC"
        cells_html = "".join([f'<td style="padding: 10px 12px; font-size: 12px; color: #334155; border-bottom: 1px solid #E2E8F0;">{c}</td>' for c in r])
        table_rows_html += f'<tr style="background-color: {bg_color};">{cells_html}</tr>'

    notes_section = ""
    if notes and notes.strip():
        notes_section = f"""
        <div style="margin-top: 20px; padding: 14px 18px; background-color: #FEF3C7; border-left: 4px solid #F59E0B; border-radius: 8px; color: #92400E; font-size: 12px; line-height: 1.5;">
            <strong>Nota adjunta:</strong> {notes.strip()}
        </div>
        """

    return f"""
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>{report_title}</title>
    </head>
    <body style="margin: 0; padding: 24px; background-color: #F1F5F9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0F172A;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 820px; margin: 0 auto; background-color: #FFFFFF; border-radius: 16px; border: 1px solid #E2E8F0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <!-- HEADER -->
            <tr>
                <td style="padding: 28px 32px; background-color: #18181B; color: #FFFFFF;">
                    <table width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            <td>
                                <div style="display: inline-block; font-size: 10px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase; background-color: rgba(255,255,255,0.15); padding: 4px 8px; border-radius: 6px; margin-bottom: 8px;">ACCESS Biométrico</div>
                                <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.5px;">{report_title}</h1>
                                <p style="margin: 6px 0 0 0; font-size: 12px; color: #A1A1AA;">{filters_desc}</p>
                            </td>
                            <td style="text-align: right; vertical-align: top;">
                                <div style="font-size: 11px; color: #A1A1AA; font-mono: monospace;">Emitido:</div>
                                <div style="font-size: 12px; font-weight: 600; color: #F4F4F5;">{now_str}</div>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>

            <!-- CONTENIDO -->
            <tr>
                <td style="padding: 28px 32px;">
                    <!-- KPIS -->
                    <table width="100%" cellspacing="8" cellpadding="0" style="margin-bottom: 24px;">
                        <tr>
                            {kpis_html}
                        </tr>
                    </table>

                    {notes_section}

                    <!-- TABLA DE REGISTROS -->
                    <div style="margin-top: 24px; overflow-x: auto; border: 1px solid #E2E8F0; border-radius: 10px;">
                        <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse: collapse;">
                            <thead>
                                <tr>
                                    {table_headers_html}
                                </tr>
                            </thead>
                            <tbody>
                                {table_rows_html}
                            </tbody>
                        </table>
                    </div>
                    {f'<p style="font-size: 11px; color: #64748B; margin-top: 8px;">Mostrando las primeras {min(len(rows), 200)} filas en el correo. El reporte completo está disponible en el archivo adjunto.</p>' if len(rows) > 200 else ''}
                </td>
            </tr>

            <!-- FOOTER -->
            <tr>
                <td style="padding: 20px 32px; background-color: #F8FAFC; border-top: 1px solid #E2E8F0; font-size: 11px; color: #64748B; text-align: center;">
                    Este reporte fue generado y enviado automáticamente por <strong>ACCESS</strong> (Plataforma de Control de Asistencia y Sincronización ISAPI).
                </td>
            </tr>
        </table>
    </body>
    </html>
    """
