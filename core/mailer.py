"""
ACCESS — Servicio de Envío de Correos y Generación de Reportes (SMTP)
Soporta Gmail (Contraseñas de aplicación), Outlook / Office 365 y servidores SMTP corporativos.
"""

import io
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication
from email.mime.image import MIMEImage
from email.utils import formatdate, formataddr
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional

import core.database as db

ASSETS_DIR = Path(__file__).parent.parent / "assets"


def _load_logo_png_bytes(ico_name: str, size: int = 96) -> Optional[bytes]:
    """Convierte un archivo .ico de assets/ a PNG en memoria para adjuntarlo vía CID en correos."""
    ico_path = ASSETS_DIR / ico_name
    if not ico_path.exists():
        return None
    try:
        from PIL import Image
        with Image.open(ico_path) as im:
            im = im.convert("RGBA")
            im = im.resize((size, size), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            return buf.getvalue()
    except Exception:
        return None


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
    sender_name = (cfg.get("remitente_nombre") or "notificaciones@access.com").strip()
    raw_sender_email = (cfg.get("remitente_email") or "").strip()
    sender_email = raw_sender_email if ("@" in raw_sender_email) else user

    if not host:
        return {"ok": False, "error": "No se ha configurado el servidor SMTP (Host)."}
    if not user or not password:
        return {"ok": False, "error": "Faltan credenciales de correo (Usuario o Contraseña de aplicación)."}
    if "@" not in sender_email:
        return {"ok": False, "error": "El Usuario / Correo Remitente debe ser una dirección de correo válida con dominio (ej. correo@empresa.com)."}
    if not to_email or "@" not in to_email:
        return {"ok": False, "error": "El correo destinatario no es válido."}

    # Crear el mensaje MIME
    msg = MIMEMultipart("mixed")
    msg["From"] = formataddr((sender_name, sender_email))
    msg["To"] = to_email
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)

    # Contenedor alternativo para texto plano y HTML
    msg_alt = MIMEMultipart("alternative")
    plain_fallback = text_content or "Por favor visualice este correo en un cliente compatible con HTML."
    msg_alt.attach(MIMEText(plain_fallback, "plain", "utf-8"))
    msg_alt.attach(MIMEText(html_content, "html", "utf-8"))

    # Adjuntar logos inline vía CID si la plantilla los referencia
    cid_assets = [
        ("access-logo-white", "access_light.ico", 96),
        ("access-logo-dark", "access_dark.ico", 64),
    ]
    inline_images = []
    for cid, filename, px in cid_assets:
        if f"cid:{cid}" in (html_content or ""):
            png_bytes = _load_logo_png_bytes(filename, size=px)
            if png_bytes:
                img_part = MIMEImage(png_bytes, _subtype="png")
                img_part.add_header("Content-ID", f"<{cid}>")
                img_part.add_header("Content-Disposition", "inline", filename=f"{cid}.png")
                inline_images.append(img_part)

    if inline_images:
        msg_related = MIMEMultipart("related")
        msg_related.attach(msg_alt)
        for img_part in inline_images:
            msg_related.attach(img_part)
        msg.attach(msg_related)
    else:
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


