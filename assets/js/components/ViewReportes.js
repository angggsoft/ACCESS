// Component: ViewReportes
// Módulo Integral de Reportes de Asistencia, Pre-Nómina, Auditoría de Relojes y Envío por Correo (SMTP)

import { ref, computed, watch, onMounted } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewReportes',
  components: { ModalBase },
  props: {
    records: { type: Array, default: () => [] },
    employees: { type: Array, default: () => [] },
    devices: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    branches: { type: Array, default: () => [] },
    companyAreas: { type: Array, default: () => [] },
    companyDevices: { type: Array, default: () => [] },
    summary: { type: Object, default: () => ({}) },
    empresaId: { type: [Number, String, null], default: null },
    sucursalId: { type: [Number, String, null], default: null }
  },
  emits: ['toast'],
  setup(props, { emit }) {
    // Tipo de reporte activo
    const activeReportType = ref('empleados'); // 'empleados' | 'bitacora' | 'relojes' | 'areas'

    const reportTypes = [
      { id: 'empleados', label: 'Pre-Nómina y Colaboradores', icon: 'ph-users-three', desc: 'Resumen de asistencia, horas, primera y última checada por persona.' },
      { id: 'bitacora', label: 'Bitácora Detallada', icon: 'ph-list-dashes', desc: 'Registro pormenorizado de cada marcaje con método, hora y estatus.' },
      { id: 'relojes', label: 'Auditoría por Reloj', icon: 'ph-fingerprint', desc: 'Eventos procesados, IP, métodos usados y estado de cada terminal.' },
      { id: 'areas', label: 'Consolidado por Áreas', icon: 'ph-buildings', desc: 'Cobertura de plantilla, asistencia y turnos por departamento.' }
    ];

    // Filtros de búsqueda
    const datePreset = ref('mes'); // 'hoy' | 'ayer' | 'semana' | 'quincena' | 'mes' | 'todos' | 'custom'
    const customStartDate = ref('');
    const customEndDate = ref('');
    const filterBranch = ref('TODAS');
    const filterEmployee = ref('TODOS');
    const filterReloj = ref('TODOS');
    const filterArea = ref('TODAS');
    const filterStatus = ref('todos'); // 'todos' | 'validas' | 'rebotes'
    const searchQuery = ref('');

    const effectiveSucursalParam = computed(() => {
      return filterBranch.value === 'TODAS' ? '0' : String(filterBranch.value);
    });

    const availableEmployees = computed(() => {
      if (filterBranch.value === 'TODAS') return props.employees || [];
      return (props.employees || []).filter(e => Number(e.sucursal_id) === Number(filterBranch.value));
    });

    const availableDevices = computed(() => {
      const pool = (props.companyDevices && props.companyDevices.length) ? props.companyDevices : (props.devices || []);
      if (filterBranch.value === 'TODAS') return pool;
      return pool.filter(d => Number(d.sucursal_id) === Number(filterBranch.value));
    });

    const availableAreaOptions = computed(() => {
      const basePool = (props.companyAreas && props.companyAreas.length) ? props.companyAreas : (props.areas || []);
      const pool = filterBranch.value === 'TODAS'
        ? basePool
        : basePool.filter(a => Number(a.sucursal_id) === Number(filterBranch.value));
      const seen = new Set();
      const out = [];
      for (const a of pool) {
        if (!a?.nombre || seen.has(a.nombre)) continue;
        seen.add(a.nombre);
        out.push(a.nombre);
      }
      return out;
    });

    // Estado del dataset cargado desde backend
    const reportData = ref({
      title: 'Pre-Nómina y Asistencia por Colaborador',
      summary: {},
      headers: [],
      data: []
    });
    const isLoading = ref(false);

    // Estado del Modal de Envío por Correo
    const isEmailModalOpen = ref(false);
    const emailSending = ref(false);
    const emailForm = ref({
      to_email: '',
      subject: '',
      notes: '',
      attach_csv: true
    });
    const emailConfig = ref({
      is_configured: false,
      smtp_user: '',
      destinatario_default: ''
    });

    // Estado del Modal de Configuración SMTP directa
    const isConfigModalOpen = ref(false);
    const smtpForm = ref({
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_security: 'STARTTLS',
      smtp_user: '',
      smtp_password: '',
      remitente_nombre: 'notificaciones@access.com',
      remitente_email: '',
      destinatario_default: ''
    });
    const showSmtpPass = ref(false);
    const isSavingSmtp = ref(false);
    const isTestingSmtp = ref(false);
    const smtpFeedback = ref({ type: '', message: '' });

    // Estado del Modal CONTPAQi Nóminas (.txt ancho fijo)
    const isContpaqiModalOpen = ref(false);
    const isExportingContpaqi = ref(false);
    const contpaqiForm = ref({
      area_nombre: 'TODAS',
      tipo_periodo: 'Quincenal',
      numero_periodo: 1,
      ejercicio: new Date().getFullYear(),
      concepto_falta: 'Faltas injustificadas',
      concepto_retardo: 'Retardos',
      concepto_extra: 'Horas extras dobles'
    });

    function openContpaqiModal() {
      contpaqiForm.value.ejercicio = new Date().getFullYear();
      contpaqiForm.value.area_nombre = (filterArea.value && filterArea.value !== 'TODAS') ? filterArea.value : 'TODAS';
      isContpaqiModalOpen.value = true;
    }

    async function downloadContpaqiTxt() {
      isExportingContpaqi.value = true;
      try {
        const params = new URLSearchParams({
          start_date: customStartDate.value || '',
          end_date: customEndDate.value || '',
          area_nombre: contpaqiForm.value.area_nombre || 'TODAS',
          tipo_periodo: contpaqiForm.value.tipo_periodo,
          numero_periodo: String(contpaqiForm.value.numero_periodo || 1),
          ejercicio: String(contpaqiForm.value.ejercicio || new Date().getFullYear()),
          concepto_falta: contpaqiForm.value.concepto_falta || 'Faltas injustificadas',
          concepto_retardo: contpaqiForm.value.concepto_retardo || 'Retardos',
          concepto_extra: contpaqiForm.value.concepto_extra || 'Horas extras dobles'
        });
        if (props.empresaId) params.set('empresa_id', String(props.empresaId));
        params.set('sucursal_id', effectiveSucursalParam.value);

        const res = await fetch(`/api/reports/export-contpaqi?${params.toString()}`);
        if (!res.ok) {
          emit('toast', 'Error al generar archivo para CONTPAQi', 'error');
          return;
        }
        const blob = await res.blob();
        if (blob.size === 0) {
          emit('toast', 'No se detectaron faltas, retardos ni horas extra en el periodo seleccionado', 'info');
          isContpaqiModalOpen.value = false;
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `CONTPAQi_Incidencias_P${contpaqiForm.value.numero_periodo || 1}.txt`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        isContpaqiModalOpen.value = false;
        emit('toast', 'Layout CONTPAQi (.txt) generado y descargado');
      } catch (e) {
        emit('toast', 'Error de red al exportar archivo CONTPAQi', 'error');
      } finally {
        isExportingContpaqi.value = false;
      }
    }

    // Calcular fechas según preset
    function updateDatePreset(preset) {
      datePreset.value = preset;
      const today = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const formatYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      if (preset === 'hoy') {
        const str = formatYMD(today);
        customStartDate.value = str;
        customEndDate.value = str;
      } else if (preset === 'ayer') {
        const y = new Date();
        y.setDate(today.getDate() - 1);
        const str = formatYMD(y);
        customStartDate.value = str;
        customEndDate.value = str;
      } else if (preset === 'semana') {
        const d = new Date();
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        customStartDate.value = formatYMD(monday);
        customEndDate.value = formatYMD(today);
      } else if (preset === 'quincena') {
        const year = today.getFullYear();
        const month = today.getMonth();
        if (today.getDate() <= 15) {
          customStartDate.value = `${year}-${pad(month + 1)}-01`;
          customEndDate.value = `${year}-${pad(month + 1)}-15`;
        } else {
          customStartDate.value = `${year}-${pad(month + 1)}-16`;
          const lastDay = new Date(year, month + 1, 0).getDate();
          customEndDate.value = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
        }
      } else if (preset === 'mes') {
        const year = today.getFullYear();
        const month = today.getMonth();
        customStartDate.value = `${year}-${pad(month + 1)}-01`;
        const lastDay = new Date(year, month + 1, 0).getDate();
        customEndDate.value = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
      } else if (preset === 'todos') {
        customStartDate.value = '';
        customEndDate.value = '';
      }
      fetchReport();
    }

    // Consulta del reporte al backend con filtros
    async function fetchReport() {
      isLoading.value = true;
      try {
        const params = new URLSearchParams({
          type: activeReportType.value,
          start_date: customStartDate.value || '',
          end_date: customEndDate.value || '',
          employee_id: filterEmployee.value,
          area: filterArea.value,
          reloj: filterReloj.value,
          status: filterStatus.value
        });
        if (props.empresaId) params.set('empresa_id', props.empresaId);
        params.set('sucursal_id', effectiveSucursalParam.value);
        const res = await fetch(`/api/reports/query?${params.toString()}`);
        if (!res.ok) return;
        const json = await res.json();
        if (json.report) {
          reportData.value = json.report;
        }
      } catch (e) {
        console.error('Error fetching report:', e);
      } finally {
        isLoading.value = false;
      }
    }

    // Cargar configuración de correo
    async function loadEmailConfig() {
      try {
        const res = await fetch('/api/email/config');
        if (!res.ok) return;
        const json = await res.json();
        if (json.config) {
          emailConfig.value = json.config;
          smtpForm.value = {
            ...smtpForm.value,
            ...json.config,
            smtp_password: json.config.has_password ? '••••••••' : ''
          };
          if (!emailForm.value.to_email) {
            emailForm.value.to_email = json.config.destinatario_default || '';
          }
        }
      } catch (e) {
        // silent
      }
    }

    // Filtrar tabla en cliente por buscador de texto
    const filteredRows = computed(() => {
      const q = searchQuery.value.trim().toLowerCase();
      if (!q) return reportData.value.data || [];
      return (reportData.value.data || []).filter(item => {
        return Object.values(item).some(val => String(val).toLowerCase().includes(q));
      });
    });

    // Guardar ajustes SMTP desde modal
    async function saveSmtpSettings() {
      isSavingSmtp.value = true;
      smtpFeedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/email/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(smtpForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          smtpFeedback.value = { type: 'success', message: 'Configuración SMTP guardada correctamente.' };
          await loadEmailConfig();
          emit('toast', 'Ajustes de correo guardados', 'info');
        } else {
          smtpFeedback.value = { type: 'error', message: data.detail || 'Error al guardar.' };
        }
      } catch (e) {
        smtpFeedback.value = { type: 'error', message: 'Error de conexión.' };
      } finally {
        isSavingSmtp.value = false;
      }
    }

    // Probar envío SMTP
    async function testSmtpSettings() {
      isTestingSmtp.value = true;
      smtpFeedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/email/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...smtpForm.value,
            to_email: smtpForm.value.destinatario_default || smtpForm.value.smtp_user
          })
        });
        const data = await res.json();
        if (res.ok) {
          smtpFeedback.value = { type: 'success', message: '¡Correo de prueba enviado con éxito!' };
          emit('toast', 'Correo de prueba enviado', 'info');
        } else {
          smtpFeedback.value = { type: 'error', message: data.detail || 'Fallo en la prueba.' };
        }
      } catch (e) {
        smtpFeedback.value = { type: 'error', message: 'Error al conectar.' };
      } finally {
        isTestingSmtp.value = false;
      }
    }

    // Abrir modal de envío por correo
    function openSendEmailModal() {
      const today = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
      emailForm.value.subject = `ACCESS — ${reportData.value.title || 'Reporte de Asistencia'} (${today})`;
      emailForm.value.to_email = emailConfig.value.destinatario_default || '';
      emailForm.value.notes = '';
      emailForm.value.attach_csv = true;
      isEmailModalOpen.value = true;
    }

    // Ejecutar envío por correo
    async function sendReportEmail() {
      if (!emailForm.value.to_email || !emailForm.value.to_email.includes('@')) {
        emit('toast', 'Ingresa un correo destinatario válido', 'error');
        return;
      }

      emailSending.value = true;
      try {
        const payload = {
          to_email: emailForm.value.to_email,
          subject: emailForm.value.subject,
          notes: emailForm.value.notes,
          report_type: activeReportType.value,
          start_date: customStartDate.value || null,
          end_date: customEndDate.value || null,
          employee_id: filterEmployee.value,
          area: filterArea.value,
          reloj: filterReloj.value,
          status: filterStatus.value,
          attach_csv: emailForm.value.attach_csv,
          empresa_id: props.empresaId,
          sucursal_id: effectiveSucursalParam.value
        };

        const res = await fetch('/api/reports/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok) {
          isEmailModalOpen.value = false;
          emit('toast', `Reporte enviado con éxito a ${payload.to_email}`, 'info');
        } else {
          emit('toast', data.detail || 'Error al enviar el correo.', 'error');
        }
      } catch (e) {
        emit('toast', 'Error al comunicarse con el servidor.', 'error');
      } finally {
        emailSending.value = false;
      }
    }

    // Exportar CSV directamente desde el navegador
    function exportCurrentReportCsv() {
      const headers = reportData.value.headers || [];
      const rows = [headers];
      const items = filteredRows.value;

      if (activeReportType.value === 'empleados') {
        items.forEach(r => {
          rows.push([
            r.codigo_empleado,
            `"${(r.nombre || '').replace(/"/g, '""')}"`,
            `"${(r.area_nombre || '').replace(/"/g, '""')}"`,
            `"${(r.turno || '').replace(/"/g, '""')}"`,
            r.dias_asistidos ?? r.dias_activos,
            r.retardos ?? 0,
            r.dias_incompletos ?? 0,
            r.horas_trabajadas ?? 0,
            r.total_validas,
            r.total_rebotes,
            `"${(r.estatus || '').replace(/"/g, '""')}"`
          ]);
        });
      } else if (activeReportType.value === 'bitacora') {
        items.forEach(r => {
          rows.push([
            r.id,
            r.codigo_empleado,
            `"${(r.nombre || '').replace(/"/g, '""')}"`,
            `"${(r.area || '').replace(/"/g, '""')}"`,
            `"${(r.reloj_nombre || '').replace(/"/g, '""')}"`,
            r.metodo,
            r.fecha_hora_display,
            r.es_rebote ? 'REBOTE_IGNORADO' : 'VALIDO'
          ]);
        });
      } else if (activeReportType.value === 'relojes') {
        items.forEach(r => {
          rows.push([
            `"${(r.nombre || '').replace(/"/g, '""')}"`,
            r.ip,
            r.modelo,
            `"${(r.ubicacion || '').replace(/"/g, '""')}"`,
            r.total_eventos_periodo,
            r.validas,
            r.rebotes,
            r.usuarios_distintos,
            r.ultima_actividad,
            r.estado
          ]);
        });
      } else if (activeReportType.value === 'areas') {
        items.forEach(r => {
          rows.push([
            r.codigo,
            `"${(r.nombre || '').replace(/"/g, '""')}"`,
            `"${(r.responsable || '').replace(/"/g, '""')}"`,
            `"${(r.turno || '').replace(/"/g, '""')}"`,
            `"${(r.horario || '').replace(/"/g, '""')}"`,
            r.plantilla,
            r.colaboradores_presentes,
            `${r.cobertura_pct}%`,
            r.total_validas
          ]);
        });
      }

      const csvContent = '\uFEFF' + rows.map(e => e.join(',')).join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      const dateStr = new Date().toISOString().slice(0, 10);
      link.setAttribute('download', `reporte_${activeReportType.value}_${dateStr}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      emit('toast', 'Archivo CSV descargado', 'info');
    }

    // Estado del Modal de Resumen de Retardos e Incidencias por Colaborador
    const isIncidenciasModalOpen = ref(false);
    const isLoadingIncidencias = ref(false);
    const selectedEmpIncidencias = ref(null);
    const incidenciasFilterTab = ref('incidencias'); // 'incidencias' | 'todos'

    const displayedIncidenciasRows = computed(() => {
      const emp = selectedEmpIncidencias.value;
      if (!emp) return [];
      if (incidenciasFilterTab.value === 'incidencias') {
        return emp.incidencias_detalle || [];
      }
      return emp.dias_detalle || [];
    });

    function buildIncidenciasFallbackFromBitacora(records) {
      const byDay = new Map();
      for (const rec of records || []) {
        if (rec.es_rebote) continue;
        const dtStr = String(rec.fecha_hora_display || rec.fecha_hora_evento || '').replace('T', ' ').slice(0, 19);
        const dayKey = dtStr.slice(0, 10);
        if (!dayKey) continue;
        if (!byDay.has(dayKey)) byDay.set(dayKey, []);
        byDay.get(dayKey).push({ ...rec, _dtStr: dtStr });
      }

      let minutosRetardoTotal = 0;
      const diasDetalle = [];

      for (const [dayKey, dayRecs] of byDay.entries()) {
        dayRecs.sort((a, b) => a._dtStr.localeCompare(b._dtStr));
        const firstRec = dayRecs[0];
        const lastRec = dayRecs[dayRecs.length - 1];
        const entrada = firstRec._dtStr.length >= 19 ? firstRec._dtStr.slice(11, 19) : firstRec._dtStr;
        const isIncompleto = dayRecs.length === 1;
        const salida = isIncompleto
          ? 'Sin salida'
          : (lastRec._dtStr.length >= 19 ? lastRec._dtStr.slice(11, 19) : lastRec._dtStr);

        let horas = 0;
        if (!isIncompleto) {
          const dt1 = new Date(firstRec._dtStr.replace(' ', 'T'));
          const dt2 = new Date(lastRec._dtStr.replace(' ', 'T'));
          const diffMs = dt2.getTime() - dt1.getTime();
          if (!Number.isNaN(diffMs) && diffMs > 0) {
            horas = Math.round((diffMs / 3600000) * 10) / 10;
          }
        }

        const estatusEntrada = firstRec.estatus_prenomina || 'PUNTUAL';
        const esRetardo = estatusEntrada.startsWith('RETARDO');
        let minutosRetardo = 0;
        if (esRetardo) {
          const matchMin = estatusEntrada.match(/\+(\d+)\s*min/i);
          minutosRetardo = matchMin ? parseInt(matchMin[1], 10) : 0;
          minutosRetardoTotal += minutosRetardo;
        }

        const esManual = dayRecs.some(r => Boolean(r.es_manual));
        const notasDia = [...new Set(dayRecs.map(r => (r.nota_incidencia || '').trim()).filter(Boolean))].join(' • ');

        const tiposIncidencia = [];
        if (esRetardo) tiposIncidencia.push(estatusEntrada);
        if (isIncompleto) tiposIncidencia.push('DÍA INCOMPLETO (Sin salida)');
        if (esManual) tiposIncidencia.push('JUSTIFICADO / MANUAL');
        const tieneIncidencia = tiposIncidencia.length > 0 || Boolean(notasDia);

        diasDetalle.push({
          fecha: dayKey,
          entrada,
          salida,
          horas,
          total_checadas: dayRecs.length,
          estatus_entrada: estatusEntrada,
          es_retardo: esRetardo,
          minutos_retardo: minutosRetardo,
          es_incompleto: isIncompleto,
          es_manual: esManual,
          tiene_incidencia: tieneIncidencia,
          tipos_incidencia: tiposIncidencia,
          nota_incidencia: notasDia,
          metodo: firstRec.metodo || 'BIOMETRÍA',
          reloj: firstRec.reloj_nombre || 'Terminal'
        });
      }

      diasDetalle.sort((a, b) => b.fecha.localeCompare(a.fecha));
      return {
        diasDetalle,
        incidenciasDetalle: diasDetalle.filter(d => d.tiene_incidencia),
        minutosRetardoTotal
      };
    }

    async function openIncidenciasModal(row) {
      const areaPool = (props.companyAreas && props.companyAreas.length) ? props.companyAreas : (props.areas || []);
      const areaCfg = areaPool.find(a => a.nombre === row.area_nombre && (!row.sucursal_id || Number(a.sucursal_id) === Number(row.sucursal_id)))
        || areaPool.find(a => a.nombre === row.area_nombre);
      const baseRow = {
        ...row,
        tolerancia_min: row.tolerancia_min ?? areaCfg?.tolerancia_min ?? 10,
        horario_esperado: row.horario_esperado || areaCfg?.horario_resumen || areaCfg?.horario || row.turno || 'No definido',
        horario_detalle: row.horario_detalle || areaCfg?.horario_detalle || ''
      };

      selectedEmpIncidencias.value = baseRow;
      incidenciasFilterTab.value = (baseRow.incidencias_detalle && baseRow.incidencias_detalle.length > 0)
        ? 'incidencias'
        : 'todos';
      isIncidenciasModalOpen.value = true;

      if (!Array.isArray(row.dias_detalle) && (row.dias_asistidos > 0 || row.total_validas > 0)) {
        isLoadingIncidencias.value = true;
        try {
          const params = new URLSearchParams({
            type: 'bitacora',
            start_date: customStartDate.value || '',
            end_date: customEndDate.value || '',
            employee_id: String(row.codigo_empleado),
            reloj: filterReloj.value || 'TODOS',
            status: 'validas'
          });
          if (props.empresaId) params.set('empresa_id', String(props.empresaId));
          params.set('sucursal_id', '0');

          const res = await fetch(`/api/reports/query?${params.toString()}`);
          if (res.ok) {
            const json = await res.json();
            const records = json.report?.data || [];
            const built = buildIncidenciasFallbackFromBitacora(records);
            if (selectedEmpIncidencias.value?.codigo_empleado === row.codigo_empleado) {
              selectedEmpIncidencias.value = {
                ...baseRow,
                minutos_retardo_total: baseRow.minutos_retardo_total ?? built.minutosRetardoTotal,
                incidencias_detalle: built.incidenciasDetalle,
                dias_detalle: built.diasDetalle
              };
              incidenciasFilterTab.value = built.incidenciasDetalle.length > 0 ? 'incidencias' : 'todos';
            }
          }
        } catch (e) {
          console.error('Error loading incidencias detail:', e);
        } finally {
          isLoadingIncidencias.value = false;
        }
      } else {
        isLoadingIncidencias.value = false;
      }
    }

    // Resetear filtros
    function resetFilters() {
      filterBranch.value = 'TODAS';
      filterEmployee.value = 'TODOS';
      filterReloj.value = 'TODOS';
      filterArea.value = 'TODAS';
      filterStatus.value = 'todos';
      searchQuery.value = '';
      updateDatePreset('mes');
    }

    watch([activeReportType, filterBranch, filterEmployee, filterReloj, filterArea, filterStatus, () => props.empresaId, () => props.sucursalId], () => {
      fetchReport();
    });

    onMounted(async () => {
      updateDatePreset('mes');
      await loadEmailConfig();
    });

    return {
      activeReportType,
      reportTypes,
      datePreset,
      customStartDate,
      customEndDate,
      filterBranch,
      filterEmployee,
      filterReloj,
      filterArea,
      filterStatus,
      availableEmployees,
      availableDevices,
      availableAreaOptions,
      searchQuery,
      reportData,
      filteredRows,
      isLoading,
      updateDatePreset,
      fetchReport,
      resetFilters,
      isEmailModalOpen,
      emailSending,
      emailForm,
      emailConfig,
      openSendEmailModal,
      sendReportEmail,
      exportCurrentReportCsv,
      isConfigModalOpen,
      smtpForm,
      showSmtpPass,
      isSavingSmtp,
      isTestingSmtp,
      smtpFeedback,
      saveSmtpSettings,
      testSmtpSettings,
      loadEmailConfig,
      isContpaqiModalOpen,
      isExportingContpaqi,
      contpaqiForm,
      openContpaqiModal,
      downloadContpaqiTxt,
      isIncidenciasModalOpen,
      isLoadingIncidencias,
      selectedEmpIncidencias,
      incidenciasFilterTab,
      displayedIncidenciasRows,
      openIncidenciasModal
    };
  },
  template: `
    <div class="w-full space-y-6 animate-in fade-in duration-150 pb-12">

      <!-- SELECTOR DE TIPOS DE REPORTE (TABS EJECUTIVAS) -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <button
          v-for="rt in reportTypes"
          :key="rt.id"
          type="button"
          @click="activeReportType = rt.id"
          class="p-4 rounded-3xl border text-left transition-all cursor-pointer relative group flex flex-col justify-between"
          :class="activeReportType === rt.id 
            ? 'bg-[#18181B] text-white border-transparent shadow-md' 
            : 'bg-white hover:bg-charcoal-50/80 text-charcoal-800 border-charcoal-200 shadow-sm'">
          <div>
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-3 min-w-0">
                <span class="w-5 flex items-center justify-center shrink-0"><i :class="['ph', rt.icon, 'text-lg', activeReportType === rt.id ? 'text-white' : 'text-charcoal-400']"></i></span>
                <h4 class="font-semibold text-sm tracking-tight leading-snug truncate">{{ rt.label }}</h4>
              </div>
              <span v-if="activeReportType === rt.id" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-white/20 text-white uppercase tracking-wider shrink-0">
                Activo
              </span>
            </div>
            <p class="text-[11px] mt-1.5 pl-8 line-clamp-2" :class="activeReportType === rt.id ? 'text-charcoal-300' : 'text-charcoal-500'">
              {{ rt.desc }}
            </p>
          </div>
        </button>
      </div>

      <!-- BARRA DE FILTROS AVANZADOS -->
      <div class="bg-white rounded-3xl border border-charcoal-200 p-5 shadow-sm space-y-4">
        
        <!-- Fila Superior: Presets de Fecha y Acciones -->
        <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 border-b border-charcoal-100 pb-3">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs font-bold text-charcoal-400 uppercase tracking-wider mr-1">Periodo:</span>
            <button
              v-for="p in [
                { id: 'hoy', label: 'Hoy' },
                { id: 'ayer', label: 'Ayer' },
                { id: 'semana', label: 'Esta Semana' },
                { id: 'quincena', label: 'Esta Quincena' },
                { id: 'mes', label: 'Este Mes' },
                { id: 'todos', label: 'Histórico' },
                { id: 'custom', label: 'Personalizado' }
              ]"
              :key="p.id"
              type="button"
              @click="updateDatePreset(p.id)"
              class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
              :class="datePreset === p.id ? 'bg-charcoal-900 text-white' : 'bg-charcoal-50 hover:bg-charcoal-100 text-charcoal-700 border border-charcoal-200'">
              {{ p.label }}
            </button>
          </div>

          <button
            type="button"
            @click="resetFilters"
            class="text-xs font-semibold text-charcoal-500 hover:text-black flex items-center gap-1 cursor-pointer">
            <i class="ph ph-arrow-counter-clockwise"></i>
            <span>Limpiar Filtros</span>
          </button>
        </div>

        <!-- Fila Inferior: Selectores de Rango y Catálogos -->
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 pt-1 text-xs">
          
          <!-- Rango Desde -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Fecha Inicial</label>
            <input
              type="date"
              v-model="customStartDate"
              @change="datePreset = 'custom'; fetchReport()"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-mono focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <!-- Rango Hasta -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Fecha Final</label>
            <input
              type="date"
              v-model="customEndDate"
              @change="datePreset = 'custom'; fetchReport()"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-mono focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <!-- Filtro Sucursal Base / Ámbito -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Sucursal</label>
            <select
              v-model="filterBranch"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none truncate">
              <option value="TODAS">Todas (Cruce Empresa)</option>
              <option v-for="b in branches" :key="b.id" :value="String(b.id)">
                {{ b.nombre }}
              </option>
            </select>
          </div>

          <!-- Filtro Colaborador -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Colaborador</label>
            <select
              v-model="filterEmployee"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none truncate">
              <option value="TODOS">Todos los Empleados</option>
              <option v-for="emp in availableEmployees" :key="emp.codigo_empleado" :value="emp.codigo_empleado">
                #{{ emp.codigo_empleado }} - {{ emp.nombre }}
              </option>
            </select>
          </div>

          <!-- Filtro Reloj Checador -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Reloj Checador</label>
            <select
              v-model="filterReloj"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none truncate">
              <option value="TODOS">Todos los Relojes</option>
              <option v-for="dev in availableDevices" :key="dev.id" :value="dev.nombre">
                {{ dev.nombre }} ({{ dev.sucursal_nombre || dev.ip }})
              </option>
            </select>
          </div>

          <!-- Filtro Área -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Área / Turno</label>
            <select
              v-model="filterArea"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none truncate">
              <option value="TODAS">Todas las Áreas</option>
              <option v-for="aName in availableAreaOptions" :key="aName" :value="aName">
                {{ aName }}
              </option>
            </select>
          </div>

          <!-- Filtro Estatus Checada -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Filtro Estatus</label>
            <select
              v-model="filterStatus"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none truncate">
              <option value="todos">Todos los Registros</option>
              <option value="validas">Solo Checadas Válidas</option>
              <option value="rebotes">Solo Rebotes (&lt;180s)</option>
            </select>
          </div>

        </div>

      </div>

      <!-- TABLA PRINCIPAL DE DATOS DEL REPORTE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden flex flex-col">
        
        <!-- Barra de título y buscador dentro de la tabla -->
        <div class="p-4 sm:p-5 border-b border-charcoal-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-charcoal-50/50">
          <div class="flex items-center gap-3 min-w-0">
            <span class="w-5 flex items-center justify-center shrink-0">
              <i :class="['ph', reportTypes.find(r => r.id === activeReportType)?.icon || 'ph-chart-bar', 'text-lg text-charcoal-400']"></i>
            </span>
            <div class="min-w-0">
            <h3 class="text-sm font-semibold text-charcoal-900">{{ reportData.title }}</h3>
            <p class="text-[11px] text-charcoal-400">
              {{ filteredRows.length }} registros encontrados
              <span v-if="customStartDate && customEndDate">• Periodo: {{ customStartDate }} al {{ customEndDate }}</span>
            </p>
            </div>
          </div>

          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
            <button
              v-if="activeReportType === 'empleados'"
              type="button"
              @click="openContpaqiModal"
              class="h-9 px-4 rounded-xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center justify-center gap-1.5 shrink-0 cursor-pointer transition-all shadow-xs">
              <i class="ph ph-file-txt text-sm"></i>
              <span>Exportar CONTPAQi (.txt)</span>
            </button>

            <div class="relative w-full sm:w-64">
              <i class="ph ph-magnifying-glass absolute left-3 top-2.5 text-charcoal-400 text-sm"></i>
              <input
                type="text"
                v-model="searchQuery"
                placeholder="Buscar en el reporte..."
                class="w-full h-9 pl-9 pr-3 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>
          </div>
        </div>

        <!-- TABLA DINÁMICA SEGÚN REPORTE -->
        <div class="overflow-x-auto">
          
          <!-- REPORTE 1: EMPLEADOS / PRE-NÓMINA -->
          <table v-if="activeReportType === 'empleados'" class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3 px-5">ID</th>
                <th class="py-3 px-4">Colaborador</th>
                <th class="py-3 px-4">Área / Turno</th>
                <th class="py-3 px-3 text-center">Días Asist.</th>
                <th class="py-3 px-3 text-center">Retardos</th>
                <th class="py-3 px-3 text-center">Incompletos</th>
                <th class="py-3 px-3 text-center">Horas Trab.</th>
                <th class="py-3 px-3 text-center">Válidas</th>
                <th class="py-3 px-3 text-center">Rebotes</th>
                <th class="py-3 px-5 text-right">Estatus Pre-Nómina</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="row in filteredRows" :key="row.codigo_empleado" class="hover:bg-charcoal-50/60 transition-colors">
                <td class="py-3.5 px-5 mono-code font-bold text-charcoal-900">#{{ row.codigo_empleado }}</td>
                <td class="py-3.5 px-4">
                  <div class="font-bold text-charcoal-900">{{ row.nombre }}</div>
                  <div class="text-[10px] text-charcoal-400">{{ row.puesto }}</div>
                </td>
                <td class="py-3.5 px-4">
                  <div class="font-medium text-charcoal-800">{{ row.area_nombre }}</div>
                  <div class="flex items-center gap-1.5 flex-wrap mt-0.5">
                    <span v-if="row.sucursal_base_nombre" class="px-1.5 py-0.5 rounded bg-charcoal-100 text-charcoal-700 text-[9px] font-bold uppercase tracking-wider">Base: {{ row.sucursal_base_nombre }}</span>
                    <span v-if="row.horario_origen === 'PERSONALIZADO'" class="px-1.5 py-0.5 rounded bg-[#18181B] text-white text-[9px] font-bold uppercase tracking-wider">Personalizado</span>
                    <span v-else-if="row.es_horario_mixto" class="px-1.5 py-0.5 rounded bg-charcoal-100 text-charcoal-700 text-[9px] font-bold uppercase tracking-wider">Mixto</span>
                    <span class="text-[10px] text-charcoal-400 mono-code">{{ row.horario_esperado || row.turno }}</span>
                  </div>
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold text-charcoal-900 bg-charcoal-50/50">
                  {{ row.dias_asistidos ?? row.dias_activos ?? 0 }}
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold" :class="(row.retardos > 0) ? 'text-rose-600' : 'text-charcoal-400'">
                  {{ row.retardos || 0 }}
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold" :class="(row.dias_incompletos > 0) ? 'text-charcoal-900' : 'text-charcoal-400'">
                  {{ row.dias_incompletos || 0 }}
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold text-charcoal-900">
                  {{ row.horas_trabajadas || 0 }}h
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold text-charcoal-900">
                  {{ row.total_validas || 0 }}
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-semibold text-charcoal-400">
                  {{ row.total_rebotes || 0 }}
                </td>
                <td class="py-3.5 px-5 text-right">
                  <div class="inline-flex items-center justify-end gap-2.5">
                    <span v-if="row.total_validas > 0" class="text-[11px] font-semibold"
                      :class="{
                        'text-charcoal-900': row.estatus === 'ASISTENCIA PUNTUAL',
                        'text-rose-600': row.estatus && row.estatus.includes('RETARDO'),
                        'text-charcoal-600': row.estatus && row.estatus.includes('INCOMPLETO') && !row.estatus.includes('RETARDO'),
                        'text-charcoal-400': !row.estatus || row.estatus === 'SIN REGISTROS'
                      }">
                      {{ row.estatus }}
                    </span>
                    <span v-else class="text-[11px] font-semibold text-charcoal-400">
                      SIN REGISTROS
                    </span>
                    <button
                      type="button"
                      @click="openIncidenciasModal(row)"
                      title="Ver resumen de retardos e incidencias"
                      aria-label="Ver resumen de retardos e incidencias"
                      class="w-7 h-7 rounded-xl inline-flex items-center justify-center border border-charcoal-200 bg-white text-charcoal-500 hover:bg-[#18181B] hover:text-white hover:border-[#18181B] transition-all cursor-pointer shrink-0 shadow-2xs">
                      <i class="ph ph-eye text-sm"></i>
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="!filteredRows.length">
                <td colspan="10" class="py-12 text-center text-charcoal-400">
                  No se encontraron colaboradores para los filtros seleccionados.
                </td>
              </tr>
            </tbody>
          </table>

          <!-- REPORTE 2: BITÁCORA DETALLADA -->
          <table v-else-if="activeReportType === 'bitacora'" class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3 px-5">ID</th>
                <th class="py-3 px-4">Empleado</th>
                <th class="py-3 px-4">Área</th>
                <th class="py-3 px-4">Reloj Checador</th>
                <th class="py-3 px-4">Método de Acceso</th>
                <th class="py-3 px-4">Fecha y Hora</th>
                <th class="py-3 px-5 text-right">Estatus Anti-Rebote</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="row in filteredRows" :key="row.id" class="hover:bg-charcoal-50/60 transition-colors">
                <td class="py-3.5 px-5 mono-code font-bold text-charcoal-500">#{{ row.id }}</td>
                <td class="py-3.5 px-4">
                  <div class="font-bold text-charcoal-900">{{ row.nombre }}</div>
                  <div class="text-[10px] text-charcoal-400 mono-code">Código #{{ row.codigo_empleado }}</div>
                </td>
                <td class="py-3.5 px-4 font-medium text-charcoal-800">{{ row.area }}</td>
                <td class="py-3.5 px-4 text-charcoal-700 font-medium">
                  <div>{{ row.reloj_nombre }}</div>
                  <div v-if="row.sucursal_nombre" class="text-[10px] text-charcoal-400">Suc. {{ row.sucursal_nombre }}</div>
                </td>
                <td class="py-3.5 px-4">
                  <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-charcoal-700">
                    <i :class="[\'ph text-charcoal-400\', row.metodo === 'ROSTRO' ? 'ph-scan' : (row.metodo === 'HUELLA' ? 'ph-fingerprint' : 'ph-key')]"></i>
                    <span>{{ row.metodo }}</span>
                  </span>
                </td>
                <td class="py-3.5 px-4 mono-code text-[11px] text-charcoal-800 font-semibold">
                  {{ row.fecha_hora_display }}
                </td>
                <td class="py-3.5 px-5 text-right">
                  <span v-if="!row.es_rebote" class="text-[11px] font-semibold text-charcoal-900">
                    VÁLIDO
                  </span>
                  <span v-else class="text-[11px] font-medium text-charcoal-400">
                    REBOTE &lt;180S
                  </span>
                </td>
              </tr>
              <tr v-if="!filteredRows.length">
                <td colspan="7" class="py-12 text-center text-charcoal-400">
                  No hay registros de checadas en este periodo con los filtros seleccionados.
                </td>
              </tr>
            </tbody>
          </table>

          <!-- REPORTE 3: RELOJES CHECADORES -->
          <table v-else-if="activeReportType === 'relojes'" class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3 px-5">Reloj / Terminal</th>
                <th class="py-3 px-4">Dirección IP</th>
                <th class="py-3 px-4">Ubicación</th>
                <th class="py-3 px-4 text-center">Eventos en Periodo</th>
                <th class="py-3 px-4 text-center">Checadas Válidas</th>
                <th class="py-3 px-4 text-center">Rebotes Depurados</th>
                <th class="py-3 px-4 text-center">Usuarios Únicos</th>
                <th class="py-3 px-4">Última Actividad</th>
                <th class="py-3 px-5 text-right">Estado</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="row in filteredRows" :key="row.id" class="hover:bg-charcoal-50/60 transition-colors">
                <td class="py-4 px-5">
                  <div class="font-bold text-charcoal-900">{{ row.nombre }}</div>
                  <div class="text-[10px] text-charcoal-400">{{ row.modelo }}</div>
                </td>
                <td class="py-4 px-4 mono-code text-charcoal-800 font-bold">{{ row.ip }}</td>
                <td class="py-4 px-4 text-charcoal-700">{{ row.ubicacion }}</td>
                <td class="py-4 px-4 text-center mono-code font-bold text-charcoal-900 text-sm">
                  {{ row.total_eventos_periodo }}
                </td>
                <td class="py-4 px-4 text-center mono-code font-bold text-charcoal-900">
                  {{ row.validas }}
                </td>
                <td class="py-4 px-4 text-center mono-code font-semibold text-charcoal-400">
                  {{ row.rebotes }}
                </td>
                <td class="py-4 px-4 text-center mono-code font-bold text-charcoal-900">
                  {{ row.usuarios_distintos }}
                </td>
                <td class="py-4 px-4 mono-code text-[11px] text-charcoal-600">
                  {{ row.ultima_actividad }}
                </td>
                <td class="py-4 px-5 text-right">
                  <span class="text-[11px] font-semibold"
                    :class="row.estado === 'ONLINE' ? 'text-charcoal-900' : 'text-charcoal-400'">
                    {{ row.estado }}
                  </span>
                </td>
              </tr>
              <tr v-if="!filteredRows.length">
                <td colspan="9" class="py-12 text-center text-charcoal-400">
                  No se encontraron terminales registradas.
                </td>
              </tr>
            </tbody>
          </table>

          <!-- REPORTE 4: ÁREAS Y TURNOS -->
          <table v-else-if="activeReportType === 'areas'" class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3 px-5">Código</th>
                <th class="py-3 px-4">Área / Departamento</th>
                <th class="py-3 px-4">Responsable</th>
                <th class="py-3 px-4">Turno y Horario</th>
                <th class="py-3 px-4 text-center">Plantilla Total</th>
                <th class="py-3 px-4 text-center">Colaboradores Presentes</th>
                <th class="py-3 px-4 text-center">Cobertura</th>
                <th class="py-3 px-5 text-right">Marcajes Válidos</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="row in filteredRows" :key="row.id" class="hover:bg-charcoal-50/60 transition-colors">
                <td class="py-4 px-5 mono-code font-bold text-charcoal-600">{{ row.codigo }}</td>
                <td class="py-4 px-4 font-bold text-charcoal-900">{{ row.nombre }}</td>
                <td class="py-4 px-4 text-charcoal-700 font-medium">{{ row.responsable }}</td>
                <td class="py-4 px-4">
                  <div class="font-medium text-charcoal-800">{{ row.turno }}</div>
                  <div class="text-[10px] text-charcoal-400 mono-code">{{ row.horario }}</div>
                </td>
                <td class="py-4 px-4 text-center mono-code font-bold text-charcoal-900">
                  {{ row.plantilla }} personas
                </td>
                <td class="py-4 px-4 text-center mono-code font-bold text-charcoal-900">
                  {{ row.colaboradores_presentes }}
                </td>
                <td class="py-4 px-4 text-center">
                  <div class="inline-flex items-center gap-1.5">
                    <span class="mono-code font-bold text-charcoal-900">{{ row.cobertura_pct }}%</span>
                    <div class="w-12 h-2 rounded-full bg-charcoal-100 overflow-hidden">
                      <div class="h-full bg-charcoal-900 rounded-full" :style="{ width: row.cobertura_pct + '%' }"></div>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-5 text-right mono-code font-black text-charcoal-900 text-sm">
                  {{ row.total_validas }}
                </td>
              </tr>
              <tr v-if="!filteredRows.length">
                <td colspan="8" class="py-12 text-center text-charcoal-400">
                  No se encontraron áreas registradas.
                </td>
              </tr>
            </tbody>
          </table>

        </div>

      </div>

      <!-- MODAL: ENVIAR REPORTE POR CORREO (DISTRIBUCIÓN HORIZONTAL 2 COLUMNAS) -->
      <ModalBase
        v-if="isEmailModalOpen"
        title="Enviar Reporte por Correo Electrónico"
        size="xl"
        confirmLabel="Enviar Reporte"
        :confirmDisabled="emailSending"
        @close="isEmailModalOpen = false"
        @confirm="sendReportEmail">

        <div class="grid grid-cols-1 md:grid-cols-12 gap-5 items-stretch text-xs">

          <!-- Columna Izquierda (5 cols): Resumen del Reporte, Estado SMTP y Adjunto -->
          <div class="md:col-span-5 flex flex-col justify-between space-y-3.5">
            <div class="space-y-3.5">
              <!-- Resumen del Reporte -->
              <div class="p-4 rounded-2xl bg-charcoal-50 border border-charcoal-200 space-y-1.5">
                <div class="font-bold text-charcoal-900 flex items-center justify-between gap-2">
                  <span>{{ reportData.title }}</span>
                  <span class="mono-code text-[11px] text-charcoal-600 font-bold shrink-0">
                    {{ filteredRows.length }} registros
                  </span>
                </div>
                <div class="text-[11px] text-charcoal-500">
                  Periodo: <b class="text-charcoal-800">{{ customStartDate && customEndDate ? (customStartDate + ' al ' + customEndDate) : 'Histórico completo' }}</b>
                </div>
              </div>

              <!-- Alerta Estado Remitente SMTP -->
              <div v-if="!emailConfig.is_configured" class="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-[11px] flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <i class="ph ph-warning-circle text-base text-amber-600 shrink-0"></i>
                  <span>El servidor SMTP aún no está configurado.</span>
                </div>
                <button
                  type="button"
                  @click="isEmailModalOpen = false; isConfigModalOpen = true"
                  class="font-bold underline text-amber-900 hover:text-black cursor-pointer shrink-0">
                  Configurar ahora
                </button>
              </div>
              <div v-else class="p-3.5 rounded-2xl bg-emerald-50/70 border border-emerald-200 text-emerald-800 text-[11px] flex items-center gap-2">
                <i class="ph ph-check-circle text-base text-emerald-600 shrink-0"></i>
                <span class="truncate">Se enviará desde: <b class="font-mono text-emerald-900">{{ emailConfig.smtp_user }}</b></span>
              </div>
            </div>

            <!-- Adjuntar CSV -->
            <label class="flex items-center gap-2.5 p-3.5 rounded-2xl border border-charcoal-200 bg-white hover:bg-charcoal-50 cursor-pointer">
              <input
                type="checkbox"
                v-model="emailForm.attach_csv"
                class="w-4 h-4 rounded text-black focus:ring-black shrink-0"
              />
              <div>
                <div class="font-bold text-charcoal-900">Adjuntar archivo CSV completo</div>
                <div class="text-[11px] text-charcoal-500">Permite abrir y procesar la información en Excel.</div>
              </div>
            </label>
          </div>

          <!-- Columna Derecha (7 cols): Destinatario, Asunto y Notas -->
          <div class="md:col-span-7 space-y-3.5">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Correo Electrónico Destinatario *</label>
                <input
                  type="email"
                  v-model="emailForm.to_email"
                  placeholder="ejemplo@empresa.com"
                  class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white text-xs font-mono focus:ring-2 focus:ring-black focus:outline-none"
                />
              </div>

              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Asunto del Correo</label>
                <input
                  type="text"
                  v-model="emailForm.subject"
                  class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Comentarios o Notas Adicionales (Opcional)</label>
              <textarea
                v-model="emailForm.notes"
                rows="4"
                placeholder="Escribe algún mensaje o indicación que se incluirá en el cuerpo del correo..."
                class="w-full p-3 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none resize-none"
              ></textarea>
            </div>

            <!-- Spinner al enviar -->
            <div v-if="emailSending" class="p-3 rounded-xl bg-charcoal-100 text-charcoal-800 flex items-center justify-center gap-2 font-bold">
              <i class="ph ph-spinner animate-spin text-base"></i>
              <span>Conectando con SMTP y enviando correo...</span>
            </div>
          </div>

        </div>
      </ModalBase>

      <!-- MODAL: AJUSTES DIRECTOS DE SERVIDOR SMTP -->
      <ModalBase
        v-if="isConfigModalOpen"
        title="Configuración de Servidor de Correo (SMTP)"
        size="xl"
        confirmLabel="Listo"
        @close="isConfigModalOpen = false"
        @confirm="isConfigModalOpen = false">

        <div class="space-y-4 text-xs">
          
          <div class="p-3 rounded-2xl border" :class="emailConfig.is_configured ? 'bg-emerald-50/70 border-emerald-200 text-emerald-800' : 'bg-amber-50/70 border-amber-200 text-amber-800'">
            <div class="flex items-center gap-2">
              <i :class="['ph', emailConfig.is_configured ? 'ph-check-circle text-emerald-600' : 'ph-warning-circle text-amber-600', 'text-lg']"></i>
              <div>
                <span class="font-bold">{{ emailConfig.is_configured ? 'Servidor Configurado' : 'Pendiente de Configurar' }}</span>
                <p class="text-[11px] opacity-90">Configura tu correo remitente para enviar reportes a cualquier cuenta.</p>
              </div>
            </div>
          </div>

          <div v-if="smtpFeedback.message" class="p-3 rounded-xl text-xs flex items-center justify-between" :class="smtpFeedback.type === 'success' ? 'bg-emerald-100 text-emerald-900 border border-emerald-300' : 'bg-rose-100 text-rose-900 border border-rose-300'">
            <span>{{ smtpFeedback.message }}</span>
            <button type="button" @click="smtpFeedback.message = ''" class="cursor-pointer text-charcoal-500 hover:text-black">
              <i class="ph ph-x"></i>
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-700 mb-1">Servidor SMTP (Host)</label>
              <input
                type="text"
                v-model="smtpForm.smtp_host"
                placeholder="smtp.gmail.com"
                class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block font-bold text-charcoal-700 mb-1">Puerto</label>
                <input
                  type="number"
                  v-model="smtpForm.smtp_port"
                  placeholder="587"
                  class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
                />
              </div>
              <div>
                <label class="block font-bold text-charcoal-700 mb-1">Seguridad</label>
                <select
                  v-model="smtpForm.smtp_security"
                  class="w-full h-9 px-2 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none">
                  <option value="STARTTLS">STARTTLS</option>
                  <option value="SSL/TLS">SSL/TLS</option>
                  <option value="NONE">Ninguna</option>
                </select>
              </div>
            </div>

            <div>
              <label class="block font-bold text-charcoal-700 mb-1">Usuario / Correo Remitente</label>
              <input
                type="email"
                v-model="smtpForm.smtp_user"
                placeholder="tu_correo@gmail.com"
                class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block font-bold text-charcoal-700">Contraseña de Aplicación</label>
                <button
                  type="button"
                  @click="showSmtpPass = !showSmtpPass"
                  class="text-[10px] text-charcoal-600 font-semibold cursor-pointer">
                  {{ showSmtpPass ? 'Ocultar' : 'Mostrar' }}
                </button>
              </div>
              <input
                :type="showSmtpPass ? 'text' : 'password'"
                v-model="smtpForm.smtp_password"
                placeholder="16 caracteres (App Password)"
                class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>

            <div>
              <label class="block font-bold text-charcoal-700 mb-1">Nombre Remitente</label>
              <input
                type="text"
                v-model="smtpForm.remitente_nombre"
                placeholder="notificaciones@access.com"
                class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>

            <div>
              <label class="block font-bold text-charcoal-700 mb-1">Destinatario por Defecto</label>
              <input
                type="email"
                v-model="smtpForm.destinatario_default"
                placeholder="destinatario@empresa.com"
                class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>
          </div>

          <div class="p-3 rounded-xl bg-charcoal-50 border border-charcoal-200 text-[11px] text-charcoal-600">
            <strong>Gmail / Google:</strong> Genera una Contraseña de Aplicación en <em>Seguridad &gt; Verificación en 2 pasos &gt; Contraseñas de aplicaciones</em>.
          </div>

          <div class="flex items-center justify-between pt-2 border-t border-charcoal-100 gap-2">
            <button
              type="button"
              @click="testSmtpSettings"
              :disabled="isTestingSmtp"
              class="h-9 px-3.5 rounded-xl bg-white hover:bg-charcoal-100 text-charcoal-800 border border-charcoal-300 font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50">
              <i :class="['ph', isTestingSmtp ? 'ph-spinner animate-spin' : 'ph-paper-plane-tilt']"></i>
              <span>{{ isTestingSmtp ? 'Probando...' : 'Probar Envío' }}</span>
            </button>

            <button
              type="button"
              @click="saveSmtpSettings"
              :disabled="isSavingSmtp"
              class="h-9 px-4 rounded-xl bg-[#18181B] hover:bg-black text-white font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-xs">
              <i :class="['ph', isSavingSmtp ? 'ph-spinner animate-spin' : 'ph-floppy-disk']"></i>
              <span>{{ isSavingSmtp ? 'Guardando...' : 'Guardar Configuración' }}</span>
            </button>
          </div>

        </div>
      </ModalBase>

      <!-- MODAL: EXPORTAR LAYOUT CONTPAQi NÓMINAS (.TXT) (DISTRIBUCIÓN HORIZONTAL AMPLIA) -->
      <ModalBase
        v-if="isContpaqiModalOpen"
        title="Exportar Incidencias para CONTPAQi Nóminas (.txt)"
        :confirmLabel="isExportingContpaqi ? 'Generando...' : 'Descargar Layout (.txt)'"
        :confirmDisabled="isExportingContpaqi"
        size="xl"
        @close="isContpaqiModalOpen = false"
        @confirm="downloadContpaqiTxt">
        <div class="space-y-4 text-xs">
          <div class="p-3.5 rounded-2xl bg-offwhite border border-charcoal-200 text-[11px] text-charcoal-600">
            Se generará un archivo de ancho fijo (<b>Maestro-Detalle</b>) evaluando el rango
            <b class="mono-code">{{ customStartDate || 'últimos 14 días' }}</b> al <b class="mono-code">{{ customEndDate || 'hoy' }}</b>
            según los días laborales y tolerancias de cada área.
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Área / Departamento</label>
              <select v-model="contpaqiForm.area_nombre" class="w-full h-10 px-3 rounded-xl border border-charcoal-200 bg-white font-semibold">
                <option value="TODAS">Todas las áreas</option>
                <option v-for="aName in availableAreaOptions" :key="aName" :value="aName">{{ aName }}</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Tipo de Periodo</label>
              <select v-model="contpaqiForm.tipo_periodo" class="w-full h-10 px-3 rounded-xl border border-charcoal-200 bg-white font-semibold">
                <option value="Semanal">Semanal</option>
                <option value="Quincenal">Quincenal</option>
                <option value="Catorcenal">Catorcenal</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Número de Periodo</label>
              <input v-model.number="contpaqiForm.numero_periodo" type="number" min="1" max="53"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Ejercicio</label>
              <input v-model.number="contpaqiForm.ejercicio" type="number" min="2020" max="2099"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
          </div>

          <div class="space-y-2.5 pt-1">
            <span class="text-[11px] font-bold uppercase tracking-wider text-charcoal-400 block">
              Nombres Exactos de Conceptos en CONTPAQi
            </span>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Concepto para Faltas</label>
                <input v-model="contpaqiForm.concepto_falta" type="text" maxlength="33"
                  class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200">
              </div>
              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Concepto para Retardos</label>
                <input v-model="contpaqiForm.concepto_retardo" type="text" maxlength="33"
                  class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200">
              </div>
              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Concepto para Horas Extra</label>
                <input v-model="contpaqiForm.concepto_extra" type="text" maxlength="33"
                  class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200">
              </div>
            </div>
          </div>
        </div>
      </ModalBase>

      <!-- MODAL: RESUMEN DE RETARDOS E INCIDENCIAS DE PRE-NÓMINA -->
      <ModalBase
        v-if="isIncidenciasModalOpen && selectedEmpIncidencias"
        title="Resumen de Retardos e Incidencias"
        :subtitle="'Detalle individual de asistencia y puntualidad — Periodo ' + (customStartDate && customEndDate ? (customStartDate + ' al ' + customEndDate) : 'Histórico completo')"
        size="wide"
        :hideConfirm="true"
        cancelLabel="Cerrar"
        @close="isIncidenciasModalOpen = false">

        <div class="space-y-4 text-xs">

          <!-- Ficha del colaborador -->
          <div class="p-4 rounded-2xl bg-charcoal-50/70 border border-charcoal-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-start sm:items-center gap-3 min-w-0">
              <div class="w-9 h-9 rounded-full bg-[#18181B] text-white flex items-center justify-center text-xs font-bold shrink-0">
                {{ (selectedEmpIncidencias.nombre || 'E').slice(0, 2).toUpperCase() }}
              </div>
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-bold text-sm text-charcoal-900 truncate">{{ selectedEmpIncidencias.nombre }}</span>
                  <span class="mono-code text-[11px] font-bold text-charcoal-500">#{{ selectedEmpIncidencias.codigo_empleado }}</span>
                  <span v-if="selectedEmpIncidencias.puesto" class="text-[11px] text-charcoal-400">• {{ selectedEmpIncidencias.puesto }}</span>
                </div>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-charcoal-500">
                  <span v-if="selectedEmpIncidencias.sucursal_base_nombre" class="inline-flex items-center gap-1">
                    <i class="ph ph-map-pin text-charcoal-400"></i>
                    <span>Base: {{ selectedEmpIncidencias.sucursal_base_nombre }}</span>
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <i class="ph ph-buildings text-charcoal-400"></i>
                    <span>{{ selectedEmpIncidencias.area_nombre || 'General' }}</span>
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <i class="ph ph-clock text-charcoal-400"></i>
                    <span class="mono-code">{{ selectedEmpIncidencias.horario_esperado || selectedEmpIncidencias.turno || 'No definido' }}</span>
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <i class="ph ph-timer text-charcoal-400"></i>
                    <span>{{ selectedEmpIncidencias.tolerancia_min ?? 10 }} min tolerancia</span>
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <i class="ph ph-calendar-blank text-charcoal-400"></i>
                    <span class="mono-code">{{ customStartDate && customEndDate ? (customStartDate + ' al ' + customEndDate) : 'Histórico completo' }}</span>
                  </span>
                </div>
                <div v-if="selectedEmpIncidencias.horario_detalle && selectedEmpIncidencias.horario_detalle !== selectedEmpIncidencias.horario_esperado" class="text-[10px] mono-code text-charcoal-500 pt-0.5">
                  {{ selectedEmpIncidencias.horario_detalle }}
                </div>
              </div>
            </div>
            <span
              class="px-3 py-1.5 rounded-xl bg-white border border-charcoal-200 text-[11px] font-bold shrink-0 self-start sm:self-center shadow-2xs"
              :class="{
                'text-charcoal-900': selectedEmpIncidencias.estatus === 'ASISTENCIA PUNTUAL',
                'text-rose-600': selectedEmpIncidencias.estatus && selectedEmpIncidencias.estatus.includes('RETARDO'),
                'text-charcoal-600': selectedEmpIncidencias.estatus && selectedEmpIncidencias.estatus.includes('INCOMPLETO') && !selectedEmpIncidencias.estatus.includes('RETARDO'),
                'text-charcoal-400': !selectedEmpIncidencias.estatus || selectedEmpIncidencias.estatus === 'SIN REGISTROS'
              }">
              {{ selectedEmpIncidencias.estatus || 'SIN REGISTROS' }}
            </span>
          </div>

          <!-- 4 KPIs ejecutivos -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div class="bg-white rounded-2xl p-4 border border-charcoal-200 shadow-2xs flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div
                  class="text-2xl font-black mono-code leading-none"
                  :class="(selectedEmpIncidencias.retardos > 0) ? 'text-rose-600' : 'text-charcoal-900'">
                  {{ selectedEmpIncidencias.retardos || 0 }}
                </div>
                <div class="text-xs font-bold text-charcoal-900 mt-1.5">Retardos</div>
                <div class="text-[11px] text-charcoal-400 mono-code">{{ selectedEmpIncidencias.minutos_retardo_total || 0 }} min acumulados</div>
              </div>
              <i class="ph ph-clock-countdown text-xl text-charcoal-300 shrink-0"></i>
            </div>

            <div class="bg-white rounded-2xl p-4 border border-charcoal-200 shadow-2xs flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-2xl font-black text-charcoal-900 mono-code leading-none">
                  {{ selectedEmpIncidencias.dias_incompletos || 0 }}
                </div>
                <div class="text-xs font-bold text-charcoal-900 mt-1.5">Incompletos</div>
                <div class="text-[11px] text-charcoal-400">días sin salida</div>
              </div>
              <i class="ph ph-warning-circle text-xl text-charcoal-300 shrink-0"></i>
            </div>

            <div class="bg-white rounded-2xl p-4 border border-charcoal-200 shadow-2xs flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-2xl font-black text-charcoal-900 mono-code leading-none">
                  {{ selectedEmpIncidencias.dias_asistidos || 0 }}
                </div>
                <div class="text-xs font-bold text-charcoal-900 mt-1.5">Días Asistidos</div>
                <div class="text-[11px] text-charcoal-400 mono-code">{{ selectedEmpIncidencias.horas_trabajadas || 0 }}h trabajadas</div>
              </div>
              <i class="ph ph-calendar-check text-xl text-charcoal-300 shrink-0"></i>
            </div>

            <div class="bg-white rounded-2xl p-4 border border-charcoal-200 shadow-2xs flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-2xl font-black text-charcoal-900 mono-code leading-none">
                  {{ selectedEmpIncidencias.total_validas || 0 }}
                </div>
                <div class="text-xs font-bold text-charcoal-900 mt-1.5">Marcajes</div>
                <div class="text-[11px] text-charcoal-400 mono-code">{{ selectedEmpIncidencias.total_rebotes || 0 }} rebotes</div>
              </div>
              <i class="ph ph-fingerprint text-xl text-charcoal-300 shrink-0"></i>
            </div>
          </div>

          <!-- Contenedor de tabla estilo módulo Reportes -->
          <div class="bg-white rounded-2xl border border-charcoal-200 shadow-2xs overflow-hidden flex flex-col">
            <div class="px-4 py-3 border-b border-charcoal-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-charcoal-50/50">
              <div class="flex items-center gap-2.5 min-w-0">
                <i class="ph ph-list-dashes text-base text-charcoal-400 shrink-0"></i>
                <div class="min-w-0">
                  <h4 class="text-xs font-semibold text-charcoal-900">Desglose por Día</h4>
                  <p class="text-[11px] text-charcoal-400">{{ displayedIncidenciasRows.length }} registros mostrados</p>
                </div>
              </div>

              <div class="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  @click="incidenciasFilterTab = 'incidencias'"
                  class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  :class="incidenciasFilterTab === 'incidencias' ? 'bg-[#18181B] text-white' : 'bg-white hover:bg-charcoal-100 text-charcoal-700 border border-charcoal-200'">
                  Solo Incidencias ({{ (selectedEmpIncidencias.incidencias_detalle || []).length }})
                </button>
                <button
                  type="button"
                  @click="incidenciasFilterTab = 'todos'"
                  class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer"
                  :class="incidenciasFilterTab === 'todos' ? 'bg-[#18181B] text-white' : 'bg-white hover:bg-charcoal-100 text-charcoal-700 border border-charcoal-200'">
                  Todos los Días ({{ (selectedEmpIncidencias.dias_detalle || []).length }})
                </button>
              </div>
            </div>

            <div v-if="isLoadingIncidencias" class="py-10 px-6 text-center space-y-2 bg-white">
              <i class="ph ph-spinner animate-spin text-2xl text-charcoal-400"></i>
              <p class="font-semibold text-charcoal-700 text-xs">Cargando detalle de retardos e incidencias...</p>
            </div>

            <div v-else-if="!displayedIncidenciasRows.length" class="py-10 px-6 text-center space-y-1.5 bg-white">
              <i
                class="ph text-3xl text-charcoal-300"
                :class="incidenciasFilterTab === 'incidencias' ? 'ph-check-circle' : 'ph-calendar-x'"></i>
              <p class="font-bold text-charcoal-800 text-xs">
                {{ incidenciasFilterTab === 'incidencias'
                  ? 'Sin retardos ni incidencias en el periodo seleccionado'
                  : 'Sin días asistidos registrados en el periodo seleccionado' }}
              </p>
              <p class="text-[11px] text-charcoal-400">
                {{ incidenciasFilterTab === 'incidencias'
                  ? 'El colaborador no presenta retardos, días incompletos ni incidencias manuales en estas fechas.'
                  : 'No hay checadas válidas dentro del rango de fechas y filtros activos.' }}
              </p>
            </div>

            <div v-else class="overflow-x-auto max-h-80 overflow-y-auto">
              <table class="w-full text-left border-collapse">
                <thead class="sticky top-0 z-10">
                  <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                    <th class="py-2.5 px-4">Fecha</th>
                    <th class="py-2.5 px-3">Entrada</th>
                    <th class="py-2.5 px-3">Salida</th>
                    <th class="py-2.5 px-3 text-center">Horas Trab.</th>
                    <th class="py-2.5 px-3">Terminal / Método</th>
                    <th class="py-2.5 px-4 text-right">Estatus Pre-Nómina</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-charcoal-100 text-xs">
                  <tr v-for="d in displayedIncidenciasRows" :key="d.fecha" class="hover:bg-charcoal-50/60 transition-colors">
                    <td class="py-3 px-4 mono-code whitespace-nowrap">
                      <div class="font-bold text-charcoal-900">{{ d.fecha }}</div>
                      <div v-if="d.horario_dia" class="text-[10px] text-charcoal-400 font-normal">{{ d.horario_dia }}</div>
                    </td>
                    <td class="py-3 px-3 mono-code whitespace-nowrap">
                      <div v-if="d.bloques_detalle && d.bloques_detalle.length > 1" class="space-y-1">
                        <div
                          v-for="b in d.bloques_detalle"
                          :key="b.orden_bloque"
                          class="leading-tight"
                          :class="b.es_retardo ? 'text-rose-600 font-bold' : (b.total_checadas === 0 ? 'text-charcoal-300 font-normal' : 'text-charcoal-800 font-semibold')">
                          <span class="text-[10px] text-charcoal-400 mr-1">B{{ b.orden_bloque }}:</span>{{ b.entrada || 'Sin registro' }}
                        </div>
                      </div>
                      <span v-else class="font-semibold" :class="d.es_retardo ? 'text-rose-600' : 'text-charcoal-800'">
                        {{ d.entrada }}
                      </span>
                    </td>
                    <td class="py-3 px-3 mono-code whitespace-nowrap">
                      <div v-if="d.bloques_detalle && d.bloques_detalle.length > 1" class="space-y-1">
                        <div
                          v-for="b in d.bloques_detalle"
                          :key="b.orden_bloque"
                          class="leading-tight"
                          :class="b.es_incompleto ? 'text-charcoal-500 font-semibold' : (b.total_checadas === 0 ? 'text-charcoal-300' : 'text-charcoal-700')">
                          {{ b.total_checadas === 0 ? '—' : b.salida }}
                        </div>
                      </div>
                      <span v-else :class="d.es_incompleto ? 'text-charcoal-500 font-semibold' : 'text-charcoal-700'">
                        {{ d.salida }}
                      </span>
                    </td>
                    <td class="py-3 px-3 text-center mono-code font-bold text-charcoal-900 bg-charcoal-50/50 whitespace-nowrap">
                      {{ d.horas > 0 ? (d.horas + 'h') : (d.es_incompleto ? '—' : '0h') }}
                    </td>
                    <td class="py-3 px-3">
                      <div class="font-medium text-charcoal-800">{{ d.reloj }}</div>
                      <div class="inline-flex items-center gap-1 text-[10px] text-charcoal-400">
                        <i
                          class="ph"
                          :class="d.metodo === 'ROSTRO'
                            ? 'ph-scan'
                            : (d.metodo === 'HUELLA'
                              ? 'ph-fingerprint'
                              : (d.metodo === 'MANUAL' ? 'ph-pencil-simple-line' : 'ph-key'))"></i>
                        <span>{{ d.metodo }} • {{ d.total_checadas }} reg.</span>
                      </div>
                    </td>
                    <td class="py-3 px-4 text-right">
                      <div class="flex flex-col items-end gap-0.5">
                        <template v-if="d.tipos_incidencia && d.tipos_incidencia.length">
                          <span
                            v-for="(tipo, idx) in d.tipos_incidencia"
                            :key="idx"
                            class="inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap"
                            :class="tipo.startsWith('RETARDO')
                              ? 'text-rose-600'
                              : (tipo.includes('INCOMPLETO') ? 'text-charcoal-600' : 'text-charcoal-700')">
                            <i
                              class="ph text-xs"
                              :class="tipo.startsWith('RETARDO')
                                ? 'ph-clock-countdown'
                                : (tipo.includes('INCOMPLETO') ? 'ph-warning-circle' : 'ph-pencil-simple-line')"></i>
                            <span>{{ tipo }}</span>
                          </span>
                        </template>
                        <span v-else class="inline-flex items-center gap-1 text-[11px] font-semibold text-charcoal-900 whitespace-nowrap">
                          <i class="ph ph-check-circle text-xs"></i>
                          <span>ASISTENCIA PUNTUAL</span>
                        </span>
                        <span v-if="d.nota_incidencia" class="text-[10px] text-charcoal-400 italic">
                          "{{ d.nota_incidencia }}"
                        </span>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </ModalBase>

    </div>
  `
};
