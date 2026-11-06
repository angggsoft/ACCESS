// Component: AppHeader
// Desktop top bar with sidebar toggle, downward Dynamic Island module description, live webhook indicator, and user profile popover

import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';

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
        role: 'Ingeniero de Sistemas y Hardware',
        avatar: 'AF'
      })
    },
    branchName: {
      type: String,
      default: 'Cerro Gordo (192.168.11.71)'
    },
    liveCount: {
      type: Number,
      default: 0
    },
    branches: { type: Array, default: () => [] },
    selectedBranchId: { type: [Number, String, null], default: null },
    activity: { type: Object, default: null },
    isSyncing: { type: Boolean, default: false },
    branchIp: { type: String, default: '' }
  },
  emits: ['toggle-sidebar', 'open-config', 'navigate', 'select-branch'],
  setup(props, { emit }) {
    const isMenuOpen = ref(false);
    const menuContainerRef = ref(null);

    const isIslandExpanded = ref(false);
    const islandContainerRef = ref(null);
    const titleMeasureRef = ref(null);
    const expandedWidth = 490;
    const compactWidth = ref(260);
    const activityWidth = 400;
    let titleObserver = null;

    function measureCompactWidth() {
      const el = titleMeasureRef.value;
      if (!el) return;
      const titleW = Math.ceil(el.getBoundingClientRect().width);
      compactWidth.value = Math.min(Math.max(titleW + 64, 150), expandedWidth);
    }

    const moduleDescriptions = {
      'inicio': {
        title: 'Inicio',
        badge: 'Hub Biométrico ISAPI',
        desc: 'Panel ejecutivo de asistencia, estado en tiempo real de relojes checadores Hikvision, áreas operativas y resumen de pre-nómina.',
        tags: ['Hikvision MinMoe', 'Webhook Push + Pull', 'SQLite Local']
      },
      'monitor': {
        title: 'Monitor de Checadas en Vivo',
        badge: 'Tiempo Real • Auto-Sync',
        desc: 'Bitácora de checadas con actualización automática en pantalla. Filtra eventos biométricos (Huella, Rostro, PIN, Tarjeta) y aplica debounce anti-rebote de 180s.',
        tags: ['Push HTTP 8000', 'Debounce 180s', 'Reconciliación ISAPI']
      },
      'relojes': {
        title: 'Relojes Checadores',
        badge: 'Hardware ISAPI',
        desc: 'Gestión y diagnóstico de terminales biométricas Hikvision DS-K1T320MFWX-B. Calibración de hora, configuración de webhooks y extracción de memoria.',
        tags: ['192.168.11.71', 'Wi-Fi TBS', 'Digest Auth']
      },
      'empleados': {
        title: 'Plantilla de Empleados',
        badge: 'Directorio y Biometría',
        desc: 'Administración de colaboradores sincronizada bidireccionalmente con la memoria de los relojes checadores (PIN, Huella, Rostro FDLib y permisos Admin UI).',
        tags: ['Alta Remota ISAPI', 'Enrolamiento Facial', 'PIN Teclado']
      },
      'areas': {
        title: 'Áreas y Turnos',
        badge: 'Estructura Organizacional',
        desc: 'Definición de departamentos, horarios laborales, ventanas de tolerancia de entrada y asignación de terminales biométricas por zona.',
        tags: ['Departamentos', 'Horarios', 'Tolerancia']
      },
      'reportes': {
        title: 'Reportes',
        badge: 'Cálculo y Exportación',
        desc: 'Consolidado de asistencia para pre-nómina, depuración automática de rebotes, conteo de incidencias y exportación directa a Excel / CSV.',
        tags: ['100% Conciliado', 'Exportar CSV', 'Auditoría']
      },
      'configuracion': {
        title: 'Configuración del Sistema',
        badge: 'Centro de Control y Parámetros',
        desc: 'Ajuste del filtro anti-rebote (debounce), calibración de hora, diagnóstico de hardware ISAPI, servidor local y perfil del operador.',
        tags: ['Anti-Rebote Dinámico', 'Hikvision ISAPI', 'SQLite access.db']
      }
    };

    const currentModuleInfo = computed(() => {
      return moduleDescriptions[props.activeModule] || moduleDescriptions['inicio'];
    });

    function toggleMenu(e) {
      if (e) e.stopPropagation();
      isIslandExpanded.value = false;
      isMenuOpen.value = !isMenuOpen.value;
    }

    // Actividad en vivo: evento de checada recibido o sincronizacion en curso
    const liveActivity = computed(() => {
      if (isIslandExpanded.value) return null;
      if (props.activity) return props.activity;
      if (props.isSyncing) {
        return { id: 'sync', type: 'sync', title: 'Sincronizando reloj', subtitle: props.branchIp || 'ISAPI', badge: 'ISAPI', initials: '' };
      }
      return null;
    });

    function handleIslandClick() {
      if (!isIslandExpanded.value) {
        isIslandExpanded.value = true;
      }
    }

    const shortcuts = [
      { id: 'monitor', label: 'Monitor', icon: 'ph-broadcast' },
      { id: 'relojes', label: 'Relojes', icon: 'ph-fingerprint' },
      { id: 'empleados', label: 'Empleados', icon: 'ph-users-three' },
      { id: 'reportes', label: 'Reportes', icon: 'ph-chart-bar' }
    ];

    function goTo(id) {
      isIslandExpanded.value = false;
      emit('navigate', id);
    }

    function closeIsland() {
      isIslandExpanded.value = false;
    }

    function pickBranch(b) {
      emit('select-branch', b.id);
      isIslandExpanded.value = false;
    }

    function openConfig(section) {
      isMenuOpen.value = false;
      emit('open-config', section);
    }

    function handleClickOutside(e) {
      if (menuContainerRef.value && !menuContainerRef.value.contains(e.target)) {
        isMenuOpen.value = false;
      }
      if (islandContainerRef.value && !islandContainerRef.value.contains(e.target)) {
        isIslandExpanded.value = false;
      }
    }

    function handleKeydown(e) {
      if (e.key === 'Escape') {
        isIslandExpanded.value = false;
        isMenuOpen.value = false;
      }
    }

    onMounted(() => {
      window.addEventListener('click', handleClickOutside);
      window.addEventListener('keydown', handleKeydown);
      measureCompactWidth();
      if (typeof ResizeObserver !== 'undefined' && titleMeasureRef.value) {
        titleObserver = new ResizeObserver(measureCompactWidth);
        titleObserver.observe(titleMeasureRef.value);
      }
    });

    watch(() => props.title, () => nextTick(measureCompactWidth));

    onUnmounted(() => {
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('keydown', handleKeydown);
      if (titleObserver) titleObserver.disconnect();
    });

    return {
      props,
      isMenuOpen,
      menuContainerRef,
      toggleMenu,
      isIslandExpanded,
      islandContainerRef,
      titleMeasureRef,
      expandedWidth,
      compactWidth,
      handleIslandClick,
      liveActivity,
      activityWidth,
      shortcuts,
      goTo,
      closeIsland,
      currentModuleInfo,
      pickBranch,
      openConfig
    };
  },
  template: `
    <header class="h-16 shrink-0 bg-white border-b border-charcoal-200 pr-6 flex items-center justify-between relative z-50 shadow-[0_1px_3px_rgba(0,0,0,0.02)] w-full">
      
      <!-- LEFT: Sidebar toggle + COGA Logo -->
      <div class="flex items-center z-10">
        <div class="w-16 h-16 flex items-center justify-center shrink-0">
          <button 
            type="button" 
            @click="$emit('toggle-sidebar')" 
            title="Ocultar / Desplegar menú lateral"
            class="w-10 h-10 rounded-xl text-charcoal-500 hover:text-charcoal-900 hover:bg-charcoal-100 flex items-center justify-center transition-colors cursor-pointer border border-transparent hover:border-charcoal-200">
            <i class="ph ph-sidebar-simple text-xl"></i>
          </button>
        </div>

        <a href="#/inicio" @click.prevent="$emit('navigate', 'inicio')" class="flex items-center gap-2.5 pl-2 cursor-pointer">
          <img src="/assets/quodo_label.png" alt="quodo" class="h-7 w-auto object-contain">
        </a>
      </div>

      <!-- CENTER: DYNAMIC ISLAND -->
      <div 
        ref="islandContainerRef"
        @click="handleIslandClick"
        class="dynamic-island absolute left-1/2 -translate-x-1/2 top-3 z-50 select-none text-white"
        :class="{ 'is-expanded': isIslandExpanded, 'is-compact': !isIslandExpanded && !liveActivity, 'is-activity': !!liveActivity }"
        :style="{ width: (isIslandExpanded ? expandedWidth : (liveActivity ? activityWidth : compactWidth)) + 'px' }">

        <span ref="titleMeasureRef" aria-hidden="true" class="absolute invisible pointer-events-none whitespace-nowrap text-sm font-bold tracking-tight" style="left:-9999px; top:0;">{{ title }}</span>

        <div class="island-row relative grid items-center px-3" :class="{ 'is-activity': !!liveActivity }" style="grid-template-columns: 1fr;">

          <Transition name="island-swap">
            <!-- Estado: ACTIVIDAD EN VIVO -->
            <div v-if="liveActivity" :key="'act-' + liveActivity.id" class="absolute inset-0 flex items-center gap-3 px-3">
              <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                :class="liveActivity.type === 'rebote' ? 'bg-amber-400/20 text-amber-300' : (liveActivity.type === 'sync' ? 'bg-sky-400/20 text-sky-300' : 'bg-emerald-400/20 text-emerald-300')">
                <i v-if="liveActivity.type === 'sync'" class="ph ph-arrows-clockwise animate-spin text-base"></i>
                <span v-else>{{ liveActivity.initials }}</span>
              </div>
              <div class="min-w-0 flex-1 text-left leading-tight">
                <p class="text-[13px] font-bold text-white truncate">{{ liveActivity.title }}</p>
                <p class="text-[10px] mono-code text-charcoal-300 truncate">{{ liveActivity.subtitle }}</p>
              </div>
              <span class="text-[9px] mono-code font-bold px-2 py-1 rounded-full shrink-0"
                :class="liveActivity.type === 'rebote' ? 'bg-amber-400/15 text-amber-300' : (liveActivity.type === 'sync' ? 'bg-sky-400/15 text-sky-300' : 'bg-emerald-400/15 text-emerald-300')">
                {{ liveActivity.badge }}
              </span>
            </div>

            <!-- Estado: TITULO (compacto / expandido) -->
            <div v-else key="title" class="absolute inset-0 flex items-center justify-center px-8">
              <h1 class="text-sm font-bold text-white tracking-tight whitespace-nowrap truncate">{{ title }}</h1>
            </div>
          </Transition>

          <!-- Boton cerrar (solo expandido) -->
          <button 
            type="button"
            @click.stop="closeIsland"
            title="Cerrar (Esc)"
            :tabindex="isIslandExpanded ? 0 : -1"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 text-charcoal-300 hover:text-white flex items-center justify-center text-xs transition-all duration-300 cursor-pointer"
            :class="isIslandExpanded ? 'opacity-100 scale-100' : 'opacity-0 scale-50 pointer-events-none'">
            <i class="ph ph-x"></i>
          </button>
        </div>

        <!-- Barra de progreso de la actividad -->
        <div v-if="liveActivity && liveActivity.type !== 'sync'" :key="'bar-' + liveActivity.id" class="island-progress" :class="{ 'is-bounce': liveActivity.type === 'rebote' }"><span></span></div>

        <div class="island-body" :class="{ 'is-expanded': isIslandExpanded }">
          <div class="island-body-clip">
            <div class="island-body-content" :style="{ width: expandedWidth + 'px' }">
              <div class="island-stagger mx-5 pt-3 pb-5 border-t border-white/10">

                <!-- INICIO: selector de sucursal -->
                <template v-if="activeModule === 'inicio'">
                  <span class="block text-center text-[10px] mono-code text-emerald-400 font-semibold uppercase tracking-wider">Cambiar de sucursal</span>
                  <div class="mt-3 space-y-1.5">
                    <button
                      v-for="b in branches"
                      :key="b.id"
                      type="button"
                      @click.stop="pickBranch(b)"
                      class="w-full flex items-center gap-3 px-3 py-2 rounded-2xl text-left transition-all duration-200 cursor-pointer active:scale-[0.98]"
                      :class="b.id === selectedBranchId ? 'bg-white/15' : 'bg-white/5 hover:bg-white/10'">
                      <span class="w-2 h-2 rounded-full shrink-0" :class="b.estado === 'ONLINE' ? 'bg-emerald-400' : 'bg-red-400'"></span>
                      <span class="flex-1 min-w-0">
                        <span class="block text-sm font-semibold text-white truncate">{{ b.nombre }}</span>
                        <span class="block text-[10px] mono-code text-charcoal-300">{{ b.ip }} · {{ b.ubicacion }}</span>
                      </span>
                      <i v-if="b.id === selectedBranchId" class="ph ph-check text-emerald-400"></i>
                    </button>
                    <p v-if="!branches.length" class="text-xs text-charcoal-300 text-center py-2">No hay sucursales registradas.</p>
                  </div>
                </template>

                <!-- Otros modulos: descripcion -->
                <template v-else>
                  <div class="text-center">
                    <span class="inline-block text-[10px] mono-code text-emerald-400 font-semibold uppercase tracking-wider">{{ currentModuleInfo.badge }}</span>
                  </div>
                  <p class="text-xs text-charcoal-300 leading-relaxed mt-2 text-center">{{ currentModuleInfo.desc }}</p>
                </template>

                <!-- Estado en vivo -->
                <div class="mt-4 grid grid-cols-2 gap-2">
                  <div class="rounded-2xl bg-white/5 px-3 py-2">
                    <p class="text-[9px] mono-code uppercase tracking-wider text-charcoal-400">Checadas</p>
                    <p class="text-base font-bold mono-code text-white leading-tight">{{ liveCount }}</p>
                  </div>
                  <div class="rounded-2xl bg-white/5 px-3 py-2">
                    <p class="text-[9px] mono-code uppercase tracking-wider text-charcoal-400">Reloj activo</p>
                    <p class="text-xs font-bold text-white leading-tight truncate mt-1">{{ branchName }}</p>
                  </div>
                </div>

                <!-- Atajos -->
                <div class="mt-3 flex items-center justify-center gap-1.5">
                  <button
                    v-for="sc in shortcuts"
                    :key="sc.id"
                    type="button"
                    @click.stop="goTo(sc.id)"
                    :disabled="activeModule === sc.id"
                    class="flex-1 flex flex-col items-center gap-1 py-2 rounded-2xl bg-white/5 hover:bg-white/12 text-charcoal-300 hover:text-white text-[10px] font-semibold transition-all duration-200 cursor-pointer active:scale-95 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-white/5">
                    <i :class="['ph', sc.icon, 'text-base']"></i>
                    <span>{{ sc.label }}</span>
                  </button>
                </div>

              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Live Badge + User Avatar & Popover -->
      <div ref="menuContainerRef" class="flex items-center gap-3 z-10 relative">
        <button
          type="button"
          @click="$emit('navigate', 'monitor')"
          class="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 text-xs font-semibold transition-colors cursor-pointer"
          title="Ir al Monitor de Checadas en Vivo">
          <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
          <span>En Vivo: <b class="mono-code">{{ liveCount }}</b> checadas</span>
        </button>

        <button 
          type="button" 
          @click="toggleMenu"
          title="Perfil y configuración de usuario"
          class="w-10 h-10 rounded-full bg-[#18181B] hover:bg-black text-white flex items-center justify-center font-bold text-xs shadow-xs hover:shadow-md transition-all cursor-pointer border border-charcoal-300 ring-2 ring-transparent hover:ring-charcoal-300">
          <span>{{ user.avatar || 'AF' }}</span>
        </button>

        <!-- Dropdown Popover -->
        <div 
          v-if="isMenuOpen"
          class="absolute right-0 top-12 mt-2 w-72 bg-white rounded-2xl shadow-xl border border-charcoal-200 py-3 z-50 animate-in fade-in zoom-in-95 duration-150">
          
          <div class="px-4 pb-3 border-b border-charcoal-100 flex items-center gap-3">
            <div class="w-11 h-11 rounded-full bg-[#18181B] text-white flex items-center justify-center text-sm font-bold shrink-0">
              {{ user.avatar || 'AF' }}
            </div>
            <div class="overflow-hidden">
              <p class="text-sm font-bold text-charcoal-900 truncate">{{ user.name }}</p>
              <p class="text-xs text-charcoal-500 truncate">{{ user.role }}</p>
              <div class="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 w-fit">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>{{ branchName }}</span>
              </div>
            </div>
          </div>

          <div class="py-2 text-xs text-charcoal-700">
            <div class="px-4 py-1 text-[10px] font-bold uppercase tracking-wider text-charcoal-400">
              Ajustes y Guías
            </div>

            <!-- ENLACE AL CENTRO DE CONFIGURACIÓN -->
            <button 
              type="button" 
              @click="isMenuOpen = false; $emit('navigate', 'configuracion')"
              class="w-full px-4 py-2.5 text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
              <i class="ph ph-gear text-base"></i>
              <div>
                <p class="font-semibold text-charcoal-900 leading-tight">Configuración del Sistema</p>
                <p class="text-[10px] text-charcoal-400">Parámetros anti-rebote, ISAPI y red</p>
              </div>
            </button>

            <button 
              type="button" 
              @click="openConfig('perfil')"
              class="w-full px-4 py-2.5 text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
              <i class="ph ph-user-gear text-base"></i>
              <div>
                <p class="font-semibold text-charcoal-900 leading-tight">Mi Perfil y Permisos</p>
                <p class="text-[10px] text-charcoal-400">Datos del operador en sesión</p>
              </div>
            </button>
          </div>

          <div class="pt-2 border-t border-charcoal-100 px-2">
            <a 
              href="/login" 
              class="w-full px-3 py-2 rounded-xl text-left text-red-600 hover:bg-red-50 flex items-center gap-2.5 text-xs font-semibold transition-colors">
              <i class="ph ph-sign-out text-base text-red-600"></i>
              <span>Cerrar Sesión</span>
            </a>
          </div>
        </div>
      </div>

    </header>
  `
};
