// Component: ModalConfig
// Configuración de Perfil y Parámetros del Servidor Biométrico

import { ref, watch } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ModalConfig',
  components: { ModalBase },
  props: {
    isOpen: { type: Boolean, default: false },
    initialTab: { type: String, default: 'perfil' },
    user: {
      type: Object,
      default: () => ({
        name: 'Angel Flores',
        role: 'Ingeniero de Sistemas y Hardware',
        email: 'angel.flores@quodo.mx',
        shift: 'Mixto (08:00 - 17:30)',
        node: 'Cerro Gordo • Terminal #01'
      })
    }
  },
  emits: ['close', 'logout'],
  setup(props, { emit }) {
    const currentTab = ref('perfil');
    const tabs = [
      { id: 'perfil', label: 'Perfil' },
      { id: 'terminal', label: 'Biometría e ISAPI' }
    ];

    watch(() => props.initialTab, (v) => { if (v) currentTab.value = v; }, { immediate: true });

    return { currentTab, tabs };
  },
  template: `
    <ModalBase
      v-if="isOpen"
      title="Configuración del Sistema"
      size="md"
      confirmLabel="Aceptar"
      @close="$emit('close')"
      @confirm="$emit('close')">

      <div class="flex items-center gap-2 pb-1 border-b border-charcoal-100">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          @click="currentTab = t.id"
          class="px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer"
          :class="currentTab === t.id ? 'bg-[#18181B] text-white shadow-2xs' : 'text-charcoal-600 hover:bg-charcoal-100'">
          {{ t.label }}
        </button>
      </div>

      <div v-if="currentTab === 'perfil'" class="space-y-4 pt-1">
        <div class="flex items-center gap-3.5">
          <div class="w-12 h-12 rounded-full bg-[#18181B] text-white flex items-center justify-center text-base font-bold shrink-0">
            {{ user.avatar || 'AF' }}
          </div>
          <div>
            <div class="text-sm font-bold text-charcoal-900">{{ user.name }}</div>
            <div class="text-xs text-charcoal-500">{{ user.role }} · {{ user.node }}</div>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-charcoal-50 border border-charcoal-200 text-xs space-y-1">
          <div class="text-charcoal-500">Turno Activo: <b class="text-charcoal-900">{{ user.shift }}</b></div>
          <div class="text-charcoal-500">Correo: <b class="text-charcoal-900 font-mono">{{ user.email }}</b></div>
        </div>
      </div>

      <div v-else class="space-y-3 pt-1 text-xs">
        <div class="p-3.5 rounded-2xl border border-charcoal-200 space-y-1">
          <div class="font-bold text-charcoal-900">Filtro Anti-Rebote (Debounce)</div>
          <div class="text-charcoal-500">Ventana activa: <b class="mono-code text-charcoal-900">180 segundos</b> entre checadas del mismo colaborador.</div>
        </div>
        <div class="p-3.5 rounded-2xl border border-charcoal-200 space-y-1">
          <div class="font-bold text-charcoal-900">Sincronización Híbrida</div>
          <div class="text-charcoal-500">Webhook Push en <code class="mono-code">/api/v1/webhooks/hikvision</code> + Auto-Pull ISAPI cada 4 segundos.</div>
        </div>
      </div>

    </ModalBase>
  `
};
