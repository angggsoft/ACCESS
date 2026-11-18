// Component: ViewRelojes
// Gestión de Relojes Checadores Biométricos Hikvision — Protocolo Unidireccional One-Way Push (Reloj ➔ Servidor)

import { ref, computed } from 'vue';
import ModalBase from './ModalBase.js';
import { confirmDialog } from './ModalConfirm.js';

export default {
  name: 'ViewRelojes',
  components: { ModalBase },
  props: {
    devices: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: 1 },
    sucursalId: { type: [Number, String, null], default: 1 },
    subscription: { type: Object, default: () => ({}) },
    isSyncing: { type: Boolean, default: false }
  },
  emits: ['refresh', 'toast'],
  setup(props, { emit }) {
    const isAddModalOpen = ref(false);
    const isGuideModalOpen = ref(false);
    const guideDevice = ref(null);
    const busyDeviceId = ref(null);

    const maxRelojes = computed(() => props.subscription?.max_relojes ?? 1);
    const relojesUsados = computed(() => props.subscription?.relojes_usados ?? props.devices.length);
    const canAddClock = computed(() => relojesUsados.value < maxRelojes.value);

    const newClock = ref({
      id: null,
      marca: 'HIKVISION',
      nombre: '',
      modelo: 'DS-K1T320MFWX-B',
      serie: '',
      ip: 'DHCP / Sucursal',
      puerto: 80,
      area_asignada: 'Operaciones Generales',
      ubicacion: 'Acceso Principal',
      red_tipo: 'Cloud Push (HTTP Listening)'
    });

    function setBrand(marca) {
      newClock.value.marca = marca;
      if (marca === 'ZKTECO') {
        if (!newClock.value.id || newClock.value.modelo === 'DS-K1T320MFWX-B') {
          newClock.value.modelo = 'SpeedFace-V5L / MB360';
        }
        newClock.value.red_tipo = 'ADMS Cloud Push (/iclock)';
      } else {
        if (!newClock.value.id || newClock.value.modelo === 'SpeedFace-V5L / MB360') {
          newClock.value.modelo = 'DS-K1T320MFWX-B';
        }
        newClock.value.red_tipo = 'Cloud Push (HTTP Listening)';
      }
    }

    function openAddModal() {
      if (!canAddClock.value) {
        emit('toast', `Capacidad alcanzada (${relojesUsados.value}/${maxRelojes.value} relojes contratados). Amplía tu suscripción o libera un reloj.`, 'error');
        return;
      }
      newClock.value = {
        id: null,
        marca: 'HIKVISION',
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

    function openEditModal(dev) {
      newClock.value = {
        id: dev.id,
        marca: (dev.marca || 'HIKVISION').toUpperCase(),
        nombre: dev.nombre || '',
        modelo: dev.modelo || 'DS-K1T320MFWX-B',
        serie: dev.serie || dev.serial || '',
        ip: dev.ip || 'DHCP / Sucursal',
        puerto: dev.puerto || 80,
        area_asignada: dev.area_asignada || props.areas[0]?.nombre || 'General',
        ubicacion: dev.ubicacion || 'Acceso Principal',
        red_tipo: dev.red_tipo || 'Cloud Push (HTTP Listening)'
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
      if (newClock.value.marca === 'ZKTECO' && !(newClock.value.serie || '').trim()) {
        emit('toast', 'Para relojes ZKTeco ADMS el Número de Serie (SN) es obligatorio', 'error');
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
          emit('toast', newClock.value.id
            ? `Reloj '${newClock.value.nombre}' actualizado.`
            : `Reloj '${newClock.value.nombre}' (${newClock.value.marca}) registrado.`);
          isAddModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al registrar reloj', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar reloj', 'error');
      }
    }

    async function deleteClock(dev) {
      if (!dev) return;
      const ok = await confirmDialog({
        title: `¿Eliminar reloj '${dev.nombre}'?`,
        message: 'Se desvinculará este reloj y se liberará 1 licencia de reloj de tu suscripción.',
        detail: `Token: ${dev.webhook_token || 'N/A'}`,
        variant: 'danger',
        confirmLabel: 'Eliminar Reloj'
      });
      if (!ok) return;

      busyDeviceId.value = dev.id;
      try {
        const res = await fetch(`/api/devices/${dev.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Reloj '${dev.nombre}' eliminado. Licencia liberada.`);
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al eliminar el reloj', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al eliminar reloj', 'error');
      } finally {
        busyDeviceId.value = null;
      }
    }

    return {
      isAddModalOpen,
      isGuideModalOpen,
      guideDevice,
      busyDeviceId,
      maxRelojes,
      relojesUsados,
      canAddClock,
      newClock,
      setBrand,
      openAddModal,
      openEditModal,
      openSetupGuide,
      copyWebhookUrl,
      saveNewClock,
      deleteClock
    };
  },
  template: `
    <div class="w-full flex-1 flex flex-col space-y-6 animate-in fade-in duration-150">

      <!-- BANNER ARQUITECTURA ONE-WAY PUSH -->
      <div class="bg-white rounded-3xl p-4 px-6 border border-charcoal-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-cloud-arrow-up text-lg text-charcoal-400"></i></span>
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs font-bold text-charcoal-900">Comunicación Unidireccional Segura (Reloj ➔ Servidor)</span>
              <span class="text-[11px] mono-code" :class="canAddClock ? 'text-charcoal-400' : 'text-charcoal-900 font-bold'">
                Cupo: {{ relojesUsados }} / {{ maxRelojes }} relojes
              </span>
            </div>
            <p class="text-[11px] text-charcoal-500">
              Cada reloj cuenta con un <b>Token de Webhook único</b>. El alta biométrica se realiza localmente en el reloj físico y la terminal sube las checadas automáticamente a este servidor sin necesidad de abrir puertos en la sucursal.
            </p>
          </div>
        </div>

        <button
          type="button"
          :disabled="!canAddClock"
          @click="openAddModal"
          class="px-4 py-2 rounded-full text-xs font-bold flex items-center gap-1.5 shrink-0 transition-all"
          :class="canAddClock
            ? 'bg-[#18181B] hover:bg-black text-white cursor-pointer'
            : 'bg-charcoal-100 text-charcoal-500 border border-charcoal-200 cursor-not-allowed'">
          <i :class="['ph text-sm', canAddClock ? 'ph-plus-circle' : 'ph-lock-key']"></i>
          <span>{{ canAddClock ? 'Agregar Reloj' : ('Límite Alcanzado (' + relojesUsados + '/' + maxRelojes + ' Relojes)') }}</span>
        </button>
      </div>

      <!-- ESTADO VACÍO: SIN RELOJES REGISTRADOS -->
      <div v-if="!devices.length" class="flex-1 bg-white rounded-3xl p-10 border border-charcoal-200 shadow-sm text-center flex flex-col items-center justify-center min-h-[320px]">
        <i class="ph ph-fingerprint text-5xl text-charcoal-300 mb-3"></i>
        <h3 class="text-sm font-semibold text-charcoal-900">No hay relojes checadores en esta sucursal</h3>
        <p class="text-xs text-charcoal-500 mt-1.5 max-w-md leading-relaxed">
          {{ canAddClock
            ? 'Registra tu primer reloj Hikvision para comenzar a recibir las checadas de tus colaboradores en tiempo real.'
            : 'Has alcanzado el cupo máximo de relojes contratados en tu plan (' + relojesUsados + '/' + maxRelojes + '). Contacta al administrador para ampliar tu capacidad.' }}
        </p>
        <button
          type="button"
          :disabled="!canAddClock"
          @click="openAddModal"
          class="mt-5 px-5 py-2.5 rounded-full text-xs font-bold flex items-center gap-2 transition-all shadow-xs"
          :class="canAddClock
            ? 'bg-[#18181B] hover:bg-black text-white cursor-pointer'
            : 'bg-charcoal-100 text-charcoal-500 border border-charcoal-200 cursor-not-allowed'">
          <i :class="['ph text-base', canAddClock ? 'ph-plus-circle' : 'ph-lock-key']"></i>
          <span>{{ canAddClock ? 'Dar de Alta Primer Reloj' : ('Límite Alcanzado (' + relojesUsados + '/' + maxRelojes + ' Relojes)') }}</span>
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
                <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-fingerprint text-lg text-charcoal-400"></i></span>
                <div>
                  <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-sm font-semibold text-charcoal-900">{{ dev.nombre }}</h3>
                    <span class="text-[10px] mono-code font-semibold uppercase tracking-wider text-charcoal-400">{{ dev.marca || 'HIKVISION' }}</span>
                    <span class="text-[11px] font-medium flex items-center gap-1.5" :class="dev.estado === 'ONLINE' ? 'text-charcoal-700' : 'text-charcoal-400'">
                      <span class="w-1.5 h-1.5 rounded-full" :class="dev.estado === 'ONLINE' ? 'bg-emerald-500' : 'bg-charcoal-300'"></span>
                      {{ dev.estado === 'ONLINE' ? 'En línea' : 'Sin conexión' }}
                    </span>
                  </div>
                  <p class="text-xs text-charcoal-500">{{ dev.area_asignada }} • {{ dev.ubicacion }}</p>
                </div>
              </div>

              <span class="text-[11px] mono-code text-charcoal-400 break-all text-right max-w-[45%]">
                {{ (dev.marca || 'HIKVISION') === 'ZKTECO' ? ('SN: ' + dev.serial) : ('Token: ' + dev.webhook_token) }}
              </span>
            </div>

            <!-- Hardware Specs Grid -->
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4 rounded-3xl bg-offwhite border border-charcoal-200/80 text-xs">
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Modelo</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ dev.modelo }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Protocolo</span>
                <span class="font-bold text-charcoal-900 flex items-center gap-1">
                  <i class="ph ph-cloud-arrow-up"></i>
                  {{ (dev.marca || 'HIKVISION') === 'ZKTECO' ? 'ADMS /iclock' : 'ISAPI Push' }}
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
          <div class="pt-5 mt-5 border-t border-charcoal-100 flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                @click="openSetupGuide(dev)"
                class="px-3.5 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer">
                <i class="ph ph-book-open-text"></i>
                <span>Guía de Enlace</span>
              </button>
              <button
                type="button"
                @click="openEditModal(dev)"
                class="px-3.5 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer">
                <i class="ph ph-pencil-simple"></i>
                <span>Editar</span>
              </button>
            </div>

            <button
              type="button"
              :disabled="busyDeviceId === dev.id"
              @click="deleteClock(dev)"
              class="px-3.5 py-2 rounded-full text-charcoal-500 hover:text-rose-700 hover:bg-rose-50 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-trash"></i>
              <span>Eliminar Reloj</span>
            </button>
          </div>

        </div>
      </div>

      <!-- MODAL: REGISTRAR / EDITAR RELOJ EN SUCURSAL -->
      <ModalBase
        v-if="isAddModalOpen"
        :title="newClock.id ? ('Editar Reloj Checador — ' + newClock.nombre) : 'Registrar Reloj Checador en Sucursal (Push)'"
        :confirmLabel="newClock.id ? 'Guardar Cambios' : 'Guardar Reloj'"
        size="md"
        @close="isAddModalOpen = false"
        @confirm="saveNewClock">
        
        <div class="space-y-4 text-xs">
          <!-- Selector de Marca -->
          <div>
            <label class="block font-bold text-charcoal-800 mb-1.5">Marca y Protocolo del Reloj</label>
            <div class="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                @click="setBrand('HIKVISION')"
                class="p-3 rounded-2xl border text-left transition-all cursor-pointer"
                :class="newClock.marca === 'HIKVISION' ? 'bg-[#18181B] text-white border-[#18181B]' : 'bg-offwhite text-charcoal-800 border-charcoal-200 hover:bg-white'">
                <div class="font-bold text-xs">Hikvision</div>
                <div class="text-[10px]" :class="newClock.marca === 'HIKVISION' ? 'text-charcoal-300' : 'text-charcoal-500'">ISAPI HTTP Listening</div>
              </button>
              <button
                type="button"
                @click="setBrand('ZKTECO')"
                class="p-3 rounded-2xl border text-left transition-all cursor-pointer"
                :class="newClock.marca === 'ZKTECO' ? 'bg-[#18181B] text-white border-[#18181B]' : 'bg-offwhite text-charcoal-800 border-charcoal-200 hover:bg-white'">
                <div class="font-bold text-xs">ZKTeco</div>
                <div class="text-[10px]" :class="newClock.marca === 'ZKTECO' ? 'text-charcoal-300' : 'text-charcoal-500'">Protocolo ADMS (/iclock)</div>
              </button>
            </div>
          </div>

          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Nombre Identificador del Reloj</label>
            <input v-model="newClock.nombre" type="text" placeholder="Ej: Reloj Entrada Planta Norte"
              class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 focus:outline-none focus:ring-2 focus:ring-charcoal-900">
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Modelo del Equipo</label>
              <input v-model="newClock.modelo" type="text" :placeholder="newClock.marca === 'ZKTECO' ? 'SpeedFace-V5L / MB360' : 'DS-K1T320MFWX-B'"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">
                Número de Serie (SN)
                <span v-if="newClock.marca === 'ZKTECO'" class="text-rose-600">* Obligatorio</span>
                <span v-else class="text-charcoal-400 font-normal">(Opcional)</span>
              </label>
              <input v-model="newClock.serie" type="text" :placeholder="newClock.marca === 'ZKTECO' ? 'Ej: BJ4D221260045' : 'Ej: DS-K1T320...'"
                class="w-full px-3.5 py-2.5 rounded-xl border mono-code"
                :class="newClock.marca === 'ZKTECO' ? 'border-charcoal-900 font-bold' : 'border-charcoal-200'">
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

      <!-- MODAL: GUÍA DE CONFIGURACIÓN LOCAL EN RELOJ -->
      <ModalBase
        v-if="isGuideModalOpen && guideDevice"
        :title="'Configurar Reloj ' + (guideDevice.marca || 'HIKVISION') + ' — ' + guideDevice.nombre"
        confirmLabel="Entendido"
        size="md"
        @close="isGuideModalOpen = false"
        @confirm="isGuideModalOpen = false">
        <div v-if="(guideDevice.marca || 'HIKVISION') === 'ZKTECO'" class="space-y-3 text-xs">
          <p class="text-charcoal-600">
            En el menú del reloj físico ZKTeco entra a <b>Red / Comm ➔ Ajuste de Servidor en la Nube (Cloud Server / ADMS Setting)</b> y configura estos parámetros:
          </p>
          <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-2 mono-code">
            <div><span class="text-charcoal-400">Modo de Servidor:</span> <b class="text-charcoal-900">ADMS / Push SDK</b></div>
            <div><span class="text-charcoal-400">Dirección IP / Dominio:</span> <b class="text-charcoal-900">Tu dominio Railway o IP del servidor</b></div>
            <div><span class="text-charcoal-400">Puerto del Servidor:</span> <b class="text-charcoal-900">443 (HTTPS) u 8080 (Local)</b></div>
            <div><span class="text-charcoal-400">Ruta ADMS automática:</span> <b class="text-indigo-700">/iclock/cdata</b></div>
            <div><span class="text-charcoal-400">Número de Serie (SN):</span> <b class="text-emerald-700">{{ guideDevice.serial }}</b></div>
          </div>
          <p class="text-[11px] text-charcoal-500">
            El reloj ZKTeco enviará automáticamente sus registros a <code>/iclock/cdata?SN={{ guideDevice.serial }}</code> y los empleados nuevos se registrarán en su primera checada.
          </p>
        </div>

        <div v-else class="space-y-3 text-xs">
          <p class="text-charcoal-600">
            Dado que la comunicación es <b>unidireccional (Reloj ➔ Servidor)</b>, ingresa desde la red local de la sucursal a la interfaz web del reloj Hikvision (<b>Red ➔ Avanzado ➔ Escucha HTTP / HTTP Listening</b>) y coloca estos parámetros:
          </p>
          <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-2 mono-code">
            <div><span class="text-charcoal-400">Destino IP / Dominio:</span> <b class="text-charcoal-900">Tu dominio Railway (ej. access.com) o IP local</b></div>
            <div><span class="text-charcoal-400">URL (Ruta Push):</span> <b class="text-emerald-700">{{ guideDevice.webhook_path }}</b></div>
            <div><span class="text-charcoal-400">Puerto:</span> <b class="text-charcoal-900">443 (HTTPS en Railway) u 8080 (Local)</b></div>
          </div>
          <p class="text-[11px] text-charcoal-500">
            Cuando des de alta un empleado directamente en el reloj físico y realice su primera checada, aparecerá automáticamente en la pestaña de <b>Empleados y Biometría</b> de esta sucursal.
          </p>
        </div>
      </ModalBase>

    </div>
  `
};