def generate_test_email_html(
    smtp_host: str,
    sender_email: str,
    recipient_email: str,
    now_str: Optional[str] = None
) -> str:
    """Plantilla de prueba SMTP con el mismo estilo del módulo Configuración > Correo (tarjeta blanca, paneles offwhite, etiquetas en negritas, valores mono)."""
    ts = now_str or datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

    def field(label: str, value: str, col_w: str = "50%") -> str:
        return f"""
        <td width="{col_w}" style="padding: 6px; vertical-align: top;">
            <div style="font-size: 12px; font-weight: 700; color: #1F2937; margin-bottom: 4px;">{label}</div>
            <div style="padding: 10px 14px; border: 1px solid #D4D4D8; border-radius: 12px; background-color: #FFFFFF; font-family: {mono}; font-size: 12px; color: #18181B;">{value}</div>
        </td>
        """

    return f"""
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>Prueba de Conexión SMTP — ACCESS</title>
    </head>
    <body style="margin: 0; padding: 28px 16px; background-color: #E9ECF1; font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181B;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border-radius: 24px; border: 1px solid #D4D4D8;">
            <tr>
                <td style="padding: 24px 28px 0 28px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            <td style="vertical-align: top;">
                                <table role="presentation" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td style="width: 34px; height: 34px; background-color: #F4F4F5; border-radius: 10px; text-align: center; vertical-align: middle;">
                                            <img src="cid:access-logo-dark" width="18" height="18" alt="ACCESS" style="display: inline-block; border: 0; vertical-align: middle;" />
                                        </td>
                                        <td style="padding-left: 10px; vertical-align: middle;">
                                            <div style="font-size: 14px; font-weight: 600; color: #18181B;">Prueba de Conexión SMTP</div>
                                            <div style="font-size: 11px; color: #71717A; margin-top: 1px;">Servidor de correo para Pre-Nómina y Reportes</div>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                            <td style="text-align: right; vertical-align: top; white-space: nowrap;">
                                <span style="font-size: 11px; font-weight: 600; color: #18181B;"><span style="color: #10B981; font-size: 13px;">&#9679;</span>&nbsp;SMTP Conectado</span>
                            </td>
                        </tr>
                    </table>
                    <p style="margin: 14px 0 0 0; font-size: 12px; color: #52525B; line-height: 1.55;">
                        Este mensaje confirma que ACCESS puede enviar correos con la configuración actual. Ya puedes enviar pre-nómina, bitácoras de incidencias y reportes a RH y gerencia directamente por correo.
                    </p>
                </td>
            </tr>

            <tr>
                <td style="padding: 18px 28px 6px 28px;">
                    <div style="padding: 14px; border: 1px solid #D4D4D8; border-radius: 16px; background-color: #F9FAFB;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                                <td style="padding: 0 6px 6px 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #71717A;" colspan="2">Detalles de verificación</td>
                            </tr>
                            <tr>
                                {field("Servidor SMTP (Host)", smtp_host, "100%")}
                            </tr>
                        </table>
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                                {field("Usuario / Correo Remitente", sender_email)}
                                {field("Destinatario", recipient_email)}
                            </tr>
                            <tr>
                                {field("Fecha y hora de la prueba", ts, "100%")}
                            </tr>
                        </table>
                    </div>
                </td>
            </tr>

            <tr>
                <td style="padding: 12px 28px 20px 28px;">
                    <div style="padding: 11px 14px; border: 1px solid #D4D4D8; border-radius: 16px; background-color: #F4F4F5; font-size: 12px; font-weight: 500; color: #27272A;">
                        <span style="color: #71717A; font-size: 14px; vertical-align: middle;">&#10003;</span>&nbsp;&nbsp;¡Correo de prueba enviado con éxito!
                    </div>
                </td>
            </tr>

            <tr>
                <td style="padding: 16px 28px; border-top: 1px solid #F4F4F5; text-align: center;">
                    <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                        <tr>
                            <td style="vertical-align: middle; padding-right: 6px;">
                                <img src="cid:access-logo-dark" width="14" height="14" alt="ACCESS" style="display: block; border: 0;" />
                            </td>
                            <td style="vertical-align: middle; font-size: 11px; color: #71717A;">
                                Enviado automáticamente por <strong style="color: #18181B;">ACCESS</strong> • Control Biométrico y Pre-Nómina
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    """


