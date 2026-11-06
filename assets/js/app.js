// Main Vue 3 Root Application — ACCESS (Sistema de Asistencia Biométrica y Pre-Nómina)

import { createApp, ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import AppHeader from './components/AppHeader.js';
import AppSidebar, { MODULES_NAV } from './components/AppSidebar.js';
import ViewInicio from './components/ViewInicio.js';
import ViewMonitor from './components/ViewMonitor.js';
import ViewRelojes from './components/ViewRelojes.js';
import ViewEmpleados from './components/ViewEmpleados.js';
import ViewAreas from './components/ViewAreas.js';
import ViewReportes from './components/ViewReportes.js';
import ViewConfiguracion from './components/ViewConfiguracion.js';
import ModalConfig from './components/ModalConfig.js';

const App = {
  components: {
    AppHeader,
    AppSidebar,
    ViewInicio,
    ViewMonitor,
    ViewRelojes,
    ViewEmpleados,
    ViewAreas,
    ViewReportes,
    ViewConfiguracion,
    ModalConfig
  },
  setup() {
    const activeModule = ref('inicio');
    const isSidebarCollapsed = ref(false);
    const isSyncing = ref(false);

    // System Config Modal
    const isConfigModalOpen = ref(false);
    const configInitialSection = ref('perfil');

    // Referencias a vistas activas para disparar acciones desde el Header
    const relojesRef = ref(null);
    const empleadosRef = ref(null);
    const areasRef = ref(null);
    const reportesRef = ref(null);

    // Global Reactive Data from Backend
    const summary = ref({
      total_checadas: 0,
      checadas_hoy: 0,
      validas_hoy: 0,
      rebotes_hoy: 0,
      total_empleados: 0,
      total_areas: 0,
      total_relojes: 0,
      relojes_online: 0,
      ultima_checada: null
    });
    const records = ref([]);
    const devices = ref([]);
    const employees = ref([]);
    const areas = ref([]);

    // Live Toast Notification for New Check-Ins & Actions
    const toast = ref({
      visible: false,
      title: '',
      subtitle: '',
      badge: '',
      type: 'checkin' // 'checkin' | 'rebote' | 'info'
    });
    let toastTimer = null;
    let islandTimer = null;
    const islandActivity = ref(null);
    let pollTimer = null;
    let lastTopRecordId = null;

    const currentUser = ref({
      name: localStorage.getItem('quodo_access_user') || 'Angel Flores',
      role: 'Ingeniero de Sistemas y Hardware',
      avatar: 'AF'
    });

    const currentModuleMeta = computed(() => {
      return MODULES_NAV.find(m => m.id === activeModule.value) || MODULES_NAV[0];
    });

    const selectedBranchId = ref(Number(localStorage.getItem('quodo_branch_id')) || null);

    function selectBranch(id) {
      selectedBranchId.value = id;
      localStorage.setItem('quodo_branch_id', String(id));
    }

    const primaryClock = computed(() => {
      return devices.value.find(d => d.id === selectedBranchId.value) || devices.value[0] || {
        id: 1,
        nombre: 'Cerro Gordo',
        ip: '192.168.11.71',
        ubicacion: 'Wi-Fi TBS'
      };
    });

    // Datos del Inicio filtrados por la sucursal seleccionada
    const branchRecords = computed(() => records.value.filter(r => !r.reloj_nombre || r.reloj_nombre === primaryClock.value.nombre));
    const branchEmployees = computed(() => employees.value.filter(e => !e.reloj_asignado || e.reloj_asignado === primaryClock.value.nombre));
    const branchDevices = computed(() => devices.value.filter(d => d.id === primaryClock.value.id));

    function showIslandActivity({ title, method = '', badge = '', type = 'checkin' }, ms = 3200) {
      if (islandTimer) clearTimeout(islandTimer);
      islandActivity.value = { id: Date.now(), title, method, badge, type };
      islandTimer = setTimeout(() => { islandActivity.value = null; }, ms);
    }

    function showToast({ title, subtitle, badge = 'EN VIVO', type = 'checkin' }) {
      if (toastTimer) clearTimeout(toastTimer);
      toast.value = {
        visible: true,
        title,
        subtitle,
        badge,
        type
      };
      toastTimer = setTimeout(() => {
        toast.value.visible = false;
      }, 5000);
    }

    async function fetchOverview(silent = true) {
      try {
        const res = await fetch('/api/dashboard/overview');
        if (!res.ok) return;
        const data = await res.json();

        if (data.summary) summary.value = data.summary;
        if (Array.isArray(data.devices)) devices.value = data.devices;
        if (Array.isArray(data.employees)) employees.value = data.employees;
        if (Array.isArray(data.areas)) areas.value = data.areas;

        if (Array.isArray(data.recent_records)) {
          const newest = data.recent_records[0];
          if (newest && lastTopRecordId !== null && newest.id > lastTopRecordId) {
            const isBounce = Boolean(newest.es_rebote);
            const nm = (newest.nombre || '').trim();
            showIslandActivity({
              title: nm || 'Empleado #' + newest.codigo_empleado,
              method: newest.metodo || 'BIOMÉTRICO',
              badge: isBounce ? 'REBOTE' : 'VÁLIDO',
              type: isBounce ? 'rebote' : 'checkin'
            });
          }
          if (newest) {
            lastTopRecordId = newest.id;
          }
          records.value = data.recent_records;
        }
      } catch (e) {
        if (!silent) console.error('Error actualizando dashboard:', e);
      }
    }

    async function syncActiveClock() {
      if (isSyncing.value) return;
      isSyncing.value = true;
      try {
        const devId = primaryClock.value.id || 1;
        const res = await fetch(`/api/devices/${devId}/sync`, { method: 'POST' });
        const data = await res.json();
        await fetchOverview(false);
        if (data.ok) {
          showToast({
            title: `Sincronización ISAPI Completada (${primaryClock.value.ip})`,
            subtitle: `Usuarios en reloj: ${data.users_synced} • Eventos revisados: ${data.events_pulled} • Nuevas checadas: ${data.new_events_inserted}`,
            badge: 'ISAPI SYNC',
            type: 'info'
          });
        }
      } catch (e) {
        console.error(e);
      } finally {
        isSyncing.value = false;
      }
    }

    async function syncClockTime() {
      try {
        const devId = primaryClock.value.id || 1;
        const res = await fetch(`/api/devices/${devId}/sync-time`, { method: 'POST' });
        const data = await res.json();
        await fetchOverview(false);
        if (data.ok) {
          showToast({
            title: 'Hora del Reloj Calibrada',
            subtitle: `Sincronizado a ${data.synced_time}`,
            badge: 'ISAPI TIME',
            type: 'info'
          });
        }
      } catch (e) {
        console.error(e);
      }
    }

    function exportRecordsCsv() {
      const rows = [
        ['ID', 'SerialReloj', 'IDEmpleado', 'Nombre', 'Area', 'Metodo', 'SubEventType', 'FechaHoraReloj', 'EstatusPreNomina', 'DispositivoIP']
      ];
      records.value.forEach(r => {
        rows.push([
          r.id,
          r.serial_no,
          r.codigo_empleado,
          `"${(r.nombre || '').replace(/"/g, '""')}"`,
          `"${(r.area || 'General').replace(/"/g, '""')}"`,
          r.metodo || 'OTRO',
          r.sub_event_type,
          r.fecha_hora_evento,
          r.es_rebote ? 'REBOTE_IGNORADO' : 'VALIDO',
          r.dispositivo_ip || '192.168.11.71'
        ]);
      });
      const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + rows.map(e => e.join(',')).join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `bitacora_checadas_coga_${new Date().toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function onToast(msg, kind) {
      showToast({
        title: msg,
        subtitle: '',
        badge: kind === 'error' ? 'ERROR' : 'LISTO',
        type: kind === 'error' ? 'rebote' : 'info'
      });
    }

    function navigateTo(moduleId) {
      if (MODULES_NAV.some(m => m.id === moduleId)) {
        activeModule.value = moduleId;
        window.location.hash = `#/${moduleId}`;
      }
    }

    function handleQuickAction(actionType) {
      if (actionType === 'sync-clock') {
        syncActiveClock();
      } else if (actionType === 'sync-time') {
        syncClockTime();
      } else if (actionType === 'export-csv') {
        if (activeModule.value === 'reportes' && reportesRef.value && reportesRef.value.exportCurrentReportCsv) {
          reportesRef.value.exportCurrentReportCsv();
        } else {
          exportRecordsCsv();
        }
      } else if (actionType === 'modal-clock') {
        navigateTo('relojes');
        nextTick(() => {
          if (relojesRef.value && relojesRef.value.openAddModal) {
            relojesRef.value.openAddModal();
          }
        });
      } else if (actionType === 'modal-employee') {
        navigateTo('empleados');
        nextTick(() => {
          if (empleadosRef.value && empleadosRef.value.openNewEmployee) {
            empleadosRef.value.openNewEmployee();
          }
        });
      } else if (actionType === 'modal-area') {
        navigateTo('areas');
        nextTick(() => {
          if (areasRef.value && areasRef.value.openNewArea) {
            areasRef.value.openNewArea();
          }
        });
      } else if (actionType === 'report-send-email') {
        navigateTo('reportes');
        nextTick(() => {
          if (reportesRef.value && reportesRef.value.openSendEmailModal) {
            reportesRef.value.openSendEmailModal();
          }
        });
      } else if (actionType === 'report-smtp-config') {
        navigateTo('reportes');
        nextTick(() => {
          if (reportesRef.value) {
            reportesRef.value.isConfigModalOpen = true;
          }
        });
      } else if (actionType === 'test-clock-conn') {
        testPrimaryClock();
      }
    }

    async function testPrimaryClock() {
      try {
        const devId = primaryClock.value.id || 1;
        const res = await fetch(`/api/devices/${devId}/test-connection`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast({
            title: `Conexión ISAPI Exitosa (${data.latency_ms} ms)`,
            subtitle: `Hardware: ${data.modelo} • Firmware: ${data.firmware}`,
            badge: 'ONLINE',
            type: 'info'
          });
        } else {
          showToast({
            title: 'Fallo de enlace con el reloj',
            subtitle: data.error || 'Verifique la IP y contraseña del checador',
            badge: 'ERROR RED',
            type: 'rebote'
          });
        }
      } catch (e) {
        showToast({
          title: 'Error de red',
          subtitle: String(e),
          badge: 'ERROR',
          type: 'rebote'
        });
      }
    }

    function onUpdateUser(newU) {
      currentUser.value = { ...currentUser.value, ...newU };
    }

    function openConfigModal(section = 'perfil') {
      configInitialSection.value = section;
      isConfigModalOpen.value = true;
    }

    function handleHashChange() {
      const hash = (window.location.hash || '').replace('#/', '').trim();
      if (hash && MODULES_NAV.some(m => m.id === hash)) {
        activeModule.value = hash;
      }
    }

    onMounted(async () => {
      handleHashChange();
      window.addEventListener('hashchange', handleHashChange);
      await fetchOverview(false);
      // Poll every 2 seconds so new check-ins appear automatically on screen
      pollTimer = setInterval(() => {
        fetchOverview(true);
      }, 2000);
    });

    onUnmounted(() => {
      window.removeEventListener('hashchange', handleHashChange);
      if (pollTimer) clearInterval(pollTimer);
      if (toastTimer) clearTimeout(toastTimer);
      if (islandTimer) clearTimeout(islandTimer);
    });

    return {
      activeModule,
      isSidebarCollapsed,
      isSyncing,
      islandActivity,
      isConfigModalOpen,
      configInitialSection,
      summary,
      records,
      devices,
      employees,
      areas,
      toast,
      currentUser,
      currentModuleMeta,
      primaryClock,
      branchRecords,
      branchEmployees,
      branchDevices,
      selectBranch,
      selectedBranchId,
      fetchOverview,
      syncActiveClock,
      navigateTo,
      handleQuickAction,
      onToast,
      exportRecordsCsv,
      openConfigModal,
      onUpdateUser,
      relojesRef,
      empleadosRef,
      areasRef,
      reportesRef
    };
  },
  template: `
    <div class="h-screen w-screen flex flex-col bg-[#E9ECF1] overflow-hidden select-none">
      
      <!-- Top Header with Dynamic Island -->
      <AppHeader
        :title="activeModule === 'inicio' ? primaryClock.nombre : currentModuleMeta.title"
        :branches="devices"
        :selected-branch-id="primaryClock.id"
        @select-branch="selectBranch"
        :active-module="activeModule"
        :module-icon="currentModuleMeta.icon"
        :user="currentUser"
        :branch-name="primaryClock.nombre + ' (' + primaryClock.ip + ')'"
        :live-count="summary.total_checadas || records.length"
        :activity="islandActivity"
        :is-syncing="isSyncing"
        :branch-ip="primaryClock.ip"
        @toggle-sidebar="isSidebarCollapsed = !isSidebarCollapsed"
        @open-config="openConfigModal"
        @navigate="navigateTo"
        @quick-action="handleQuickAction"
      />

      <!-- Main Workspace Layout -->
      <div class="flex-1 flex overflow-hidden relative">
        
        <!-- Left Collapsible Sidebar -->
        <AppSidebar
          :active-module="activeModule"
          :is-collapsed="isSidebarCollapsed"
          :branch-name="primaryClock.nombre"
          :branch-subtitle="primaryClock.ip + ' • Wi-Fi TBS'"
          @select-module="navigateTo"
          @quick-action="handleQuickAction"
        />

        <!-- Active Module Viewport -->
        <main class="flex-1 h-full overflow-y-auto p-6 md:p-8 bg-[#E9ECF1] relative flex flex-col">
          
          <ViewInicio
            v-if="activeModule === 'inicio'"
            :summary="summary"
            :recent-records="branchRecords"
            :devices="branchDevices"
            :employees="branchEmployees"
            :areas="areas"
            :is-syncing="isSyncing"
            :user="currentUser"
            @navigate="navigateTo"
            @sync-clock="syncActiveClock"
          />

          <ViewMonitor
            v-else-if="activeModule === 'monitor'"
            :records="records"
            :summary="summary"
            :is-syncing="isSyncing"
            @sync-clock="syncActiveClock"
            @export-csv="exportRecordsCsv"
          />

          <ViewRelojes
            v-else-if="activeModule === 'relojes'"
            ref="relojesRef"
            :devices="devices"
            :areas="areas"
            :is-syncing="isSyncing"
            @refresh="fetchOverview(false)"
            @toast="onToast"
          />

          <ViewEmpleados
            v-else-if="activeModule === 'empleados'"
            ref="empleadosRef"
            :employees="employees"
            :areas="areas"
            @refresh="fetchOverview(false)"
            @toast="onToast"
            @sync-clock="syncActiveClock"
          />

          <ViewAreas
            v-else-if="activeModule === 'areas'"
            ref="areasRef"
            :areas="areas"
            @refresh="fetchOverview(false)"
            @toast="onToast"
          />

          <ViewReportes
            v-else-if="activeModule === 'reportes'"
            ref="reportesRef"
            :records="records"
            :employees="employees"
            :devices="devices"
            :areas="areas"
            :summary="summary"
            @toast="onToast"
          />

          <ViewConfiguracion
            v-else-if="activeModule === 'configuracion'"
            :devices="devices"
            :user="currentUser"
            @toast="onToast"
            @refresh="fetchOverview(false)"
            @update-user="onUpdateUser"
          />

        </main>

        <!-- Floating Real-Time Check-in Notification Toast -->
        <div
          v-if="toast.visible"
          class="fixed bottom-6 right-6 z-50 max-w-md bg-white text-charcoal-900 rounded-2xl p-4 shadow-xl border border-charcoal-200 flex items-start gap-3.5 modal-card-anim">
          <div
            class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-lg"
            :class="toast.type === 'rebote' ? 'bg-amber-50 text-amber-600' : (toast.type === 'info' ? 'bg-sky-50 text-sky-600' : 'bg-emerald-50 text-emerald-600')">
            <i :class="['ph', toast.type === 'rebote' ? 'ph-warning-circle' : (toast.type === 'info' ? 'ph-arrows-clockwise' : 'ph-fingerprint')]"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span
                class="text-[10px] mono-code font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                :class="toast.type === 'rebote' ? 'bg-amber-50 text-amber-700' : (toast.type === 'info' ? 'bg-sky-50 text-sky-700' : 'bg-emerald-50 text-emerald-700')">
                {{ toast.badge }}
              </span>
              <span class="text-[10px] text-charcoal-400 mono-code">192.168.11.71</span>
            </div>
            <p class="text-sm font-bold text-charcoal-900 mt-1 truncate">{{ toast.title }}</p>
            <p class="text-xs text-charcoal-500 mono-code mt-0.5 leading-relaxed">{{ toast.subtitle }}</p>
          </div>
          <button
            type="button"
            @click="toast.visible = false"
            class="text-charcoal-400 hover:text-charcoal-900 p-1 rounded-lg transition-colors cursor-pointer">
            <i class="ph ph-x text-sm"></i>
          </button>
        </div>

      </div>

      <!-- System Configuration Modal -->
      <ModalConfig
        :is-open="isConfigModalOpen"
        :initial-section="configInitialSection"
        :user="currentUser"
        @close="isConfigModalOpen = false"
        @navigate="navigateTo"
        @update-user="onUpdateUser"
      />


    </div>
  `
};

createApp(App).mount('#app');
