// Component: AppHeader
// Desktop top bar with sidebar toggle, single-line Dynamic Island status pill, dynamic module Actions dropdown, live webhook indicator, and user profile popover

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
  emits: ['toggle-sidebar', 'open-config', 'navigate', 'select-branch', 'quick-action'],
  setup(props, { emit }) {
    const isMenuOpen = ref(false);
    const menuContainerRef = ref(null);

    const isActionsOpen = ref(false);
    const actionsContainerRef = ref(null);

    const measureRef = ref(null);
    const pillWidth = ref(180);
    let resizeObserver = null;

    const currentModule = computed(() => {
      return MODULES_NAV.find(m => m.id === props.activeModule) || MODULES_NAV[0];
    });

    // Actividad o proceso activo en la isla (sin estado expandido)
    const liveActivity = computed(() => {
      if (props.activity) return props.activity;
      if (props.isSyncing) {
        return {
          id: 'sync',
          type: 'sync',
          title: 'Sincronizando reloj…',
          method: '',
          badge: ''
        };
      }
      return null;
    });

    function measurePillWidth() {
      const el = measureRef.value;
      if (!el) return;
      const contentW = Math.ceil(el.getBoundingClientRect().width);
      pillWidth.value = Math.min(Math.max(contentW + 48, 140), 640);
    }

    function toggleMenu(e) {
      if (e) e.stopPropagation();
      isActionsOpen.value = false;
      isMenuOpen.value = !isMenuOpen.value;
    }

    function toggleActions(e) {
      if (e) e.stopPropagation();
      isMenuOpen.value = false;
      isActionsOpen.value = !isActionsOpen.value;
    }

    function triggerAction(actionType) {
      isActionsOpen.value = false;
      emit('quick-action', actionType);
    }

    function pickBranch(b) {
      isActionsOpen.value = false;
      emit('select-branch', b.id);
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
    }

    function handleKeydown(e) {
      if (e.key === 'Escape') {
        isMenuOpen.value = false;
        isActionsOpen.value = false;
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

    watch([() => props.title, liveActivity], () => {
      nextTick(measurePillWidth);
    });

    onUnmounted(() => {
      window.removeEventListener('click', handleClickOutside);
      window.removeEventListener('keydown', handleKeydown);
      if (resizeObserver) resizeObserver.disconnect();
    });

    return {
      props,
      isMenuOpen,
      menuContainerRef,
      toggleMenu,
      isActionsOpen,
      actionsContainerRef,
      toggleActions,
      triggerAction,
      pickBranch,
      currentModule,
      measureRef,
      pillWidth,
      liveActivity,
      openConfig
    };
  },
  template: `
    <header class="h-16 shrink-0 bg-white border-b border-charcoal-200 pr-6 flex items-center justify-between relative z-50 shadow-[0_1px_3px_rgba(0,0,0,0.02)] w-full">
      
      <!-- LEFT: Sidebar toggle + Logo -->
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

      <!-- CENTER: DYNAMIC ISLAND (Single-line status pill) -->
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-40">
        <!-- Medidor invisible de ancho exacto para cualquier estado -->
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
            <span class="w-2 h-2 shrink-0"></span>
            <span class="text-xs font-bold tracking-tight">{{ liveActivity.title }}</span>
            <span v-if="liveActivity.clock" class="text-[10px] mono-code px-2 py-0.5">{{ liveActivity.clock }}</span>
            <span v-if="liveActivity.method" class="text-[10px] mono-code">{{ liveActivity.method }}</span>
            <span v-if="liveActivity.badge" class="text-[9px] mono-code font-bold px-2 py-0.5">{{ liveActivity.badge }}</span>
          </template>
          <template v-else>
            <span class="text-sm font-bold tracking-tight">{{ title }}</span>
          </template>
        </span>

        <div
          class="dynamic-island relative flex items-center justify-center select-none text-white pointer-events-auto"
          :class="{ 'is-activity': !!liveActivity }"
          :style="{ width: pillWidth + 'px' }">

          <Transition name="island-swap">
            <!-- Estado: PROCESO (Sincronizando...) -->
            <div
              v-if="liveActivity && liveActivity.type === 'sync'"
              key="state-sync"
              class="flex items-center justify-center gap-2.5 px-5 whitespace-nowrap">
              <span class="w-3.5 h-3.5 rounded-full border-2 border-white/25 border-t-white animate-spin shrink-0"></span>
              <span class="text-xs font-semibold text-white tracking-tight truncate">{{ liveActivity.title }}</span>
            </div>

            <!-- Estado: EVENTO (Checada con reloj, crecimiento elástico y estado blanco) -->
            <div
              v-else-if="liveActivity"
              :key="'state-evt-' + liveActivity.id"
              class="flex items-center justify-center gap-2.5 px-5 whitespace-nowrap">
              <!-- Indicador de punto: blanco para válido, ámbar para rebote -->
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="liveActivity.type === 'rebote' ? 'bg-amber-400' : 'bg-white shadow-[0_0_6px_rgba(255,255,255,0.7)]'"></span>
              <!-- Nombre de la persona -->
              <span class="text-xs font-bold text-white tracking-tight truncate max-w-[200px]">{{ liveActivity.title }}</span>
              <!-- Reloj / terminal checador -->
              <span
                v-if="liveActivity.clock"
                class="text-[10px] mono-code text-white/85 bg-white/10 border border-white/15 px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1">
                <i class="ph ph-clock text-[11px] text-white/70"></i>
                <span>{{ liveActivity.clock }}</span>
              </span>
              <!-- Método de validación -->
              <span v-if="liveActivity.method" class="text-[10px] mono-code text-charcoal-400 shrink-0">· {{ liveActivity.method }}</span>
              <!-- Estado: BLANCO para válido (sin verde), ámbar para rebote -->
              <span
                v-if="liveActivity.badge"
                class="text-[9px] mono-code font-bold px-2 py-0.5 rounded-full shrink-0"
                :class="liveActivity.type === 'rebote' ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30' : 'bg-white text-charcoal-950'">
                {{ liveActivity.badge }}
              </span>
            </div>

            <!-- Estado: REPOSO (Solo texto) -->
            <div
              v-else
              :key="'state-idle-' + title"
              class="flex items-center justify-center px-5 whitespace-nowrap">
              <h1 class="text-sm font-bold text-white tracking-tight truncate">{{ title }}</h1>
            </div>
          </Transition>
        </div>
      </div>

      <!-- RIGHT: Dynamic Actions Dropdown + User Avatar & Popover -->
      <div class="flex items-center gap-2.5 z-10 relative">

        <!-- DYNAMIC MODULE ACTIONS DROPDOWN (Estilo Claro Inicio) -->
        <div v-if="currentModule.actions && currentModule.actions.length" ref="actionsContainerRef" class="relative">
          <button
            type="button"
            @click="toggleActions"
            class="h-9 px-3.5 rounded-xl border text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shadow-2xs"
            :class="isActionsOpen 
              ? 'bg-charcoal-100 border-charcoal-300 text-charcoal-900' 
              : 'bg-white hover:bg-charcoal-50 text-charcoal-800 border-charcoal-200'">
            <i class="ph ph-sliders-horizontal text-sm text-charcoal-600"></i>
            <span>Acciones</span>
            <i class="ph ph-caret-down text-[10px] text-charcoal-500 transition-transform duration-150" :class="{ 'rotate-180': isActionsOpen }"></i>
          </button>

          <div
            v-if="isActionsOpen"
            class="absolute right-0 top-11 mt-1.5 w-72 bg-white rounded-2xl shadow-xl border border-charcoal-200 py-2 z-50 animate-in fade-in zoom-in-95 duration-150">
            
            <div class="px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 border-b border-charcoal-100 flex items-center justify-between">
              <span>{{ currentModule.shortLabel }} · Acciones</span>
              <span class="text-[9px] mono-code bg-charcoal-100 text-charcoal-600 px-1.5 py-0.5 rounded font-semibold">Módulo</span>
            </div>

            <div class="p-1 space-y-0.5">
              <button
                v-for="act in currentModule.actions"
                :key="act.id"
                type="button"
                @click="triggerAction(act.type)"
                class="w-full px-3 py-2 rounded-xl text-left text-charcoal-800 hover:text-charcoal-900 hover:bg-charcoal-50 flex items-center gap-3 transition-colors cursor-pointer group">
                <div class="w-8 h-8 rounded-lg bg-charcoal-100 group-hover:bg-charcoal-200 text-charcoal-700 flex items-center justify-center shrink-0 transition-colors">
                  <i :class="['ph', act.icon, 'text-sm']" :class="{ 'animate-spin': isSyncing && act.type === 'sync-clock' }"></i>
                </div>
                <div class="min-w-0 flex-1">
                  <p class="text-xs font-bold leading-tight truncate text-charcoal-900">{{ act.label }}</p>
                  <p v-if="act.subtitle" class="text-[10px] text-charcoal-500 truncate mt-0.5">{{ act.subtitle }}</p>
                </div>
              </button>
            </div>

            <!-- Selector rápido de sucursal en Inicio -->
            <template v-if="activeModule === 'inicio' && branches && branches.length > 0">
              <div class="px-4 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 border-t border-charcoal-100 flex items-center justify-between">
                <span>Sucursal activa</span>
                <span class="text-[9px] mono-code text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold border border-emerald-200">Terminal</span>
              </div>
              <div class="p-1 space-y-0.5">
                <button
                  v-for="b in branches"
                  :key="b.id"
                  type="button"
                  @click="pickBranch(b)"
                  class="w-full px-3 py-2 rounded-xl text-left text-charcoal-800 hover:bg-charcoal-50 flex items-center gap-2.5 transition-colors cursor-pointer"
                  :class="{ 'bg-charcoal-50/80 font-bold': b.id === selectedBranchId }">
                  <span class="w-2 h-2 rounded-full shrink-0" :class="b.estado === 'ONLINE' ? 'bg-emerald-500' : 'bg-rose-500'"></span>
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-semibold leading-tight truncate text-charcoal-900">{{ b.nombre }}</p>
                    <p class="text-[10px] mono-code text-charcoal-400 truncate">{{ b.ip }}</p>
                  </div>
                  <i v-if="b.id === selectedBranchId" class="ph ph-check text-xs text-emerald-600 font-bold"></i>
                </button>
              </div>
            </template>

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
                Ajustes
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
      </div>

    </header>
  `
};
