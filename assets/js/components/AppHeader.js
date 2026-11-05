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
    selectedBranchId: { type: [Number, String, null], default: null }
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
    let titleObserver = null;

    function measureCompactWidth() {
      const el = titleMeasureRef.value;
      if (!el) return;
      const titleW = Math.ceil(el.getBoundingClientRect().width);
      compactWidth.value = Math.min(Math.max(titleW + 106, 210), expandedWidth);
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
        title: 'Pre-Nómina y Reportes',
        badge: 'Cálculo y Exportación',
        desc: 'Consolidado de asistencia para pre-nómina, depuración automática de rebotes, conteo de incidencias y exportación directa a Excel / CSV.',
        tags: ['100% Conciliado', 'Exportar CSV', 'Auditoría']
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

    function handleIslandClick() {
      if (!isIslandExpanded.value) {
        isIslandExpanded.value = true;
      }
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
        class="dynamic-island absolute left-1/2 -translate-x-1/2 top-3 z-50 select-none bg-[#09090B] text-white"
        :class="{ 'is-expanded': isIslandExpanded, 'is-compact': !isIslandExpanded }"
        :style="{ width: (isIslandExpanded ? expandedWidth : compactWidth) + 'px' }"
        :title="!isIslandExpanded ? 'Ver información del módulo' : ''">

        <span ref="titleMeasureRef" aria-hidden="true" class="absolute invisible pointer-events-none whitespace-nowrap text-sm font-bold tracking-tight" style="left:-9999px; top:0;">{{ title }}</span>

        <div class="island-row h-10 grid items-center px-3" style="grid-template-columns: 28px 1fr 28px; column-gap: 10px;">
          <div class="w-7 h-7 rounded-full bg-white/10 text-emerald-400 flex items-center justify-center text-xs relative">
            <i :class="['ph', moduleIcon || 'ph-fingerprint']"></i>
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 absolute -top-0.5 -right-0.5 animate-pulse"></span>
          </div>

          <h1 class="text-sm font-bold text-white tracking-tight whitespace-nowrap text-center truncate">{{ title }}</h1>

          <div class="relative w-7 h-7">
            <i 
              class="ph ph-info absolute inset-0 flex items-center justify-center text-sm text-charcoal-400 transition-opacity duration-200"
              :class="isIslandExpanded ? 'opacity-0' : 'opacity-100'"></i>
            <button 
              type="button"
              @click.stop="closeIsland"
              title="Cerrar (Esc)"
              :tabindex="isIslandExpanded ? 0 : -1"
              class="absolute inset-0 rounded-full bg-white/10 hover:bg-white/20 text-charcoal-300 hover:text-white flex items-center justify-center text-xs transition-all duration-200 cursor-pointer"
              :class="isIslandExpanded ? 'opacity-100' : 'opacity-0 pointer-events-none'">
              <i class="ph ph-x"></i>
            </button>
          </div>
        </div>

        <div class="island-body" :class="{ 'is-expanded': isIslandExpanded }">
          <div class="island-body-clip">
            <div class="island-body-content" :style="{ width: expandedWidth + 'px' }">
              <!-- INICIO: selector de sucursal -->
              <div v-if="activeModule === 'inicio'" class="mx-5 pt-3 pb-5 border-t border-white/10">
                <span class="block text-center text-[10px] mono-code text-emerald-400 font-semibold uppercase tracking-wider">Cambiar de sucursal</span>
                <div class="mt-3 space-y-1.5">
                  <button
                    v-for="b in branches"
                    :key="b.id"
                    type="button"
                    @click.stop="pickBranch(b)"
                    class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer"
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
              </div>

              <div v-else class="mx-5 pt-3 pb-5 border-t border-white/10 text-center">
                <span class="inline-block text-[10px] mono-code text-emerald-400 font-semibold uppercase tracking-wider">{{ currentModuleInfo.badge }}</span>
                <p class="text-xs text-charcoal-300 leading-relaxed mt-2">
                  {{ currentModuleInfo.desc }}
                </p>
                <div class="flex items-center justify-center gap-1.5 mt-3.5 text-[10px] mono-code flex-wrap">
                  <span 
                    v-for="tag in currentModuleInfo.tags" 
                    :key="tag"
                    class="px-2 py-0.5 rounded-md bg-white/10 text-charcoal-300 border border-white/5 font-medium">
                    {{ tag }}
                  </span>
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
              Ajustes del Sistema
            </div>

            <button 
              type="button" 
              @click="openConfig('perfil')"
              class="w-full px-4 py-2.5 text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
              <i class="ph ph-user-gear text-base text-charcoal-400 group-hover:text-charcoal-700"></i>
              <div>
                <p class="font-semibold text-charcoal-900 leading-tight">Mi Perfil y Permisos</p>
                <p class="text-[10px] text-charcoal-400">Administrador de terminales e ISAPI</p>
              </div>
            </button>

            <button 
              type="button" 
              @click="openConfig('terminal')"
              class="w-full px-4 py-2.5 text-left hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
              <i class="ph ph-fingerprint text-base text-charcoal-400 group-hover:text-charcoal-700"></i>
              <div>
                <p class="font-semibold text-charcoal-900 leading-tight">Parámetros Anti-Rebote</p>
                <p class="text-[10px] text-charcoal-400">Ventana debounce de 180 segundos</p>
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
