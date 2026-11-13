// Component: AppHeader
// Desktop top bar with sidebar toggle, single-line Dynamic Island status pill, Multi-Company/Branch switcher, dynamic module Actions dropdown, and user profile popover

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { MODULES_NAV } from './AppSidebar.js';

export default {
  name: 'AppHeader',
  props: {
    title: { type: String, default: 'Inicio' },
    activeModule: { type: String, default: 'inicio' },
    moduleIcon: { type: String, default: 'ph-house' },
    user: {
      type: Object,
      default: () => ({
        name: 'Angel Flores',
        role: 'Director de RH y Operaciones',
        role_type: 'CLIENTE_RH',
        avatar: 'AF'
      })
    },
    companyName: { type: String, default: '' },
    branchName: { type: String, default: '' },
    companies: { type: Array, default: () => [] },
    selectedCompanyId: { type: [Number, String, null], default: null },
    period: { type: String, default: '14d' },
    liveCount: { type: Number, default: 0 },
    branches: { type: Array, default: () => [] },
    selectedBranchId: { type: [Number, String, null], default: null },
    activity: { type: Object, default: null },
    isSyncing: { type: Boolean, default: false },
    branchIp: { type: String, default: '' },
    isSidebarCollapsed: { type: Boolean, default: false }
  },
  emits: ['toggle-sidebar', 'open-config', 'open-companies', 'select-company', 'navigate', 'select-branch', 'quick-action', 'update:period'],
  setup(props, { emit }) {
    const isMenuOpen = ref(false);
    const menuContainerRef = ref(null);

    const isActionsOpen = ref(false);
    const actionsContainerRef = ref(null);

    const isPeriodOpen = ref(false);
    const periodContainerRef = ref(null);

    const isCompanyOpen = ref(false);
    const companyContainerRef = ref(null);

    const isBranchOpen = ref(false);
    const branchContainerRef = ref(null);

    const activeCompanyObj = computed(() => {
      return props.companies.find(c => c.id === props.selectedCompanyId) || props.companies[0] || null;
    });

    const activeCompanyBranches = computed(() => {
      return activeCompanyObj.value?.sucursales || [];
    });

    const PERIOD_OPTIONS = [
      { id: 'hoy', label: 'Hoy', subtitle: 'Solo registros de hoy' },
      { id: '7d', label: 'Últimos 7 días', subtitle: 'Semana reciente' },
      { id: '14d', label: 'Últimos 14 días', subtitle: 'Quincena operativa' },
      { id: '30d', label: 'Últimos 30 días', subtitle: 'Último mes' },
      { id: 'mes', label: 'Este mes', subtitle: 'Mes calendario actual' },
      { id: 'all', label: 'Todo el historial', subtitle: 'Sin límite de fecha' }
    ];

    const activePeriodLabel = computed(() => {
      return (PERIOD_OPTIONS.find(p => p.id === props.period) || PERIOD_OPTIONS[2]).label;
    });

    const measureRef = ref(null);
    const pillWidth = ref(180);
    let resizeObserver = null;

    const isAdminSaas = computed(() => props.user?.role_type === 'ADMIN_SAAS');

    const currentModule = computed(() => {
      return MODULES_NAV.find(m => m.id === props.activeModule) || MODULES_NAV[0];
    });

    const liveActivity = computed(() => {
      if (props.activity) return props.activity;
      if (props.isSyncing) {
        return {
          id: 'sync',
          type: 'sync',
          title: 'Actualizando datos…',
          method: '',
          badge: ''
        };
      }
      return null;
    });

    const isMorphing = ref(false);
    let morphTimer = null;

    function triggerMorph() {
      isMorphing.value = true;
      if (morphTimer) clearTimeout(morphTimer);
      morphTimer = setTimeout(() => {
        isMorphing.value = false;
      }, 540);
    }

    function onIslandClick() {
      triggerMorph();
      if (!isAdminSaas.value) {
        emit('quick-action', 'refresh');
      }
    }

    function measurePillWidth() {
      const el = measureRef.value;
      if (!el) return;
      const contentW = Math.ceil(el.getBoundingClientRect().width);
      pillWidth.value = Math.min(Math.max(contentW + 48, 140), 760);
    }

    function toggleMenu(e) {
      if (e) e.stopPropagation();
      isActionsOpen.value = false;
      isPeriodOpen.value = false;
      isCompanyOpen.value = false;
      isBranchOpen.value = false;
      isMenuOpen.value = !isMenuOpen.value;
    }

    function toggleActions(e) {
      if (e) e.stopPropagation();
      isMenuOpen.value = false;
      isPeriodOpen.value = false;
      isCompanyOpen.value = false;
      isBranchOpen.value = false;
      isActionsOpen.value = !isActionsOpen.value;
    }

    function togglePeriod(e) {
      if (e) e.stopPropagation();
      isMenuOpen.value = false;
      isActionsOpen.value = false;
      isCompanyOpen.value = false;
      isBranchOpen.value = false;
      isPeriodOpen.value = !isPeriodOpen.value;
    }

    function toggleCompany(e) {
      if (e) e.stopPropagation();
      isMenuOpen.value = false;
      isActionsOpen.value = false;
      isPeriodOpen.value = false;
      isBranchOpen.value = false;
      isCompanyOpen.value = !isCompanyOpen.value;
    }

    function toggleBranch(e) {
      if (e) e.stopPropagation();
      isMenuOpen.value = false;
      isActionsOpen.value = false;
      isPeriodOpen.value = false;
      isCompanyOpen.value = false;
      isBranchOpen.value = !isBranchOpen.value;
    }

    function chooseCompany(comp, suc = null) {
      isCompanyOpen.value = false;
      const targetBranch = suc || (comp.sucursales && comp.sucursales[0]) || null;
      emit('select-company', {
        empresaId: comp.id,
        sucursalId: targetBranch ? targetBranch.id : null
      });
    }

    function chooseBranch(suc) {
      isBranchOpen.value = false;
      if (!activeCompanyObj.value) return;
      emit('select-company', {
        empresaId: activeCompanyObj.value.id,
        sucursalId: suc.id
      });
    }

    function openCreateCompany(tab = 'crear') {
      isCompanyOpen.value = false;
      isBranchOpen.value = false;
      emit('open-companies', tab);
    }

    function selectPeriod(periodId) {
      isPeriodOpen.value = false;
      emit('update:period', periodId);
    }

    function triggerAction(actionType) {
      isActionsOpen.value = false;
      emit('quick-action', actionType);
    }

    function openConfig(section) {
      isMenuOpen.value = false;
      emit('open-config', section);
    }

    function handleClickOutside(e) {
      if (menuContainerRef.value && !menuContainerRef.value.contains(e.target)) {
        isMenuOpen.value = false;
      }
      if (actionsContainerRef.value && !actionsContainerRef.value.contains(e.target)) {
        isActionsOpen.value = false;
      }
      if (periodContainerRef.value && !periodContainerRef.value.contains(e.target)) {
        isPeriodOpen.value = false;
      }
      if (companyContainerRef.value && !companyContainerRef.value.contains(e.target)) {
        isCompanyOpen.value = false;
      }
      if (branchContainerRef.value && !branchContainerRef.value.contains(e.target)) {
        isBranchOpen.value = false;
      }
    }

    function handleKeydown(e) {
      if (e.key === 'Escape') {
        isMenuOpen.value = false;
        isActionsOpen.value = false;
        isPeriodOpen.value = false;
        isCompanyOpen.value = false;
        isBranchOpen.value = false;
      }
    }

    onMounted(() => {
      window.addEventListener('click', handleClickOutside);
      window.addEventListener('keydown', handleKeydown);
      measurePillWidth();
      if (typeof ResizeObserver !== 'undefined' && measureRef.value) {
        resizeObserver = new ResizeObserver(measurePillWidth);
        resizeObserver.observe(measureRef.value);
      }
    });

    watch([() => props.activeModule, () => props.title, liveActivity], () => {
      triggerMorph();
      nextTick(measurePillWidth);
    });

    onUnmounted(() => {
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('keydown', handleKeydown);
      if (resizeObserver) resizeObserver.disconnect();
      if (morphTimer) clearTimeout(morphTimer);
    });

    return {
      props,
      isAdminSaas,
      isMenuOpen,
      menuContainerRef,
      toggleMenu,
      isActionsOpen,
      actionsContainerRef,
      toggleActions,
      isPeriodOpen,
      periodContainerRef,
      isCompanyOpen,
      companyContainerRef,
      isBranchOpen,
      branchContainerRef,
      activeCompanyBranches,
      toggleCompany,
      toggleBranch,
      chooseCompany,
      chooseBranch,
      openCreateCompany,
      PERIOD_OPTIONS,
      activePeriodLabel,
      togglePeriod,
      selectPeriod,
      triggerAction,
      currentModule,
      measureRef,
      pillWidth,
      liveActivity,
      isMorphing,
      onIslandClick,
      openConfig
    };
  },
  template: `
    <header class="h-16 shrink-0 bg-white border-b border-charcoal-200 pr-6 flex items-center justify-between relative z-50 shadow-[0_1px_3px_rgba(0,0,0,0.02)] w-full">
      
      <!-- LEFT: Logo (Sidebar toggle) + Selector de Empresas en Inicio -->
      <div class="flex items-center gap-3 z-10">
        <button
          type="button"
          @click="$emit('toggle-sidebar')"
          :title="isSidebarCollapsed ? 'Desplegar menú lateral' : 'Ocultar menú lateral'"
          class="h-16 flex items-center justify-center cursor-pointer group focus:outline-none sidebar-transition shrink-0 overflow-hidden"
          :class="isSidebarCollapsed ? 'w-16' : 'w-64'">
          <span class="flex items-center justify-center transition-transform duration-300 group-hover:scale-110" style="transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);">
            <img
              src="/assets/access.svg"
              alt="A"
              class="h-6 w-6 object-contain shrink-0"
              :style="{
                transform: isSidebarCollapsed ? 'rotate(360deg)' : 'rotate(0deg)',
                transformOrigin: 'center center',
                willChange: 'transform',
                transition: 'transform 700ms cubic-bezier(0.22, 1, 0.36, 1)'
              }">
            <img
              src="/assets/access_ccess.svg"
              alt="ccess"
              class="h-[21px] w-auto object-contain shrink-0"
              :style="{
                maxWidth: isSidebarCollapsed ? '0px' : '96px',
                opacity: isSidebarCollapsed ? 0 : 1,
                marginLeft: isSidebarCollapsed ? '0px' : '2px',
                transition: 'max-width 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 180ms ease, margin-left 220ms cubic-bezier(0.4, 0, 0.2, 1)'
              }">
          </span>
        </button>

        <!-- DROPDOWN SELECTOR DE EMPRESA Y SUCURSAL (Todos los módulos para CLIENTE_RH) -->
        <div v-if="!isAdminSaas" class="flex items-center gap-2">
          <div ref="companyContainerRef" class="relative">
            <button
              type="button"
              @click="toggleCompany"
              title="Seleccionar empresa"
              class="h-10 px-3.5 rounded-2xl border text-xs flex items-center gap-2.5 transition-all cursor-pointer shadow-xs hover:shadow-sm"
              :class="isCompanyOpen
                ? 'bg-charcoal-100 border-charcoal-300 text-charcoal-900 shadow-inner'
                : 'bg-white hover:bg-charcoal-50 border-charcoal-200 hover:border-charcoal-300'">
              <i class="ph ph-buildings text-sm shrink-0" :class="companies.length === 0 ? 'text-charcoal-400' : 'text-charcoal-700'"></i>
              <span
                v-if="companies.length === 0"
                class="font-medium text-charcoal-400 whitespace-nowrap">
                Sin empresas configuradas
              </span>
              <span
                v-else
                class="font-bold text-charcoal-900 tracking-tight whitespace-nowrap max-w-[160px] truncate">
                {{ companyName }}
              </span>
              <i class="ph ph-caret-down text-[10px] text-charcoal-400 transition-transform duration-200" :class="{ 'rotate-180': isCompanyOpen }"></i>
            </button>

            <!-- Panel Dropdown de Empresas -->
            <div
              v-if="isCompanyOpen"
              class="absolute left-0 top-12 w-80 bg-white rounded-2xl border border-charcoal-200/90 shadow-xl overflow-hidden z-50 flex flex-col">

              <!-- Estado Vacío (Versión extendida, centrada V y H, sin recuadro de icono) -->
              <div v-if="companies.length === 0" class="min-h-[220px] flex flex-col items-center justify-center p-6 text-center">
                <i class="ph ph-buildings text-4xl text-charcoal-300 mb-2.5"></i>
                <p class="text-sm font-bold text-charcoal-800">Ups!, no encontramos ninguna empresa</p>
                <p class="text-[11px] text-charcoal-400 mt-1 max-w-xs">
                  Prueba creando una para comenzar a gestionar tus sucursales y relojes.
                </p>
                <button
                  type="button"
                  @click="openCreateCompany('crear')"
                  class="mt-4 px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer">
                  <i class="ph ph-plus-circle"></i>
                  <span>Crear empresa</span>
                </button>
              </div>

              <!-- Lista de Empresas -->
              <template v-else>
                <div class="px-4 py-3 border-b border-charcoal-100 bg-charcoal-50/70 flex items-center justify-between">
                  <div>
                    <div class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">Empresas</div>
                    <div class="text-[11px] text-charcoal-600 font-medium mt-0.5">Selecciona empresa activa</div>
                  </div>
                  <span class="text-[10px] mono-code font-bold px-2 py-0.5 rounded-full bg-charcoal-100 text-charcoal-600">
                    {{ companies.length }}
                  </span>
                </div>

                <div class="p-1.5 max-h-72 overflow-y-auto space-y-1">
                  <button
                    v-for="comp in companies"
                    :key="comp.id"
                    type="button"
                    @click="chooseCompany(comp)"
                    class="w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2"
                    :class="comp.id === selectedCompanyId ? 'bg-charcoal-900 text-white' : 'hover:bg-charcoal-50 text-charcoal-800'">
                    <div class="min-w-0">
                      <div class="text-xs font-bold truncate">{{ comp.nombre }}</div>
                      <div class="text-[10px] truncate" :class="comp.id === selectedCompanyId ? 'text-white/70' : 'text-charcoal-400'">
                        {{ (comp.sucursales && comp.sucursales.length) ? comp.sucursales.length + ' sucursal(es)' : 'Sin sucursales' }}
                      </div>
                    </div>
                    <i v-if="comp.id === selectedCompanyId" class="ph-fill ph-check-circle text-sm text-emerald-400 shrink-0"></i>
                  </button>
                </div>

                <div class="p-2 border-t border-charcoal-100 bg-charcoal-50/50">
                  <button
                    type="button"
                    @click="openCreateCompany('selector')"
                    class="w-full py-2 px-3 rounded-xl text-xs font-semibold text-charcoal-700 hover:bg-charcoal-100 flex items-center justify-center gap-1.5 transition-colors cursor-pointer">
                    <i class="ph ph-gear-six text-sm"></i>
                    <span>Gestionar o crear empresa</span>
                  </button>
                </div>
              </template>
            </div>
          </div>

          <!-- SELECTOR DE SUCURSAL (Oculto si no hay empresas configuradas) -->
          <div v-if="companies.length > 0" ref="branchContainerRef" class="relative">
            <button
              type="button"
              @click="toggleBranch"
              title="Seleccionar sucursal"
              class="h-10 px-3.5 rounded-2xl border text-xs flex items-center gap-2 transition-all cursor-pointer shadow-xs hover:shadow-sm"
              :class="isBranchOpen
                ? 'bg-charcoal-100 border-charcoal-300 text-charcoal-900 shadow-inner'
                : 'bg-white hover:bg-charcoal-50 border-charcoal-200 hover:border-charcoal-300'">
              <i class="ph ph-map-pin text-sm shrink-0" :class="activeCompanyBranches.length === 0 ? 'text-charcoal-400' : 'text-charcoal-600'"></i>
              <span
                v-if="activeCompanyBranches.length === 0"
                class="font-medium text-charcoal-400 whitespace-nowrap">
                Sin sucursales
              </span>
              <span
                v-else
                class="font-semibold text-charcoal-800 tracking-tight whitespace-nowrap max-w-[150px] truncate">
                {{ branchName }}
              </span>
              <i class="ph ph-caret-down text-[10px] text-charcoal-400 transition-transform duration-200" :class="{ 'rotate-180': isBranchOpen }"></i>
            </button>

            <!-- Panel Dropdown de Sucursales -->
            <div
              v-if="isBranchOpen"
              class="absolute left-0 top-12 w-72 bg-white rounded-2xl border border-charcoal-200/90 shadow-xl overflow-hidden z-50 flex flex-col">

              <!-- Estado Vacío de Sucursales -->
              <div v-if="activeCompanyBranches.length === 0" class="min-h-[200px] flex flex-col items-center justify-center p-6 text-center">
                <i class="ph ph-map-pin text-4xl text-charcoal-300 mb-2.5"></i>
                <p class="text-sm font-bold text-charcoal-800">Sin sucursales configuradas</p>
                <p class="text-[11px] text-charcoal-400 mt-1 max-w-xs">
                  Crea una sucursal en esta empresa para asociar tus relojes.
                </p>
                <button
                  type="button"
                  @click="openCreateCompany('selector')"
                  class="mt-4 px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer">
                  <i class="ph ph-plus-circle"></i>
                  <span>Agregar sucursal</span>
                </button>
              </div>

              <!-- Lista de Sucursales -->
              <template v-else>
                <div class="px-4 py-3 border-b border-charcoal-100 bg-charcoal-50/70 flex items-center justify-between">
                  <div>
                    <div class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">Sucursales</div>
                    <div class="text-[11px] text-charcoal-600 font-medium mt-0.5 truncate max-w-[180px]">{{ companyName }}</div>
                  </div>
                  <span class="text-[10px] mono-code font-bold px-2 py-0.5 rounded-full bg-charcoal-100 text-charcoal-600">
                    {{ activeCompanyBranches.length }}
                  </span>
                </div>

                <div class="p-1.5 max-h-64 overflow-y-auto space-y-1">
                  <button
                    v-for="suc in activeCompanyBranches"
                    :key="suc.id"
                    type="button"
                    @click="chooseBranch(suc)"
                    class="w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2"
                    :class="suc.id === selectedBranchId ? 'bg-charcoal-900 text-white' : 'hover:bg-charcoal-50 text-charcoal-800'">
                    <div class="min-w-0">
                      <div class="text-xs font-bold truncate">{{ suc.nombre }}</div>
                      <div class="text-[10px] truncate" :class="suc.id === selectedBranchId ? 'text-white/70' : 'text-charcoal-400'">
                        {{ suc.ubicacion || suc.codigo || 'Sucursal' }}
                      </div>
                    </div>
                    <i v-if="suc.id === selectedBranchId" class="ph-fill ph-check-circle text-sm text-emerald-400 shrink-0"></i>
                  </button>
                </div>

                <div class="p-2 border-t border-charcoal-100 bg-charcoal-50/50">
                  <button
                    type="button"
                    @click="openCreateCompany('selector')"
                    class="w-full py-2 px-3 rounded-xl text-xs font-semibold text-charcoal-700 hover:bg-charcoal-100 flex items-center justify-center gap-1.5 transition-colors cursor-pointer">
                    <i class="ph ph-plus-circle text-sm"></i>
                    <span>Administrar sucursales</span>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- CENTER: DYNAMIC ISLAND (iOS Authentic Spring Status Capsule) -->
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
        <span
          ref="measureRef"
          aria-hidden="true"
          class="fixed invisible pointer-events-none inline-flex items-center gap-2.5 whitespace-nowrap"
          style="left:-9999px; top:0;">
          <template v-if="liveActivity && liveActivity.type === 'sync'">
            <span class="w-3.5 h-3.5 shrink-0"></span>
            <span class="text-xs font-semibold tracking-tight">{{ liveActivity.title }}</span>
          </template>
          <template v-else-if="liveActivity">
            <span v-if="liveActivity.clock" class="text-[10px] mono-code px-2.5 py-0.5">{{ liveActivity.clock }}</span>
            <span v-else class="w-2 h-2 shrink-0"></span>
            <span class="text-xs font-bold tracking-tight">{{ liveActivity.title }}</span>
            <span v-if="liveActivity.method" class="text-[10px] mono-code">{{ liveActivity.method }}</span>
            <span v-if="liveActivity.badge" class="text-[9px] mono-code font-bold px-2 py-0.5">{{ liveActivity.badge }}</span>
          </template>
          <template v-else>
            <span class="w-1.5 h-1.5 shrink-0"></span>
            <span class="text-xs font-semibold tracking-tight">{{ title }}</span>
          </template>
        </span>

        <div
          class="dynamic-island relative flex items-center justify-center select-none text-white pointer-events-auto"
          :class="{ 'is-activity': !!liveActivity, 'is-morphing': isMorphing }"
          :style="{ width: pillWidth + 'px' }"
          @click="onIslandClick"
          :title="isAdminSaas ? 'Consola Administrador SaaS' : 'Isla Dinámica — clic para actualizar datos'">

          <Transition name="island-swap">
            <div
              v-if="liveActivity && liveActivity.type === 'sync'"
              key="state-sync"
              class="flex items-center justify-center gap-2.5 px-4 whitespace-nowrap">
              <span class="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-white animate-spin shrink-0"></span>
              <span class="text-xs font-medium text-white tracking-tight">{{ liveActivity.title }}</span>
            </div>

            <div
              v-else-if="liveActivity"
              :key="'state-evt-' + liveActivity.id"
              class="flex items-center justify-center gap-2.5 px-4 whitespace-nowrap">
              <span
                v-if="liveActivity.clock"
                class="text-[10px] mono-code text-white/90 bg-white/10 border border-white/15 px-2.5 py-0.5 rounded-full shrink-0 flex items-center gap-1.5 shadow-2xs">
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  :class="liveActivity.type === 'rebote' ? 'bg-amber-400' : 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.85)]'"></span>
                <span>{{ liveActivity.clock }}</span>
              </span>
              <span
                v-else
                class="w-2 h-2 rounded-full shrink-0"
                :class="liveActivity.type === 'rebote' ? 'bg-amber-400' : 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)]'"></span>

              <span class="text-xs font-bold text-white tracking-tight shrink-0">{{ liveActivity.title }}</span>
              <span v-if="liveActivity.method" class="text-[10px] mono-code text-white/50 shrink-0">· {{ liveActivity.method }}</span>

              <span
                v-if="liveActivity.badge"
                class="text-[9px] mono-code font-bold px-2 py-0.5 rounded-full shrink-0"
                :class="liveActivity.type === 'rebote' ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30' : 'bg-white text-charcoal-950'">
                {{ liveActivity.badge }}
              </span>
            </div>

            <div
              v-else
              :key="'state-idle-' + title"
              class="flex items-center justify-center gap-2 px-4 whitespace-nowrap">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)] shrink-0 animate-pulse"></span>
              <h1 class="text-xs font-semibold text-white tracking-tight">{{ title }}</h1>
            </div>
          </Transition>
        </div>
      </div>

      <!-- RIGHT: Selector de Periodo + Dynamic Actions Dropdown + User Avatar -->
      <div class="flex items-center gap-2.5 z-10 relative">

        <!-- SELECTOR DE PERIODO (Solo para CLIENTE_RH) -->
        <div v-if="!isAdminSaas" ref="periodContainerRef" class="relative">
          <button
            type="button"
            @click="togglePeriod"
            title="Filtrar periodo del dashboard"
            class="h-10 px-3.5 rounded-2xl border text-xs font-bold flex items-center gap-2.5 transition-all cursor-pointer shadow-xs hover:shadow-sm"
            :class="isPeriodOpen
              ? 'bg-charcoal-100 border-charcoal-300 text-charcoal-900 shadow-inner'
              : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200 hover:border-charcoal-300'">
            <div class="w-5 h-5 rounded-lg bg-charcoal-100 flex items-center justify-center text-charcoal-700">
              <i class="ph ph-calendar-blank text-xs"></i>
            </div>
            <span class="tracking-tight whitespace-nowrap">{{ activePeriodLabel }}</span>
            <i class="ph ph-caret-down text-[10px] text-charcoal-400 transition-transform duration-200" :class="{ 'rotate-180': isPeriodOpen }"></i>
          </button>

          <div
            v-if="isPeriodOpen"
            class="absolute right-0 top-12 mt-2 w-60 bg-white rounded-2xl shadow-xl border border-charcoal-200 p-1.5 z-50 animate-in fade-in zoom-in-95 duration-150">
            <div class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-charcoal-400">
              Periodo de Consulta
            </div>
            <div class="space-y-0.5">
              <button
                v-for="opt in PERIOD_OPTIONS"
                :key="opt.id"
                type="button"
                @click="selectPeriod(opt.id)"
                class="w-full px-3 py-2 rounded-xl text-left flex items-center justify-between transition-all cursor-pointer"
                :class="period === opt.id ? 'bg-[#18181B] text-white' : 'hover:bg-charcoal-50 text-charcoal-800'">
                <div>
                  <p class="text-xs font-bold leading-tight">{{ opt.label }}</p>
                  <p class="text-[10px] mt-0.5" :class="period === opt.id ? 'text-charcoal-300' : 'text-charcoal-400'">{{ opt.subtitle }}</p>
                </div>
                <i v-if="period === opt.id" class="ph ph-check text-xs text-emerald-400"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- DYNAMIC MODULE ACTIONS DROPDOWN -->
        <div v-if="!isAdminSaas && currentModule.actions && currentModule.actions.length" ref="actionsContainerRef" class="relative">
          <button
            type="button"
            @click="toggleActions"
            class="h-10 px-4 rounded-2xl border text-xs font-bold flex items-center gap-2.5 transition-all cursor-pointer shadow-xs hover:shadow-sm"
            :class="isActionsOpen 
              ? 'bg-charcoal-100 border-charcoal-300 text-charcoal-900 shadow-inner' 
              : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200 hover:border-charcoal-300'">
            <div class="w-5 h-5 rounded-lg bg-charcoal-100 flex items-center justify-center text-charcoal-700">
              <i class="ph ph-sliders-horizontal text-xs"></i>
            </div>
            <span class="tracking-tight">Acciones</span>
            <i class="ph ph-caret-down text-[10px] text-charcoal-400 transition-transform duration-200" :class="{ 'rotate-180': isActionsOpen }"></i>
          </button>

          <div
            v-if="isActionsOpen"
            class="absolute right-0 top-12 mt-2 w-72 bg-white rounded-2xl shadow-xl border border-charcoal-200 p-1.5 z-50 animate-in fade-in zoom-in-95 duration-150">
            
            <div class="space-y-1">
              <button
                v-for="act in currentModule.actions"
                :key="act.id"
                type="button"
                @click="triggerAction(act.type)"
                class="w-full px-3 py-2.5 rounded-xl text-left hover:bg-charcoal-50 flex items-center gap-3 transition-all cursor-pointer group border border-transparent hover:border-charcoal-200/70">
                <div class="w-8 h-8 rounded-lg bg-charcoal-100 group-hover:bg-[#18181B] group-hover:text-white text-charcoal-800 flex items-center justify-center shrink-0 transition-colors shadow-2xs">
                  <i :class="['ph', act.icon, 'text-base']"></i>
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-xs font-bold text-charcoal-900 group-hover:text-black leading-tight truncate tracking-tight">{{ act.label }}</p>
                  <p v-if="act.subtitle" class="text-[11px] text-charcoal-400 truncate mt-0.5 font-medium">{{ act.subtitle }}</p>
                </div>
                <i class="ph ph-arrow-right text-xs text-charcoal-300 group-hover:text-charcoal-900 group-hover:translate-x-0.5 transition-all shrink-0"></i>
              </button>
            </div>

          </div>
        </div>

        <div ref="menuContainerRef" class="relative">
          <button 
            type="button" 
            @click="toggleMenu"
            title="Perfil y configuración de usuario"
            class="w-10 h-10 rounded-full bg-[#18181B] hover:bg-black text-white flex items-center justify-center font-bold text-xs shadow-xs hover:shadow-md transition-all cursor-pointer border border-charcoal-300 ring-2 ring-transparent hover:ring-charcoal-300">
            <span>{{ user.avatar || 'AF' }}</span>
          </button>

          <div 
            v-if="isMenuOpen"
            class="absolute right-0 top-12 mt-2 w-72 bg-white rounded-3xl shadow-xl border border-charcoal-200 p-2 z-50 animate-in fade-in zoom-in-95 duration-150">
            
            <div class="px-3.5 py-3 border-b border-charcoal-100 flex items-center gap-3">
              <div class="w-11 h-11 rounded-2xl bg-[#18181B] text-white flex items-center justify-center text-sm font-bold shrink-0">
                {{ user.avatar || 'AF' }}
              </div>
              <div class="overflow-hidden">
                <p class="text-sm font-bold text-charcoal-900 truncate tracking-tight">{{ user.name }}</p>
                <p class="text-[11px] text-charcoal-400 truncate font-medium">{{ user.role }}</p>
                <div class="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 w-fit">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span>{{ isAdminSaas ? 'ADMIN SUSCRIPCIONES' : branchName }}</span>
                </div>
              </div>
            </div>

            <div v-if="!isAdminSaas" class="py-1 text-xs text-charcoal-700 space-y-0.5">
              <div class="px-3.5 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-charcoal-400">
                Empresas y Ajustes
              </div>

              <button 
                type="button" 
                @click="isMenuOpen = false; $emit('open-companies', 'invitar')"
                class="w-full px-3 py-2 rounded-2xl text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
                <div class="w-8 h-8 rounded-xl bg-charcoal-100 group-hover:bg-[#18181B] group-hover:text-white text-charcoal-700 flex items-center justify-center shrink-0 transition-colors">
                  <i class="ph ph-key text-sm"></i>
                </div>
                <div>
                  <p class="font-bold text-xs text-charcoal-900 leading-tight">Clave Dinámica (5 min)</p>
                  <p class="text-[10px] text-charcoal-400">Invitar RH o unirse a otra empresa</p>
                </div>
              </button>

              <button 
                type="button" 
                @click="isMenuOpen = false; $emit('navigate', 'configuracion')"
                class="w-full px-3 py-2 rounded-2xl text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
                <div class="w-8 h-8 rounded-xl bg-charcoal-100 group-hover:bg-[#18181B] group-hover:text-white text-charcoal-700 flex items-center justify-center shrink-0 transition-colors">
                  <i class="ph ph-gear text-sm"></i>
                </div>
                <div>
                  <p class="font-bold text-xs text-charcoal-900 leading-tight">Configuración del Sistema</p>
                  <p class="text-[10px] text-charcoal-400">Parámetros anti-rebote y correo</p>
                </div>
              </button>

              <button 
                type="button" 
                @click="openConfig('perfil')"
                class="w-full px-3 py-2 rounded-2xl text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
                <div class="w-8 h-8 rounded-xl bg-charcoal-100 group-hover:bg-[#18181B] group-hover:text-white text-charcoal-700 flex items-center justify-center shrink-0 transition-colors">
                  <i class="ph ph-user-gear text-sm"></i>
                </div>
                <div>
                  <p class="font-bold text-xs text-charcoal-900 leading-tight">Mi Perfil y Suscripción</p>
                  <p class="text-[10px] text-charcoal-400">Vigencia y datos del operador</p>
                </div>
              </button>
            </div>

            <div class="pt-1.5 border-t border-charcoal-100 px-1">
              <a 
                href="/logout" 
                class="w-full px-3 py-2 rounded-2xl text-left text-red-600 hover:bg-red-50 flex items-center gap-2.5 text-xs font-bold transition-colors">
                <i class="ph ph-sign-out text-base text-red-600"></i>
                <span>Cerrar Sesión</span>
              </a>
            </div>
          </div>
        </div>
      </div>

    </header>
  `
};
