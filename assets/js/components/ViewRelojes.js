// Component: ViewRelojes
// Gestión de Relojes Checadores Biométricos Hikvision (Protocolo ISAPI)

import { ref } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewRelojes',
  components: { ModalBase },
  props: {
    devices: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    isSyncing: { type: Boolean, default: false }
  },
  emits: ['refresh', 'toast'],
  setup(props, { emit }) {
    const isAddModalOpen = ref(false);
    const busyDeviceId = ref(null);
    const newClock = ref({
      nombre: '',
      ip: '192.168.11.',
      puerto: 80,
      usuario: 'admin',
      password: '',
      area_asignada: 'Operaciones Cerro Gordo',
      ubicacion: 'Acceso Secundario',
      red_tipo: 'Wi-Fi (TBS)'
    });

    function openAddModal() {
      isAddModalOpen.value = true;
    }

    async function saveNewClock() {
      if (!newClock.value.nombre || !newClock.value.ip) {
        emit('toast', 'Nombre e IP son obligatorios', 'error');
        return;
      }
      try {
        const res = await fetch('/api/devices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newClock.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Reloj '${newClock.value.nombre}' registrado (${data.estado}).`);
          isAddModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al registrar reloj', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar reloj', 'error');
      }
    }

    async function syncDevice(dev) {
      busyDeviceId.value = dev.id;
      try {
        emit('toast', `Consultando memoria ISAPI de ${dev.nombre} (${dev.ip})...`);
        const res = await fetch(`/api/devices/${dev.id}/sync`, { method: 'POST' });
        const data = await res.json();
        emit('toast', data.message || 'Sincronización completada');
        emit('refresh');
      } catch (e) {
        emit('toast', 'Error al sincronizar reloj', 'error');
      } finally {
        busyDeviceId.value = null;
      }
    }

    async function syncTime(dev) {
      busyDeviceId.value = dev.id;
      try {
        const res = await fetch(`/api/devices/${dev.id}/sync-time`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Hora calibrada correctamente');
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error calibrando hora', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de conexión con el reloj', 'error');
      } finally {
        busyDeviceId.value = null;
      }
    }

    async function setupWebhook(dev) {
      busyDeviceId.value = dev.id;
      try {
        const res = await fetch(`/api/devices/${dev.id}/setup-webhook`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Webhook configurado en el reloj');
        } else {
          emit('toast', data.detail || 'Error configurando webhook', 'error');
        }
      } catch (e) {
        emit('toast', 'Error al configurar webhook', 'error');
      } finally {
        busyDeviceId.value = null;
      }
    }

    return {
      isAddModalOpen,
      busyDeviceId,
      newClock,
      openAddModal,
      saveNewClock,
      syncDevice,
      syncTime,
      setupWebhook
    };
  },
  template: `
    <div class="w-full space-y-6 animate-in fade-in duration-150">

      <!-- HEADER -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 class="text-3xl font-bold text-charcoal-900 tracking-tight">Relojes</h2>
          <p class="text-xs text-sky-600 mt-0.5">Terminales biométricas Hikvision</p>
        </div>

        <button
          type="button"
          @click="openAddModal"
          class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-all cursor-pointer shrink-0">
          <i class="ph ph-plus-circle text-base"></i>
          <span>Agregar Reloj Checador</span>
        </button>
      </div>

      <!-- DEVICES GRID -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
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

              <span class="text-xs mono-code font-bold px-3 py-1 rounded-xl bg-charcoal-100 text-charcoal-800 border border-charcoal-200">
                {{ dev.ip }}:{{ dev.puerto }}
              </span>
            </div>

            <!-- Hardware Specs Grid -->
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 rounded-3xl bg-offwhite border border-charcoal-200/80 text-xs">
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Modelo</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ dev.modelo }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Firmware</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ dev.firmware }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Interfaz de Red</span>
                <span class="font-bold text-emerald-700 flex items-center gap-1">
                  <i class="ph ph-wifi-high"></i> {{ dev.red_tipo }}
                </span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Dirección MAC</span>
                <span class="font-semibold text-charcoal-700 mono-code">{{ dev.mac }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Eventos en Memoria</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ dev.total_eventos }} registros</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Última Sincronización</span>
                <span class="font-medium text-charcoal-600 mono-code text-[11px]">{{ dev.ultima_sincronizacion || 'Reciente' }}</span>
              </div>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="pt-5 mt-5 border-t border-charcoal-100 flex flex-wrap items-center gap-2">
            <button
              type="button"
              :disabled="busyDeviceId === dev.id"
              @click="syncDevice(dev)"
              class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-arrows-clockwise" :class="{ 'animate-spin': busyDeviceId === dev.id }"></i>
              <span>Sincronizar Eventos y Usuarios</span>
            </button>

            <button
              type="button"
              :disabled="busyDeviceId === dev.id"
              @click="syncTime(dev)"
              class="px-3.5 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer">
              <i class="ph ph-clock-clockwise"></i>
              <span>Calibrar Hora</span>
            </button>

            <button
              type="button"
              :disabled="busyDeviceId === dev.id"
              @click="setupWebhook(dev)"
              class="px-3.5 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer">
              <i class="ph ph-plugs-connected"></i>
              <span>Vincular Webhook</span>
            </button>
          </div>

        </div>
      </div>

      <!-- MODAL: ADD NEW CLOCK -->
      <ModalBase
        v-if="isAddModalOpen"
        title="Registrar Reloj Checador Hikvision"
        confirmLabel="Conectar y Guardar"
        size="md"
        @close="isAddModalOpen = false"
        @confirm="saveNewClock">
        
        <div class="space-y-4 text-xs">
          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Nombre Identificador del Reloj</label>
            <input v-model="newClock.nombre" type="text" placeholder="Ej: Acceso Almacén CEDIS"
              class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 focus:outline-none focus:ring-2 focus:ring-charcoal-900">
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div class="col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1">Dirección IP Local (ISAPI)</label>
              <input v-model="newClock.ip" type="text" placeholder="192.168.11.71"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Puerto HTTP</label>
              <input v-model="newClock.puerto" type="number"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Usuario Admin ISAPI</label>
              <input v-model="newClock.usuario" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Contraseña Admin</label>
              <input v-model="newClock.password" type="password" placeholder="Contraseña del reloj"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Área Asignada</label>
              <select v-model="newClock.area_asignada" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white">
                <option v-for="a in areas" :key="a.id" :value="a.nombre">{{ a.nombre }}</option>
                <option value="General">General</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Ubicación Física</label>
              <input v-model="newClock.ubicacion" type="text" placeholder="Ej: Entrada Principal"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
