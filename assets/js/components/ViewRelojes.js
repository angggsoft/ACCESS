// Component: ViewRelojes
// Gestión de Relojes Checadores Biométricos Hikvision — Protocolo Unidireccional One-Way Push (Reloj ➔ Servidor)

import { ref } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewRelojes',
  components: { ModalBase },
  props: {
    devices: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: 1 },
    sucursalId: { type: [Number, String, null], default: 1 },
    isSyncing: { type: Boolean, default: false }
  },
  emits: ['refresh', 'toast'],
  setup(props, { emit }) {
    const isAddModalOpen = ref(false);
    const isGuideModalOpen = ref(false);
    const guideDevice = ref(null);
    const busyDeviceId = ref(null);

    const newClock = ref({
      nombre: '',
      modelo: 'DS-K1T320MFWX-B',
      serie: '',
      ip: 'DHCP / Sucursal',
      puerto: 80,
      area_asignada: 'Operaciones Generales',
      ubicacion: 'Acceso Principal',
      red_tipo: 'Cloud Push (HTTP Listening)'
    });

    function openAddModal() {
      newClock.value = {
        nombre: '',
        modelo: 'DS-K1T320MFWX-B',
        serie: '',
        ip: 'DHCP / Sucursal',
        puerto: 80,
        area_asignada: props.areas[0]?.nombre || 'General',
        ubicacion: 'Acceso Principal',
        red_tipo: 'Cloud Push (HTTP Listening)'
      };
      isAddModalOpen.value = true;
    }

    function openSetupGuide(dev) {
      guideDevice.value = dev;
      isGuideModalOpen.value = true;
    }

    async function copyWebhookUrl(url) {
      try {
        await navigator.clipboard.writeText(url);
        emit('toast', 'URL de Webhook Push copiada al portapapeles');
      } catch (e) {
        emit('toast', url);
      }
    }

    async function saveNewClock() {
      if (!newClock.value.nombre) {
        emit('toast', 'El nombre del reloj checador es obligatorio', 'error');
        return;
      }
      try {
        const res = await fetch('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...newClock.value,
            empresa_id: props.empresaId,
            sucursal_id: props.sucursalId
          })
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Reloj '${newClock.value.nombre}' registrado con token Push único.`);
          isAddModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al registrar reloj', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar reloj', 'error');
      }
    }

    return {
      isAddModalOpen,
      isGuideModalOpen,
      guideDevice,
      busyDeviceId,
      newClock,
      openAddModal,
      openSetupGuide,
      copyWebhookUrl,
      saveNewClock
    };
  },
  template: `
    <div class="w-full flex-1 flex flex-col space-y-6 animate-in fade-in duration-150">

      <!-- BANNER ARQUITECTURA ONE-WAY PUSH -->
      <div class="bg-white rounded-3xl p-4 px-6 border border-charcoal-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center justify-center text-lg shrink-0">
            <i class="ph ph-cloud-arrow-up"></i>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold text-charcoal-900">Comunicación Unidireccional Segura (Reloj ➔ Servidor)</span>
              <span class="text-[10px] mono-code font-bold px-2 py-0.5 rounded-full bg-charcoal-100 text-charcoal-800">ONE-WAY PUSH</span>
            </div>
            <p class="text-[11px] text-charcoal-500">
              Cada reloj cuenta con un <b>Token de Webhook único</b>. El alta biométrica se realiza localmente en el reloj físico y la terminal sube las checadas automáticamente a este servidor sin necesidad de abrir puertos en la sucursal.
            </p>
          </div>
        </div>

        <button
          type="button"
          @click="openAddModal"
          class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 shrink-0 cursor-pointer">
          <i class="ph ph-plus-circle text-sm"></i>
          <span>Agregar Reloj</span>
        </button>
      </div>

      <!-- ESTADO VACÍO: SIN RELOJES REGISTRADOS -->
      <div v-if="!devices.length" class="flex-1 bg-white rounded-3xl p-10 border border-charcoal-200 shadow-sm text-center flex flex-col items-center justify-center min-h-[320px]">
        <i class="ph ph-fingerprint text-5xl text-charcoal-300 mb-3"></i>
        <h3 class="text-base font-bold text-charcoal-900">No hay relojes checadores en esta sucursal</h3>
        <p class="text-xs text-charcoal-500 mt-1.5 max-w-md leading-relaxed">
          Registra tu primer reloj Hikvision para generar su <b>URL de Webhook Push única</b> y comenzar a recibir las checadas de tus colaboradores en tiempo real.
        </p>
        <button
          type="button"
          @click="openAddModal"
          class="mt-5 px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 cursor-pointer transition-all shadow-xs">
          <i class="ph ph-plus-circle text-base"></i>
          <span>Dar de Alta Primer Reloj</span>
        </button>
      </div>

      <!-- DEVICES GRID -->
      <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div
          v-for="dev in devices"
          :key="dev.id"
          class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm flex flex-col justify-between">
          
          <div>
            <!-- Top Row -->
            <div class="flex items-start justify-between gap-4 mb-5">
              <div class="flex items-center gap-3.5">
                <div class="w-12 h-12 rounded-3xl bg-[#18181B] text-white flex items-center justify-center text-2xl shrink-0">
                  <i class="ph ph-fingerprint"></i>
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <h3 class="text-lg font-bold text-charcoal-900">{{ dev.nombre }}</h3>
                    <span class="text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full border flex items-center gap-1"
                      :class="dev.estado === 'ONLINE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'">
                      <span class="w-1.5 h-1.5 rounded-full" :class="dev.estado === 'ONLINE' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'"></span>
                      {{ dev.estado }}
                    </span>
                  </div>
                  <p class="text-xs text-charcoal-500">{{ dev.area_asignada }} • {{ dev.ubicacion }}</p>
                </div>
              </div>

              <span class="text-[11px] mono-code font-bold px-3 py-1 rounded-xl bg-charcoal-100 text-charcoal-800 border border-charcoal-200">
                Token: {{ dev.webhook_token }}
              </span>
            </div>

            <!-- URL DE WEBHOOK PUSH ÚNICA DEL RELOJ -->
            <div class="mb-4 p-3 rounded-2xl bg-charcoal-900 text-white flex items-center justify-between gap-2">
              <div class="min-w-0 flex-1">
                <span class="text-[9px] mono-code uppercase tracking-wider text-emerald-400 font-bold block">
                  Endpoint Receptor Push (Configurar en HTTP Listening del Reloj)
                </span>
                <p class="text-xs mono-code text-white truncate mt-0.5">{{ dev.webhook_url }}</p>
              </div>
              <button
                type="button"
                @click="copyWebhookUrl(dev.webhook_url)"
                class="px-3 py-1.5 rounded-xl bg-white/15 hover:bg-white/25 text-white text-[11px] font-bold shrink-0 cursor-pointer flex items-center gap-1">
                <i class="ph ph-copy"></i> Copiar
              </button>
            </div>

            <!-- Hardware Specs Grid -->
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 rounded-3xl bg-offwhite border border-charcoal-200/80 text-xs">
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Modelo</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ dev.modelo }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Protocolo</span>
                <span class="font-bold text-emerald-700 flex items-center gap-1">
                  <i class="ph ph-cloud-arrow-up"></i> One-Way Push
                </span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Eventos Recibidos</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ dev.total_eventos }} checadas</span>
              </div>
              <div class="col-span-2">
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">No. Serie / Identificador</span>
                <span class="font-semibold text-charcoal-700 mono-code text-[11px]">{{ dev.serial }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Último Evento Push</span>
                <span class="font-medium text-charcoal-600 mono-code text-[11px]">{{ dev.ultima_sincronizacion || 'Reciente' }}</span>
              </div>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="pt-5 mt-5 border-t border-charcoal-100 flex flex-wrap items-center gap-2">
            <button
              type="button"
              @click="openSetupGuide(dev)"
              class="px-3.5 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer">
              <i class="ph ph-book-open-text"></i>
              <span>Guía de Enlace en Reloj</span>
            </button>
          </div>

        </div>
      </div>

      <!-- MODAL: REGISTRAR NUEVO RELOJ EN SUCURSAL -->
      <ModalBase
        v-if="isAddModalOpen"
        title="Registrar Reloj Checador en Sucursal (One-Way Push)"
        confirmLabel="Generar Token y Guardar"
        size="md"
        @close="isAddModalOpen = false"
        @confirm="saveNewClock">
        
        <div class="space-y-4 text-xs">
          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Nombre Identificador del Reloj</label>
            <input v-model="newClock.nombre" type="text" placeholder="Ej: Reloj Entrada Planta Norte"
              class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 focus:outline-none focus:ring-2 focus:ring-charcoal-900">
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Modelo Hikvision</label>
              <input v-model="newClock.modelo" type="text" placeholder="DS-K1T320MFWX-B"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Número de Serie (Opcional)</label>
              <input v-model="newClock.serie" type="text" placeholder="Ej: DS-K1T320..."
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Área Principal Asignada</label>
              <select v-model="newClock.area_asignada" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white">
                <option v-for="a in areas" :key="a.id" :value="a.nombre">{{ a.nombre }}</option>
                <option value="General">General</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Ubicación en la Sucursal</label>
              <input v-model="newClock.ubicacion" type="text" placeholder="Ej: Caseta de Vigilancia"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>
        </div>
      </ModalBase>

      <!-- MODAL: GUÍA DE CONFIGURACIÓN LOCAL EN RELOJ HIKVISION -->
      <ModalBase
        v-if="isGuideModalOpen && guideDevice"
        :title="'Configurar Reloj Físico — ' + guideDevice.nombre"
        confirmLabel="Entendido"
        size="md"
        @close="isGuideModalOpen = false"
        @confirm="isGuideModalOpen = false">
        <div class="space-y-3 text-xs">
          <p class="text-charcoal-600">
            Dado que la comunicación es <b>unidireccional (Reloj ➔ Servidor)</b>, ingresa desde la red local de la sucursal a la interfaz web del reloj Hikvision (<b>Red ➔ Avanzado ➔ Escucha HTTP / HTTP Listening</b>) y coloca estos parámetros:
          </p>
          <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-2 mono-code">
            <div><span class="text-charcoal-400">Destino IP / Dominio:</span> <b class="text-charcoal-900">Tu dominio Railway (ej. access.com) o IP local</b></div>
            <div><span class="text-charcoal-400">URL (Ruta Push):</span> <b class="text-emerald-700">{{ guideDevice.webhook_path }}</b></div>
            <div><span class="text-charcoal-400">Puerto:</span> <b class="text-charcoal-900">443 (HTTPS en Railway) o 8000 (Local)</b></div>
          </div>
          <p class="text-[11px] text-charcoal-500">
            Cuando des de alta un empleado directamente en el reloj físico y realice su primera checada, aparecerá automáticamente en la pestaña de <b>Empleados y Biometría</b> de esta sucursal.
          </p>
        </div>
      </ModalBase>

    </div>
  `
};
