// Component: BranchSelector
// Selector de Terminal Biométrica / Sede Activa para ACCESS COGA

import { ref, computed, onMounted, onUnmounted } from 'vue';

export default {
  name: 'BranchSelector',
  props: {
    modelValue: { type: String, default: 'cerro-gordo' },
    devices: { type: Array, default: () => [] }
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    const isOpen = ref(false);
    const dropdownRef = ref(null);

    const nodes = computed(() => {
      const base = [
        {
          id: 'cerro-gordo',
          name: 'Cerro Gordo',
          code: 'HIK-01',
          type: 'Terminal Wi-Fi Activa',
          subtitle: '192.168.11.71 • DS-K1T320MFWX-B',
          desc: 'Reloj Biométrico Principal • Red Wi-Fi TBS (Online)'
        },
        {
          id: 'cedis-leon',
          name: 'CEDIS Matriz',
          code: 'HIK-02',
          type: 'Almacén Central',
          subtitle: 'Nodo Central • Pre-Nómina',
          desc: 'Consolidación de Asistencia y Kardex de Personal'
        }
      ];
      return base;
    });

    const activeBranch = computed(() => {
      return nodes.value.find(b => b.id === props.modelValue) || nodes.value[0];
    });

    function toggleDropdown(e) {
      if (e) e.stopPropagation();
      isOpen.value = !isOpen.value;
    }

    function selectBranch(id) {
      isOpen.value = false;
      emit('update:modelValue', id);
      emit('change', id);
    }

    function handleClickOutside(e) {
      if (dropdownRef.value && !dropdownRef.value.contains(e.target)) {
        isOpen.value = false;
      }
    }

    onMounted(() => window.addEventListener('click', handleClickOutside));
    onUnmounted(() => window.removeEventListener('click', handleClickOutside));

    return {
      isOpen,
      dropdownRef,
      nodes,
      activeBranch,
      toggleDropdown,
      selectBranch
    };
  },
  template: `
    <div ref="dropdownRef" class="bg-offwhite border border-charcoal-200 hover:border-charcoal-300 rounded-2xl p-3.5 sm:p-4 shrink-0 min-w-[330px] shadow-2xs transition-all relative">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400 flex items-center gap-1.5">
          <i class="ph ph-fingerprint text-xs text-charcoal-600"></i>
          Terminal / Sede Activa
        </span>
        <span class="text-[10px] font-bold mono-code px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 shadow-2xs flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          {{ activeBranch.type }}
        </span>
      </div>

      <button 
        type="button" 
        @click="toggleDropdown"
        class="w-full text-left flex items-center justify-between py-0.5 border-b-2 border-charcoal-300 hover:border-charcoal-900 transition-colors focus:outline-none group cursor-pointer mt-0.5">
        <span class="text-xl sm:text-2xl font-bold text-charcoal-900 tracking-tight group-hover:text-charcoal-700 transition-colors truncate">
          {{ activeBranch.name }}
        </span>
        <i class="ph ph-caret-down text-lg text-charcoal-500 group-hover:text-charcoal-900 transition-transform duration-200 shrink-0 ml-2"
           :class="{ 'rotate-180': isOpen }"></i>
      </button>

      <div 
        v-if="isOpen"
        class="absolute top-full left-0 right-0 mt-2 bg-white border border-charcoal-200 rounded-2xl shadow-xl p-2 z-50 animate-in fade-in zoom-in-95 duration-150">
        
        <div class="px-3 py-2 text-[10px] font-bold text-charcoal-400 uppercase tracking-wider border-b border-charcoal-100 mb-1 flex items-center justify-between">
          <span>Seleccionar Terminal / Nodo</span>
          <span class="mono-code text-charcoal-400">ISAPI Red</span>
        </div>

        <div class="space-y-1">
          <button 
            v-for="b in nodes"
            :key="b.id"
            type="button" 
            @click="selectBranch(b.id)" 
            class="w-full text-left p-2.5 rounded-xl hover:bg-charcoal-50 transition-colors flex items-center justify-between group cursor-pointer"
            :class="{ 'bg-charcoal-50': b.id === modelValue }">
            <div>
              <div class="font-bold text-charcoal-900 text-sm flex items-center gap-2">
                <span>{{ b.name }}</span>
                <span class="text-[10px] mono-code px-2 py-0.5 rounded bg-charcoal-100 text-charcoal-700 font-semibold">{{ b.code }}</span>
              </div>
              <p class="text-[11px] text-charcoal-500 mt-0.5">{{ b.desc }}</p>
            </div>
            <i v-if="b.id === modelValue" class="ph ph-check text-base text-charcoal-900"></i>
          </button>
        </div>
      </div>

      <div class="mt-2 pt-1.5 border-t border-charcoal-200/80 flex items-center justify-between text-[11px] text-charcoal-500">
        <span class="font-medium text-charcoal-600 mono-code">{{ activeBranch.subtitle }}</span>
        <span class="text-[10px] mono-code text-charcoal-400 flex items-center gap-1 cursor-pointer" @click="toggleDropdown">
          <i class="ph ph-arrows-clockwise text-xs"></i> Cambiar
        </span>
      </div>
    </div>
  `
};
