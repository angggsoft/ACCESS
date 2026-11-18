// Main Vue 3 Root Application — ACCESS Cloud SaaS
// Soporta Multi-Empresa, Multi-Sucursal, Clave Dinámica 5 min (TOTP), Protocolo One-Way Push y Rol ADMIN_SAAS

import { createApp, ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import AppHeader from './components/AppHeader.js';
import AppSidebar, { MODULES_NAV, ADMIN_MODULES_NAV } from './components/AppSidebar.js';
import ViewInicio from './components/ViewInicio.js';
import ViewMonitor from './components/ViewMonitor.js';
import ViewRelojes from './components/ViewRelojes.js';
import ViewEmpleados from './components/ViewEmpleados.js';
import ViewAreas from './components/ViewAreas.js';
import ViewReportes from './components/ViewReportes.js';
import ViewConfiguracion from './components/ViewConfiguracion.js';
import ViewAdminSaas from './components/ViewAdminSaas.js';
import ModalConfig from './components/ModalConfig.js';
import ModalConfirmHost from './components/ModalConfirm.js';

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
    ViewAdminSaas,
    ModalConfirmHost,
    ModalConfig
  },
  setup() {
    const activeModule = ref('inicio');
    const isSidebarCollapsed = ref(false);
    const isSyncing = ref(false);

    // Modales Globales y Sección Activa del Módulo Empresa
    const isConfigModalOpen = ref(false);
    const configInitialSection = ref('perfil');
    const empresaSection = ref('empresas');

    // Referencias a vistas activas para disparar acciones desde el Header
    const relojesRef = ref(null);
    const empleadosRef = ref(null);
    const areasRef = ref(null);
    const reportesRef = ref(null);

    // Estado de Sesión, Rol y Suscripción
    const currentUser = ref({
      id: 1,
      name: localStorage.getItem('quodo_access_user') || 'Angel Flores',
      role: 'Director de RH y Operaciones',
      role_type: 'CLIENTE_RH',
      avatar: 'AF',
      subscription: {
        plan: 'ANUAL ENTERPRISE',
        estado: 'ACTIVA',
        is_active: true,
        fecha_vencimiento: '2027-11-13',
        dias_restantes: 365
      }
    });

    const isAdminSaas = computed(() => currentUser.value?.role_type === 'ADMIN_SAAS');
    const isSubscriptionActive = computed(() => {
      if (isAdminSaas.value) return true;
      return Boolean(currentUser.value?.subscription?.is_active);
    });

    // Estado Multi-Empresa y Multi-Sucursal
    const companies = ref([]);
    const activeCompanyId = ref(Number(localStorage.getItem('access_company_id')) || null);
    const activeBranchId = ref(Number(localStorage.getItem('access_branch_id')) || null);

    const activeCompany = computed(() => {
      return companies.value.find(c => c.id === activeCompanyId.value) || companies.value[0] || {
        id: null,
        nombre: 'Sin empresa',
        codigo_invitacion: '',
        is_owner: true,
        sucursales: []
      };
    });

    const activeBranch = computed(() => {
      const sucs = activeCompany.value?.sucursales || [];
      return sucs.find(s => s.id === activeBranchId.value) || sucs[0] || {
        id: null,
        nombre: 'Sin sucursal',
        ubicacion: ''
      };
    });

    // Periodo activo del Dashboard (hoy | 7d | 14d | 30d | mes | all)
    const selectedPeriod = ref(localStorage.getItem('access_period') || '14d');

    function setPeriod(p) {
      selectedPeriod.value = p;
      localStorage.setItem('access_period', p);
    }

    const periodRecords = computed(() => {
      if (selectedPeriod.value === 'all') return records.value;
      const now = new Date();
      const todayStr = now.toLocaleDateString('sv-SE');
      if (selectedPeriod.value === 'hoy') {
        return records.value.filter(r => (r.fecha_hora_display || '').startsWith(todayStr));
      }
      if (selectedPeriod.value === 'mes') {
        const monthPrefix = todayStr.slice(0, 7);
        return records.value.filter(r => (r.fecha_hora_display || '').startsWith(monthPrefix));
      }
      const days = selectedPeriod.value === '7d' ? 7 : (selectedPeriod.value === '30d' ? 30 : 14);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (days - 1));
      const cutoffStr = cutoff.toLocaleDateString('sv-SE');
      return records.value.filter(r => (r.fecha_hora_display || '').slice(0, 10) >= cutoffStr);
    });

    // Global Reactive Data from Backend (Scoped to active Company & Branch)
    const summary = ref({
      total_checadas: 0,
      checadas_hoy: 0,
      validas_hoy: 0,
      rebotes_hoy: 0,
      total_empleados: 0,
      total_areas: 0,
      total_relojes: 0,
      relojes_online: 0
    });
    const records = ref([]);
    const devices = ref([]);
    const employees = ref([]);
    const areas = ref([]);

    // Toast & Dynamic Island Notifications
    const toast = ref({
      visible: false,
      title: '',
      subtitle: '',
      badge: '',
      type: 'checkin'
    });
    let toastTimer = null;
    let islandTimer = null;
    const islandActivity = ref(null);
    const notifyUnnamedEmployees = ref(true);
    let pollTimer = null;
    let lastTopRecordId = null;

    const currentModuleMeta = computed(() => {
      if (isAdminSaas.value) return ADMIN_MODULES_NAV[0];
      return MODULES_NAV.find(m => m.id === activeModule.value) || MODULES_NAV[0];
    });

    const primaryClock = computed(() => {
      return devices.value[0] || {
        id: 1,
        nombre: activeBranch.value?.nombre || 'Cerro Gordo',
        ip: 'Push Cloud',
        ubicacion: activeBranch.value?.ubicacion || 'Acceso Principal'
      };
    });

    function showIslandActivity({ title, clock = '', method = '', badge = '', type = 'checkin', empNo = null }, ms = 4200) {
      if (islandTimer) clearTimeout(islandTimer);
      islandActivity.value = { id: Date.now(), title, clock, method, badge, type, empNo };
      islandTimer = setTimeout(() => { islandActivity.value = null; }, ms);
    }

    function showToast({ title, subtitle = '', badge = 'EN VIVO', type = 'checkin' }) {
      if (toastTimer) clearTimeout(toastTimer);
      toast.value = { visible: true, title, subtitle, badge, type };
      toastTimer = setTimeout(() => { toast.value.visible = false; }, 5000);
    }

    function onToast(msg, kind) {
      showToast({
        title: msg,
        subtitle: '',
        badge: kind === 'error' ? 'ALERTA' : 'LISTO',
        type: kind === 'error' ? 'rebote' : 'info'
      });
    }

    async function loadSessionUser() {
      try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const data = await res.json();
        if (data.user) {
          currentUser.value = data.user;
          if (data.user.role_type === 'ADMIN_SAAS') {
            activeModule.value = 'admin_saas';
          }
        }
        if (Array.isArray(data.companies) && data.companies.length) {
          companies.value = data.companies;
          const validComp = data.companies.find(c => c.id === activeCompanyId.value) || data.companies[0];
          activeCompanyId.value = validComp.id;
          const validSuc = (validComp.sucursales || []).find(s => s.id === activeBranchId.value) || (validComp.sucursales || [])[0];
          activeBranchId.value = validSuc ? validSuc.id : null;
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function fetchOverview(silent = true) {
      if (isAdminSaas.value || !isSubscriptionActive.value) return;
      try {
        const q = new URLSearchParams();
        if (activeCompanyId.value) q.set('empresa_id', String(activeCompanyId.value));
        if (activeBranchId.value) q.set('sucursal_id', String(activeBranchId.value));

        const res = await fetch(`/api/dashboard/overview?${q.toString()}`);
        if (!res.ok) return;
        const data = await res.json();

        if (Array.isArray(data.companies)) {
          companies.value = data.companies;
        }
        if (data.active_empresa_id) {
          activeCompanyId.value = data.active_empresa_id;
          localStorage.setItem('access_company_id', String(data.active_empresa_id));
        }
        if (data.active_sucursal_id) {
          activeBranchId.value = data.active_sucursal_id;
          localStorage.setItem('access_branch_id', String(data.active_sucursal_id));
        }

        if (data.summary) summary.value = data.summary;
        if (data.subscription && currentUser.value) {
          currentUser.value = { ...currentUser.value, subscription: data.subscription };
        }
        if (data.settings) {
          notifyUnnamedEmployees.value = data.settings.notify_unnamed_employees === undefined
            ? true
            : (data.settings.notify_unnamed_employees === '1' || data.settings.notify_unnamed_employees === true);
        }
        if (Array.isArray(data.devices)) devices.value = data.devices;
        if (Array.isArray(data.employees)) employees.value = data.employees;
        if (Array.isArray(data.areas)) areas.value = data.areas;

        if (Array.isArray(data.recent_records)) {
          const newest = data.recent_records[0];
          if (newest && lastTopRecordId !== null && newest.id > lastTopRecordId) {
            const isBounce = Boolean(newest.es_rebote);
            const isUnnamed = Boolean(newest.sin_nombre);
            const nm = (newest.nombre || '').trim();
            if (isUnnamed && notifyUnnamedEmployees.value) {
              showIslandActivity({
                title: `${nm || ('Empleado #' + newest.codigo_empleado)} · Asignar nombre`,
                clock: newest.reloj_nombre || primaryClock.value.nombre,
                method: newest.metodo || 'BIOMÉTRICO',
                badge: 'SIN NOMBRE',
                type: 'unnamed',
                empNo: newest.codigo_empleado
              }, 5800);
            } else {
              showIslandActivity({
                title: nm || 'Empleado #' + newest.codigo_empleado,
                clock: newest.reloj_nombre || primaryClock.value.nombre,
                method: newest.metodo || 'BIOMÉTRICO',
                badge: isBounce ? 'REBOTE' : 'VÁLIDO',
                type: isBounce ? 'rebote' : 'checkin'
              });
            }
          }
          if (newest) {
            lastTopRecordId = newest.id;
          } else {
            lastTopRecordId = 0;
          }
          records.value = data.recent_records;
        }
      } catch (e) {
        if (!silent) console.error('Error actualizando dashboard:', e);
      }
    }

    async function selectCompanyScope({ empresaId, sucursalId }) {
      activeCompanyId.value = empresaId;
      localStorage.setItem('access_company_id', String(empresaId));
      const comp = companies.value.find(c => c.id === empresaId);
      const branchId = sucursalId || (comp?.sucursales?.[0]?.id) || null;
      activeBranchId.value = branchId;
      if (branchId) localStorage.setItem('access_branch_id', String(branchId));
      lastTopRecordId = null;
      await fetchOverview(false);
      showToast({
        title: `${activeCompany.value.nombre} • ${activeBranch.value.nombre}`,
        subtitle: 'Contexto operativo actualizado',
        badge: 'SEDE ACTIVA',
        type: 'info'
      });
    }

    async function handleRefreshCompanies(scopeHint) {
      await loadSessionUser();
      if (scopeHint && scopeHint.empresaId) {
        await selectCompanyScope(scopeHint);
      } else {
        await fetchOverview(false);
      }
    }

    async function refreshDashboard() {
      if (isSyncing.value || isAdminSaas.value) return;
      isSyncing.value = true;
      try {
        await fetchOverview(false);
        onToast('Datos actualizados');
      } catch (e) {
        console.error(e);
      } finally {
        isSyncing.value = false;
      }
    }

    function exportRecordsCsv() {
      const rows = [
        ['ID', 'Empresa', 'Sucursal', 'SerialReloj', 'IDEmpleado', 'Nombre', 'Area', 'Metodo', 'FechaHoraReloj', 'EstatusPreNomina', 'Reloj']
      ];
      records.value.forEach(r => {
        rows.push([
          r.id,
          `"${activeCompany.value.nombre}"`,
          `"${activeBranch.value.nombre}"`,
          r.serial_no || '',
          r.codigo_empleado,
          `"${(r.nombre || '').replace(/"/g, '""')}"`,
          `"${(r.area || 'General').replace(/"/g, '""')}"`,
          r.metodo || 'BIOMETRÍA',
          r.fecha_hora_evento,
          r.estatus_prenomina || (r.es_rebote ? 'REBOTE_IGNORADO' : 'VALIDO'),
          `"${r.reloj_nombre || primaryClock.value.nombre}"`
        ]);
      });
      const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + rows.map(e => e.join(',')).join('\n');
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `bitacora_${activeBranch.value.nombre.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function openCompaniesModal(tab = 'empresas') {
      const targetSection = tab === 'selector' ? 'empresas' : tab;
      empresaSection.value = targetSection;
      navigateTo('areas');
      nextTick(() => {
        if (areasRef.value && areasRef.value.setSection) {
          areasRef.value.setSection(targetSection);
        }
      });
    }

    function navigateTo(moduleId) {
      if (isAdminSaas.value) {
        activeModule.value = 'admin_saas';
        return;
      }
      if (MODULES_NAV.some(m => m.id === moduleId)) {
        activeModule.value = moduleId;
        window.location.hash = `#/${moduleId}`;
      }
    }

    function handleQuickAction(actionType) {
      if (actionType === 'refresh' || actionType === 'sync-clock' || actionType === 'simulate-push') {
        refreshDashboard();
      } else if (actionType === 'modal-companies') {
        openCompaniesModal('empresas');
      } else if (actionType === 'empresa-nueva') {
        openCompaniesModal('nueva_empresa');
      } else if (actionType === 'modal-invite') {
        openCompaniesModal('invitar');
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
      } else if (actionType && actionType.startsWith('edit-unnamed:')) {
        const empNo = actionType.slice('edit-unnamed:'.length);
        navigateTo('empleados');
        nextTick(() => {
          if (empleadosRef.value && empleadosRef.value.openEditByCode) {
            empleadosRef.value.openEditByCode(empNo);
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
      if (isAdminSaas.value) return;
      const hash = (window.location.hash || '').replace('#/', '').trim();
      if (hash && MODULES_NAV.some(m => m.id === hash)) {
        activeModule.value = hash;
      }
    }

    onMounted(async () => {
      await loadSessionUser();
      handleHashChange();
      window.addEventListener('hashchange', handleHashChange);
      if (!isAdminSaas.value && isSubscriptionActive.value) {
        await fetchOverview(false);
      }
      pollTimer = setInterval(() => {
        if (!isAdminSaas.value && isSubscriptionActive.value) {
          fetchOverview(true);
        }
      }, 2500);
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
      empresaSection,
      openCompaniesModal,
      companies,
      activeCompanyId,
      activeBranchId,
      activeCompany,
      activeBranch,
      selectCompanyScope,
      handleRefreshCompanies,
      summary,
      records,
      periodRecords,
      selectedPeriod,
      setPeriod,
      devices,
      employees,
      areas,
      toast,
      currentUser,
      isAdminSaas,
      isSubscriptionActive,
      currentModuleMeta,
      primaryClock,
      fetchOverview,
      refreshDashboard,
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
        :title="isAdminSaas ? 'Consola Administrador SaaS' : currentModuleMeta.title"
        :branches="devices"
        :selected-branch-id="activeBranch.id"
        :active-module="activeModule"
        :module-icon="currentModuleMeta.icon"
        :user="currentUser"
        :company-name="activeCompany.nombre"
        :branch-name="activeBranch.nombre"
        :companies="companies"
        :selected-company-id="activeCompanyId"
        :period="selectedPeriod"
        :live-count="summary.total_checadas || records.length"
        :activity="islandActivity"
        :is-syncing="isSyncing"
        :branch-ip="primaryClock.ip"
        :is-sidebar-collapsed="isSidebarCollapsed"
        @toggle-sidebar="isSidebarCollapsed = !isSidebarCollapsed"
        @open-config="openConfigModal"
        @open-companies="openCompaniesModal"
        @select-company="selectCompanyScope"
        @update:period="setPeriod"
        @navigate="navigateTo"
        @quick-action="handleQuickAction"
      />

      <!-- Main Workspace Layout -->
      <div class="flex-1 flex overflow-hidden relative">
        
        <!-- Left Collapsible Sidebar -->
        <AppSidebar
          :active-module="activeModule"
          :is-collapsed="isSidebarCollapsed"
          :is-admin-saas="isAdminSaas"
          :company-name="activeCompany.nombre"
          :branch-name="activeBranch.nombre"
          @select-module="navigateTo"
          @quick-action="handleQuickAction"
        />

        <!-- Active Module Viewport -->
        <main class="flex-1 h-full overflow-y-auto p-6 md:p-8 bg-[#E9ECF1] relative flex flex-col">

          <!-- 1. ROL ADMINISTRADOR SAAS: GESTIÓN EXCLUSIVA DE USUARIOS Y SUSCRIPCIONES -->
          <ViewAdminSaas
            v-if="isAdminSaas"
            @toast="onToast"
          />

          <!-- 2. ROL CLIENTE RH CON SUSCRIPCIÓN VENCIDA O SUSPENDIDA (BLOQUEO DE SEGURIDAD) -->
          <div
            v-else-if="!isSubscriptionActive"
            class="flex-1 flex items-center justify-center p-4">
            <div class="max-w-lg w-full bg-white rounded-3xl p-8 border border-charcoal-200 shadow-lg text-center space-y-5">
              <div class="w-16 h-16 rounded-3xl bg-rose-50 text-rose-600 border border-rose-200 flex items-center justify-center text-3xl mx-auto">
                <i class="ph ph-lock-key"></i>
              </div>
              <div>
                <span class="text-[10px] mono-code font-bold uppercase px-3 py-1 rounded-full bg-rose-100 text-rose-800">
                  SUSCRIPCIÓN {{ currentUser.subscription?.estado || 'INACTIVA' }}
                </span>
                <h2 class="text-xl font-bold text-charcoal-900 mt-3">Tu suscripción requiere renovación</h2>
                <p class="text-xs text-charcoal-500 mt-1.5 leading-relaxed">
                  Hola <b>{{ currentUser.name }}</b>, para acceder al monitoreo en tiempo real y pre-nómina de tus empresas y sucursales es necesario contar con una suscripción activa.
                </p>
              </div>
              <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 text-xs space-y-1.5 text-left">
                <div class="flex justify-between">
                  <span class="text-charcoal-500">Plan Registrado:</span>
                  <b class="mono-code text-charcoal-900">{{ currentUser.subscription?.plan }}</b>
                </div>
                <div class="flex justify-between">
                  <span class="text-charcoal-500">Fecha de Vencimiento:</span>
                  <b class="mono-code text-rose-600">{{ currentUser.subscription?.fecha_vencimiento }}</b>
                </div>
              </div>
              <div class="pt-2 flex items-center justify-center gap-3">
                <a href="/logout" class="px-6 py-3 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 transition-all">
                  <i class="ph ph-sign-out"></i>
                  <span>Cambiar de Cuenta / Contactar Admin</span>
                </a>
              </div>
            </div>
          </div>

          <!-- 3. ROL CLIENTE RH CON SUSCRIPCIÓN ACTIVA -->
          <template v-else>
            <ViewInicio
              v-if="activeModule === 'inicio'"
              :summary="summary"
              :recent-records="periodRecords"
              :devices="devices"
              :employees="employees"
              :areas="areas"
              :period="selectedPeriod"
              :is-syncing="isSyncing"
              :user="currentUser"
              @navigate="navigateTo"
              @sync-clock="refreshDashboard"
            />

            <ViewMonitor
              v-else-if="activeModule === 'monitor'"
              :records="periodRecords"
              :summary="summary"
              :employees="employees"
              :is-syncing="isSyncing"
              @sync-clock="refreshDashboard"
              @export-csv="exportRecordsCsv"
              @refresh="fetchOverview(false)"
              @toast="onToast"
            />

            <ViewRelojes
              v-else-if="activeModule === 'relojes'"
              ref="relojesRef"
              :devices="devices"
              :areas="areas"
              :empresa-id="activeCompany.id"
              :sucursal-id="activeBranch.id"
              :subscription="currentUser.subscription"
              :is-syncing="isSyncing"
              @refresh="fetchOverview(false)"
              @toast="onToast"
            />

            <ViewEmpleados
              v-else-if="activeModule === 'empleados'"
              ref="empleadosRef"
              :employees="employees"
              :areas="areas"
              :empresa-id="activeCompany.id"
              :sucursal-id="activeBranch.id"
              @refresh="fetchOverview(false)"
              @toast="onToast"
            />

            <ViewAreas
              v-else-if="activeModule === 'areas'"
              ref="areasRef"
              :areas="areas"
              :companies="companies"
              :empresa-id="activeCompany.id"
              :sucursal-id="activeBranch.id"
              :initial-section="empresaSection"
              @refresh="fetchOverview(false)"
              @select-scope="selectCompanyScope"
              @refresh-companies="handleRefreshCompanies"
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
              :empresa-id="activeCompany.id"
              :sucursal-id="activeBranch.id"
              @toast="onToast"
            />

            <ViewConfiguracion
              v-else-if="activeModule === 'configuracion'"
              :devices="devices"
              :companies="companies"
              :user="currentUser"
              @toast="onToast"
              @refresh="fetchOverview(false)"
              @update-user="onUpdateUser"
            />
          </template>

        </main>

        <!-- Floating Real-Time Notification Toast -->
        <div
          v-if="toast.visible"
          class="fixed bottom-6 right-6 z-50 w-[22rem] max-w-[calc(100vw-3rem)] bg-white text-charcoal-900 rounded-2xl pl-4 pr-3 py-3.5 shadow-md border border-charcoal-200 flex items-start gap-3 modal-card-anim">
          <span class="w-5 flex items-center justify-center shrink-0 mt-0.5">
            <i
              :class="['ph text-lg', toast.type === 'rebote' ? 'ph-warning-circle text-rose-600' : (toast.type === 'info' ? 'ph-check-circle text-charcoal-400' : 'ph-fingerprint text-charcoal-400')]"></i>
          </span>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-charcoal-900 leading-snug">{{ toast.title }}</p>
            <p v-if="toast.subtitle" class="text-xs text-charcoal-500 mono-code mt-0.5 leading-relaxed">{{ toast.subtitle }}</p>
            <p class="text-[10px] text-charcoal-400 mono-code mt-1 uppercase tracking-wider">
              {{ toast.badge }}<span v-if="activeBranch && activeBranch.nombre"> · {{ activeBranch.nombre }}</span>
            </p>
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

      <!-- Diálogos propios del sistema (confirmación / aviso) -->
      <ModalConfirmHost />

    </div>
  `
};

createApp(App).mount('#app');