def generate_report_html(
    report_title: str,
    filters_desc: str,
    summary_kpis: list,
    headers: list,
    rows: list,
    notes: Optional[str] = None
) -> str:
    """
    Genera una plantilla HTML ejecutiva alineada al diseño monocromático de ACCESS.
    """
    now_str = datetime.now().strftime("%d/%m/%Y %H:%M:%S")

    # Tarjetas de KPI agrupadas en filas de máximo 4 tarjetas
    kpis_rows_html = ""
    if summary_kpis:
        for i in range(0, len(summary_kpis), 4):
            chunk = summary_kpis[i:i + 4]
            cells = ""
            col_w = int(100 / max(len(chunk), 1))
            for k in chunk:
                val_str = str(k.get("value", "0"))
                lbl_str = str(k.get("label", ""))
                is_retardo_kpi = "RETARDO" in lbl_str.upper() and val_str not in ("0", "0.0", "")
                val_color = "#E11D48" if is_retardo_kpi else "#18181B"
                cells += f"""
                <td width="{col_w}%" style="padding: 4px; vertical-align: top;">
                    <div style="background-color: #FFFFFF; border: 1px solid #E4E4E7; border-radius: 16px; padding: 14px 16px;">
                        <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: #71717A; font-weight: 700; margin-bottom: 6px;">{lbl_str}</div>
                        <div style="font-size: 22px; font-weight: 900; color: {val_color}; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.1;">{val_str}</div>
                        {f'<div style="font-size: 10px; color: #A1A1AA; margin-top: 4px;">{k.get("hint", "")}</div>' if k.get("hint") else ''}
                    </div>
                </td>
                """
            kpis_rows_html += f"<tr>{cells}</tr>"

    # Encabezados de tabla estilo ViewReportes
    table_headers_html = "".join([
        f'<th style="background-color: #F4F4F5; color: #71717A; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; padding: 11px 12px; text-align: left; border-bottom: 1px solid #E4E4E7;">{h}</th>'
        for h in headers
    ])

    table_rows_html = ""
    for idx, r in enumerate(rows[:200]):
        bg_color = "#FFFFFF" if idx % 2 == 0 else "#FAFAFA"
        cells_html = ""
        for cell_idx, c in enumerate(r):
            c_str = str(c)
            c_upper = c_str.upper()
            text_color = "#3F3F46"
            font_weight = "500"
            if cell_idx == 0:
                text_color = "#18181B"
                font_weight = "700"
            elif "RETARDO" in c_upper:
                text_color = "#E11D48"
                font_weight = "700"
            elif "ASISTENCIA PUNTUAL" in c_upper or "VÁLIDO" in c_upper or c_upper == "ONLINE":
                text_color = "#18181B"
                font_weight = "700"
            elif "SIN REGISTROS" in c_upper or "REBOTE" in c_upper:
                text_color = "#A1A1AA"
                font_weight = "600"
            cells_html += f'<td style="padding: 10px 12px; font-size: 12px; color: {text_color}; font-weight: {font_weight}; border-bottom: 1px solid #F4F4F5;">{c_str}</td>'
        table_rows_html += f'<tr style="background-color: {bg_color};">{cells_html}</tr>'

    notes_section = ""
    if notes and notes.strip():
        notes_section = f"""
        <div style="margin-top: 16px; margin-bottom: 16px; padding: 14px 18px; background-color: #F4F4F5; border: 1px solid #E4E4E7; border-left: 4px solid #18181B; border-radius: 12px; color: #27272A; font-size: 12px; line-height: 1.5;">
            <strong style="color: #18181B;">&#9998; Nota adjunta:</strong> {notes.strip()}
        </div>
        """

    return f"""
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>{report_title}</title>
    </head>
    <body style="margin: 0; padding: 24px; background-color: #F9FAFB; font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #18181B;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 840px; margin: 0 auto; background-color: #FFFFFF; border-radius: 24px; border: 1px solid #E4E4E7; overflow: hidden;">
            <!-- HEADER -->
            <tr>
                <td style="padding: 26px 30px; background-color: #18181B; color: #FFFFFF;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                        <tr>
                            <td style="vertical-align: middle;">
                                <table role="presentation" cellspacing="0" cellpadding="0">
                                    <tr>
                                        <td style="width: 40px; height: 40px; background-color: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); border-radius: 12px; text-align: center; vertical-align: middle;">
                                            <img src="cid:access-logo-white" width="22" height="22" alt="ACCESS" style="display: inline-block; border: 0; vertical-align: middle;" />
                                        </td>
                                        <td style="padding-left: 12px; vertical-align: middle;">
                                            <div style="font-size: 12px; font-weight: 800; letter-spacing: 1px; color: #FFFFFF; text-transform: uppercase;">ACCESS</div>
                                            <div style="font-size: 11px; color: #A1A1AA;">Control Biométrico y Pre-Nómina</div>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                            <td style="text-align: right; vertical-align: top;">
                                <div style="font-size: 10px; color: #A1A1AA; text-transform: uppercase; letter-spacing: 0.6px;">Emitido</div>
                                <div style="font-size: 12px; font-weight: 600; color: #F4F4F5; font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px;">{now_str}</div>
                            </td>
                        </tr>
                    </table>
                    <h1 style="margin: 18px 0 0 0; font-size: 21px; font-weight: 800; color: #FFFFFF; letter-spacing: -0.4px;">{report_title}</h1>
                    <p style="margin: 6px 0 0 0; font-size: 12px; color: #A1A1AA;">{filters_desc}</p>
                </td>
            </tr>

            <!-- CONTENIDO -->
            <tr>
                <td style="padding: 24px 28px;">
                    <!-- KPIS -->
                    {f'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 18px;">{kpis_rows_html}</table>' if kpis_rows_html else ''}

                    {notes_section}

                    <!-- TABLA DE REGISTROS -->
                    <div style="margin-top: 16px; border: 1px solid #E4E4E7; border-radius: 16px; overflow: hidden; background-color: #FFFFFF;">
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
                    {f'<p style="font-size: 11px; color: #71717A; margin-top: 10px;">Mostrando las primeras {min(len(rows), 200)} filas en el correo. El reporte completo está disponible en el archivo CSV adjunto.</p>' if len(rows) > 200 else ''}
                </td>
            </tr>

            <!-- FOOTER -->
            <tr>
                <td style="padding: 18px 28px; background-color: #F9FAFB; border-top: 1px solid #E4E4E7; text-align: center;">
                    <table role="presentation" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                        <tr>
                            <td style="vertical-align: middle; padding-right: 6px;">
                                <img src="cid:access-logo-dark" width="14" height="14" alt="ACCESS" style="display: block; border: 0;" />
                            </td>
                            <td style="vertical-align: middle; font-size: 11px; color: #71717A;">
                                Reporte generado automáticamente por <strong style="color: #18181B;">ACCESS</strong> • Plataforma Cloud de Asistencia Biométrica
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    """
