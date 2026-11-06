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
    summary: { type: Object, default: () => ({}) }
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
    const filterEmployee = ref('TODOS');
    const filterReloj = ref('TODOS');
    const filterArea = ref('TODAS');
    const filterStatus = ref('todos'); // 'todos' | 'validas' | 'rebotes'
    const searchQuery = ref('');

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
      remitente_nombre: 'ACCESS - Control Biométrico',
      remitente_email: '',
      destinatario_default: ''
    });
    const showSmtpPass = ref(false);
    const isSavingSmtp = ref(false);
    const isTestingSmtp = ref(false);
    const smtpFeedback = ref({ type: '', message: '' });

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
          attach_csv: emailForm.value.attach_csv
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
            r.total_validas,
            r.total_rebotes,
            r.dias_activos,
            r.primera_checada,
            r.ultima_checada,
            r.estatus
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

    // Resetear filtros
    function resetFilters() {
      filterEmployee.value = 'TODOS';
      filterReloj.value = 'TODOS';
      filterArea.value = 'TODAS';
      filterStatus.value = 'todos';
      searchQuery.value = '';
      updateDatePreset('mes');
    }

    watch([activeReportType, filterEmployee, filterReloj, filterArea, filterStatus], () => {
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
      filterEmployee,
      filterReloj,
      filterArea,
      filterStatus,
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
      loadEmailConfig
    };
  },
  template: `
    <div class="w-full space-y-6 animate-in fade-in duration-150 pb-12">

      <!-- HEADER PRINCIPAL -->
      <div class="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h2 class="text-3xl font-bold text-charcoal-900 tracking-tight">Reportes</h2>
          <p class="text-xs text-charcoal-500 mt-1">
            Auditoría de asistencia por colaborador, reloj checador, departamentos y envío automatizado por correo
          </p>
        </div>

        <div class="flex items-center gap-2.5 flex-wrap">
          <!-- Botón Configuración de Correo -->
          <button
            type="button"
            @click="isConfigModalOpen = true"
            class="px-4 py-2.5 rounded-2xl bg-white hover:bg-charcoal-100 text-charcoal-800 border border-charcoal-200 text-xs font-bold flex items-center gap-2 shadow-2xs transition-all cursor-pointer shrink-0">
            <i class="ph ph-gear text-base text-charcoal-500"></i>
            <span>Configurar Correo (SMTP)</span>
            <span v-if="emailConfig.is_configured" class="w-2 h-2 rounded-full bg-emerald-500" title="SMTP Configurado"></span>
            <span v-else class="w-2 h-2 rounded-full bg-amber-500" title="SMTP Pendiente"></span>
          </button>

          <!-- Botón Descargar CSV -->
          <button
            type="button"
            @click="exportCurrentReportCsv"
            class="px-4 py-2.5 rounded-2xl bg-white hover:bg-charcoal-100 text-charcoal-800 border border-charcoal-200 text-xs font-bold flex items-center gap-2 shadow-2xs transition-all cursor-pointer shrink-0">
            <i class="ph ph-file-csv text-base text-emerald-600"></i>
            <span>Descargar CSV</span>
          </button>

          <!-- Botón Enviar por Correo -->
          <button
            type="button"
            @click="openSendEmailModal"
            class="px-5 py-2.5 rounded-2xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-all cursor-pointer shrink-0">
            <i class="ph ph-paper-plane-tilt text-base text-sky-400"></i>
            <span>Enviar Reporte por Correo</span>
          </button>
        </div>
      </div>

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
            : 'bg-white hover:bg-charcoal-50/80 text-charcoal-800 border-charcoal-200 shadow-2xs'">
          <div>
            <div class="flex items-center justify-between mb-2">
              <div 
                class="w-10 h-10 rounded-2xl flex items-center justify-center text-lg"
                :class="activeReportType === rt.id ? 'bg-white/10 text-white' : 'bg-charcoal-100 text-charcoal-700'">
                <i :class="['ph', rt.icon]"></i>
              </div>
              <span v-if="activeReportType === rt.id" class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-white/20 text-white uppercase tracking-wider">
                Activo
              </span>
            </div>
            <h4 class="font-bold text-sm tracking-tight leading-snug">{{ rt.label }}</h4>
            <p class="text-[11px] mt-1 line-clamp-2" :class="activeReportType === rt.id ? 'text-charcoal-300' : 'text-charcoal-500'">
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
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 pt-1 text-xs">
          
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

          <!-- Filtro Colaborador -->
          <div>
            <label class="block font-bold text-charcoal-600 mb-1">Colaborador</label>
            <select
              v-model="filterEmployee"
              class="w-full h-9 px-2.5 rounded-xl border border-charcoal-200 bg-white text-xs font-medium focus:ring-2 focus:ring-black focus:outline-none truncate">
              <option value="TODOS">Todos los Empleados</option>
              <option v-for="emp in employees" :key="emp.codigo_empleado" :value="emp.codigo_empleado">
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
              <option v-for="dev in devices" :key="dev.id" :value="dev.nombre">
                {{ dev.nombre }} ({{ dev.ip }})
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
              <option v-for="a in areas" :key="a.id" :value="a.nombre">
                {{ a.nombre }}
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
          <div>
            <h3 class="text-base font-bold text-charcoal-900">{{ reportData.title }}</h3>
            <p class="text-xs text-charcoal-500 mt-0.5">
              {{ filteredRows.length }} registros encontrados
              <span v-if="customStartDate && customEndDate">• Periodo: {{ customStartDate }} al {{ customEndDate }}</span>
            </p>
          </div>

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

        <!-- TABLA DINÁMICA SEGÚN REPORTE -->
        <div class="overflow-x-auto">
          
          <!-- REPORTE 1: EMPLEADOS / PRE-NÓMINA -->
          <table v-if="activeReportType === 'empleados'" class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3 px-5">ID</th>
                <th class="py-3 px-4">Colaborador</th>
                <th class="py-3 px-4">Área / Turno</th>
                <th class="py-3 px-3 text-center">Válidas</th>
                <th class="py-3 px-3 text-center">Rebotes</th>
                <th class="py-3 px-3 text-center">Días</th>
                <th class="py-3 px-4">Primera Checada</th>
                <th class="py-3 px-4">Última Checada</th>
                <th class="py-3 px-4">Reloj / Método</th>
                <th class="py-3 px-5 text-right">Estatus</th>
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
                  <div class="text-[10px] text-charcoal-400">{{ row.turno }}</div>
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold text-emerald-700 bg-emerald-50/30">
                  {{ row.total_validas }}
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-semibold text-amber-700">
                  {{ row.total_rebotes }}
                </td>
                <td class="py-3.5 px-3 text-center mono-code font-bold text-charcoal-800">
                  {{ row.dias_activos }}
                </td>
                <td class="py-3.5 px-4 mono-code text-[11px] text-charcoal-700">
                  {{ row.primera_checada }}
                </td>
                <td class="py-3.5 px-4 mono-code text-[11px] text-charcoal-700">
                  {{ row.ultima_checada }}
                </td>
                <td class="py-3.5 px-4 text-[11px]">
                  <span class="font-bold text-charcoal-800">{{ row.reloj_preferido }}</span>
                  <span class="text-charcoal-400 ml-1">({{ row.metodo_preferido }})</span>
                </td>
                <td class="py-3.5 px-5 text-right">
                  <span v-if="row.total_validas > 0" class="px-3 py-1 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                    {{ row.estatus }}
                  </span>
                  <span v-else class="px-3 py-1 rounded-full text-[10px] font-bold bg-charcoal-100 text-charcoal-500 border border-charcoal-200">
                    SIN REGISTROS
                  </span>
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
                <td class="py-3.5 px-4 text-charcoal-700 font-medium">{{ row.reloj_nombre }}</td>
                <td class="py-3.5 px-4">
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold"
                    :class="row.metodo === 'ROSTRO' ? 'bg-sky-50 text-sky-700 border border-sky-200' : (row.metodo === 'HUELLA' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-charcoal-100 text-charcoal-800 border border-charcoal-200')">
                    <i :class="['ph', row.metodo === 'ROSTRO' ? 'ph-scan' : (row.metodo === 'HUELLA' ? 'ph-fingerprint' : 'ph-key')]"></i>
                    <span>{{ row.metodo }}</span>
                  </span>
                </td>
                <td class="py-3.5 px-4 mono-code text-[11px] text-charcoal-800 font-semibold">
                  {{ row.fecha_hora_display }}
                </td>
                <td class="py-3.5 px-5 text-right">
                  <span v-if="!row.es_rebote" class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                    VÁLIDO
                  </span>
                  <span v-else class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
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
                <td class="py-4 px-4 text-center mono-code font-bold text-emerald-700">
                  {{ row.validas }}
                </td>
                <td class="py-4 px-4 text-center mono-code font-semibold text-amber-700">
                  {{ row.rebotes }}
                </td>
                <td class="py-4 px-4 text-center mono-code font-bold text-sky-700">
                  {{ row.usuarios_distintos }}
                </td>
                <td class="py-4 px-4 mono-code text-[11px] text-charcoal-600">
                  {{ row.ultima_actividad }}
                </td>
                <td class="py-4 px-5 text-right">
                  <span class="px-2.5 py-1 rounded-full text-[10px] font-bold"
                    :class="row.estado === 'ONLINE' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'">
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
                <td class="py-4 px-4 text-center mono-code font-bold text-emerald-700">
                  {{ row.colaboradores_presentes }}
                </td>
                <td class="py-4 px-4 text-center">
                  <div class="inline-flex items-center gap-1.5">
                    <span class="mono-code font-bold text-charcoal-900">{{ row.cobertura_pct }}%</span>
                    <div class="w-12 h-2 rounded-full bg-charcoal-100 overflow-hidden">
                      <div class="h-full bg-emerald-500 rounded-full" :style="{ width: row.cobertura_pct + '%' }"></div>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-5 text-right mono-code font-black text-emerald-700 text-sm">
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

      <!-- MODAL: ENVIAR REPORTE POR CORREO -->
      <ModalBase
        v-if="isEmailModalOpen"
        title="Enviar Reporte por Correo Electrónico"
        size="md"
        confirmLabel="Enviar Reporte"
        :confirmDisabled="emailSending"
        @close="isEmailModalOpen = false"
        @confirm="sendReportEmail">

        <div class="space-y-4 text-xs">
          
          <!-- Resumen del Reporte -->
          <div class="p-3.5 rounded-2xl bg-charcoal-50 border border-charcoal-200 space-y-1.5">
            <div class="font-bold text-charcoal-900 flex items-center justify-between">
              <span>{{ reportData.title }}</span>
              <span class="mono-code text-[11px] text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                {{ filteredRows.length }} registros
              </span>
            </div>
            <div class="text-[11px] text-charcoal-500">
              Periodo: <b class="text-charcoal-800">{{ customStartDate && customEndDate ? (customStartDate + ' al ' + customEndDate) : 'Histórico completo' }}</b>
            </div>
          </div>

          <!-- Alerta Estado Remitente SMTP -->
          <div v-if="!emailConfig.is_configured" class="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-[11px] flex items-center justify-between">
            <div class="flex items-center gap-2">
              <i class="ph ph-warning-circle text-base text-amber-600 shrink-0"></i>
              <span>El servidor SMTP aún no está configurado.</span>
            </div>
            <button
              type="button"
              @click="isEmailModalOpen = false; isConfigModalOpen = true"
              class="font-bold underline text-amber-900 hover:text-black cursor-pointer">
              Configurar ahora
            </button>
          </div>
          <div v-else class="p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-200 text-emerald-800 text-[11px] flex items-center gap-2">
            <i class="ph ph-check-circle text-base text-emerald-600 shrink-0"></i>
            <span>Se enviará desde: <b class="font-mono text-emerald-900">{{ emailConfig.smtp_user }}</b></span>
          </div>

          <!-- Correo Destinatario -->
          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Correo Electrónico Destinatario *</label>
            <input
              type="email"
              v-model="emailForm.to_email"
              placeholder="ejemplo@empresa.com"
              class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white text-xs font-mono focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <!-- Asunto -->
          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Asunto del Correo</label>
            <input
              type="text"
              v-model="emailForm.subject"
              class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <!-- Notas opcionales -->
          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Comentarios o Notas Adicionales (Opcional)</label>
            <textarea
              v-model="emailForm.notes"
              rows="3"
              placeholder="Escribe algún mensaje o indicación que se incluirá en el cuerpo del correo..."
              class="w-full p-3 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none resize-none"
            ></textarea>
          </div>

          <!-- Adjuntar CSV -->
          <label class="flex items-center gap-2.5 p-3 rounded-xl border border-charcoal-200 bg-white hover:bg-charcoal-50 cursor-pointer">
            <input
              type="checkbox"
              v-model="emailForm.attach_csv"
              class="w-4 h-4 rounded text-black focus:ring-black"
            />
            <div>
              <div class="font-bold text-charcoal-900">Adjuntar archivo CSV de bitácora completa</div>
              <div class="text-[11px] text-charcoal-500">Permite abrir y procesar la información directamente en Microsoft Excel.</div>
            </div>
          </label>

          <!-- Spinner al enviar -->
          <div v-if="emailSending" class="p-3 rounded-xl bg-charcoal-100 text-charcoal-800 flex items-center justify-center gap-2 font-bold">
            <i class="ph ph-spinner animate-spin text-base"></i>
            <span>Conectando con SMTP y enviando correo...</span>
          </div>

        </div>
      </ModalBase>

      <!-- MODAL: AJUSTES DIRECTOS DE SERVIDOR SMTP -->
      <ModalBase
        v-if="isConfigModalOpen"
        title="Configuración de Servidor de Correo (SMTP)"
        size="md"
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
                  class="text-[10px] text-sky-600 font-semibold cursor-pointer">
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
                placeholder="ACCESS - Control Biométrico"
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

    </div>
  `
};
