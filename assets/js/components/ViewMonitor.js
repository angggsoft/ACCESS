// Component: ViewMonitor
// Monitor de Checadas en Tiempo Real con auto-refresco, filtros por método/estatus, registro de incidencias manuales y sincronización ISAPI

import { ref, computed } from 'vue';

export default {
  name: 'ViewMonitor',
  props: {
    records: { type: Array, default: () => [] },
    summary: { type: Object, default: () => ({}) },
    employees: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: null },
    sucursalId: { type: [Number, String, null], default: null },
    isSyncing: { type: Boolean, default: false },
    lastUpdated: { type: String, default: '' }
  },
  emits: ['sync-clock', 'export-csv', 'refresh', 'toast'],
  setup(props, { emit }) {
    const searchQuery = ref('');
    const statusFilter = ref('all'); // 'all' | 'valid' | 'bounce'
    const methodFilter = ref('all'); // 'all' | 'HUELLA' | 'ROSTRO' | 'PIN' | 'MANUAL'

    // Estado del modal de checada manual
    const showManualModal = ref(false);
    const isSavingManual = ref(false);
    const manualForm = ref({
      codigo_empleado: '',
      fecha_hora_evento: '',
      nota_incidencia: ''
    });

    const openManualModal = () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const localIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      
      const defaultEmp = props.employees && props.employees.length ? props.employees[0].codigo_empleado : '1';
      manualForm.value = {
        codigo_empleado: defaultEmp,
        fecha_hora_evento: localIso,
        nota_incidencia: 'Olvido de checada autorizado'
      };
      showManualModal.value = true;
    };

    const setQuickNote = (note) => {
      manualForm.value.nota_incidencia = note;
    };

    const submitManualCheckin = async () => {
      if (!manualForm.value.codigo_empleado || !manualForm.value.fecha_hora_evento) {
        emit('toast', { type: 'error', title: 'Campos requeridos', message: 'Seleccione colaborador y fecha/hora.' });
        return;
      }
      isSavingManual.value = true;
      try {
        const res = await fetch('/api/attendance/manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...manualForm.value,
            empresa_id: props.empresaId,
            sucursal_id: props.sucursalId
          })
        });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
          showManualModal.value = false;
          emit('toast', {
            type: 'success',
            title: 'Incidencia Registrada',
            message: `Checada manual registrada para colaborador #${manualForm.value.codigo_empleado}.`
          });
          emit('refresh');
        } else {
          emit('toast', {
            type: 'error',
            title: 'Error al registrar',
            message: data.detail || 'No se pudo guardar la checada manual.'
          });
        }
      } catch (err) {
        emit('toast', {
          type: 'error',
          title: 'Error de Red',
          message: 'No se pudo conectar con el servidor local.'
        });
      } finally {
        isSavingManual.value = false;
      }
    };

    const filteredRecords = computed(() => {
      return props.records.filter(r => {
        if (statusFilter.value === 'valid' && r.es_rebote) return false;
        if (statusFilter.value === 'bounce' && !r.es_rebote) return false;
        if (methodFilter.value !== 'all' && r.metodo !== methodFilter.value) return false;

        if (searchQuery.value.trim()) {
          const q = searchQuery.value.toLowerCase();
          const matchName = (r.nombre || '').toLowerCase().includes(q);
          const matchEmp = String(r.codigo_empleado || '').toLowerCase().includes(q);
          const matchArea = (r.area || '').toLowerCase().includes(q);
          const matchSerial = String(r.serial_no || '').includes(q);
          const matchNote = (r.nota_incidencia || '').toLowerCase().includes(q);
          return matchName || matchEmp || matchArea || matchSerial || matchNote;
        }
        return true;
      });
    });

    return {
      searchQuery,
      statusFilter,
      methodFilter,
      filteredRecords,
      showManualModal,
      isSavingManual,
      manualForm,
      openManualModal,
      setQuickNote,
      submitManualCheckin
    };
  },
  template: `
    <div class="w-full flex-1 flex flex-col space-y-5 animate-in fade-in duration-150">

      <!-- 3 KPIs -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-white rounded-3xl px-6 py-5 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ summary.total_checadas || 0 }}</span>
          <div><p class="text-sm font-bold text-charcoal-900">Eventos</p><p class="text-[11px] text-charcoal-400">totales en sistema</p></div>
          <i class="ph ph-list-checks text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
        <div class="bg-white rounded-3xl px-6 py-5 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ summary.checadas_validas || 0 }}</span>
          <div><p class="text-sm font-bold text-charcoal-900">Válidas</p><p class="text-[11px] text-charcoal-400">para pre-nómina</p></div>
          <i class="ph ph-check-circle text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
        <div class="bg-white rounded-3xl px-6 py-5 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ summary.rebotes_ignorados || 0 }}</span>
          <div><p class="text-sm font-bold text-charcoal-900">Rebotes</p><p class="text-[11px] text-charcoal-400">filtro anti-rebote (&lt;180s)</p></div>
          <i class="ph ph-arrows-clockwise text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
      </div>

      <!-- FILTER & ACTION BAR -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-sm flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <!-- Search -->
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400 text-base"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar por colaborador, # empleado, área o nota..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900 text-charcoal-900">
        </div>

        <!-- Filter Pills & Manual Button -->
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-1">
            <button
              v-for="st in [
                { id: 'all', label: 'Todos' },
                { id: 'valid', label: 'Válidos' },
                { id: 'bounce', label: 'Rebotes' }
              ]"
              :key="st.id"
              type="button"
              @click="statusFilter = st.id"
              class="px-2.5 py-1.5 text-xs transition-colors cursor-pointer"
              :class="statusFilter === st.id ? 'text-charcoal-900 font-bold' : 'text-charcoal-400 font-medium hover:text-charcoal-700'">
              {{ st.label }}
            </button>
          </div>

          <span class="text-charcoal-300 hidden sm:inline">|</span>

          <div class="flex items-center gap-1">
            <button
              v-for="mt in [
                { id: 'all', label: 'Todos' },
                { id: 'HUELLA', label: 'Huella' },
                { id: 'ROSTRO', label: 'Rostro' },
                { id: 'PIN', label: 'PIN' },
                { id: 'MANUAL', label: 'Manual' }
              ]"
              :key="mt.id"
              type="button"
              @click="methodFilter = mt.id"
              class="px-2 py-1.5 text-xs transition-colors cursor-pointer"
              :class="methodFilter === mt.id ? 'text-charcoal-900 font-bold' : 'text-charcoal-400 font-medium hover:text-charcoal-700'">
              {{ mt.label }}
            </button>
          </div>

          <!-- BOTÓN REGISTRAR CHECADA MANUAL -->
          <button
            type="button"
            @click="openManualModal"
            class="ml-auto px-4 py-1.5 bg-[#18181B] hover:bg-black text-white text-xs font-bold rounded-full shadow-sm flex items-center gap-1.5 transition-all cursor-pointer">
            <i class="ph ph-plus-circle text-sm"></i>
            <span>Checada Manual</span>
          </button>
        </div>
      </div>

      <!-- LIVE LOG TABLE / EMPTY STATE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden flex-1 flex flex-col">
        <div v-if="!filteredRecords.length" class="flex-1 flex flex-col items-center justify-center p-10 text-center min-h-[280px]">
          <i class="ph ph-fingerprint text-5xl text-charcoal-300 mb-3"></i>
          <p class="text-sm font-bold text-charcoal-800">No hay registros que coincidan con el filtro</p>
          <p class="text-xs text-charcoal-400 mt-1 max-w-sm">Coloca tu huella, rostro o PIN en el reloj Hikvision o registra una checada manual.</p>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3.5 px-5">ID / Serial</th>
                <th class="py-3.5 px-4">Colaborador</th>
                <th class="py-3.5 px-4">Área / Departamento</th>
                <th class="py-3.5 px-4">Método Biométrico</th>
                <th class="py-3.5 px-4">Reloj Checador</th>
                <th class="py-3.5 px-4">Fecha y Hora Exacta</th>
                <th class="py-3.5 px-5 text-right">Dictamen Pre-Nómina</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="rec in filteredRecords" :key="rec.id" class="hover:bg-charcoal-50/80 transition-colors new-row-flash">
                <td class="py-3.5 px-5 mono-code font-bold text-charcoal-600">
                  <span v-if="rec.serial_no">#{{ rec.serial_no }}</span>
                  <span v-else class="text-charcoal-900 font-bold">MANUAL</span>
                  <span class="block text-[10px] font-normal text-charcoal-400">Reg {{ rec.id }}</span>
                </td>
                <td class="py-3.5 px-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-charcoal-100 text-charcoal-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {{ (rec.nombre || 'E').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <div class="font-bold text-charcoal-900 text-sm">{{ rec.nombre }}</div>
                      <div class="text-[10px] text-charcoal-500 mono-code">No. Empleado: #{{ rec.codigo_empleado }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-3.5 px-4">
                  <span class="text-charcoal-600 font-medium text-xs">
                    {{ rec.area }}
                  </span>
                </td>
                <td class="py-3.5 px-4">
                  <div class="flex items-center gap-2">
                    <span class="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-charcoal-700">
                      <i class="ph text-sm text-charcoal-400" :class="{
                        'ph-fingerprint': rec.metodo === 'HUELLA',
                        'ph-scan-smiley': rec.metodo === 'ROSTRO',
                        'ph-password': rec.metodo === 'PIN',
                        'ph-pencil-simple-line': rec.metodo === 'MANUAL'
                      }"></i>
                      {{ rec.metodo }}
                    </span>
                    <span v-if="rec.sub_event_type" class="text-[10px] text-charcoal-400 mono-code">(minor {{ rec.sub_event_type }})</span>
                  </div>
                </td>
                <td class="py-3.5 px-4">
                  <div class="font-semibold text-charcoal-800">{{ rec.reloj_nombre }}</div>
                  <div class="text-[10px] text-charcoal-400 mono-code">
                    {{ rec.es_manual ? 'Registro por Administrador' : '192.168.11.71' }}
                  </div>
                </td>
                <td class="py-3.5 px-4 mono-code font-semibold text-charcoal-900">
                  {{ rec.fecha_hora_display }}
                </td>
                <td class="py-3.5 px-5 text-right">
                  <div class="flex flex-col items-end gap-1">
                    <span v-if="rec.es_rebote" class="inline-flex items-center gap-1.5 text-[11px] font-medium text-charcoal-400">
                      <i class="ph ph-warning-circle text-sm"></i>
                      REBOTE IGNORADO (&lt;180s)
                    </span>
                    <span v-else-if="rec.es_manual" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-charcoal-600">
                      <i class="ph ph-pencil-simple-line text-sm"></i>
                      {{ rec.estatus_prenomina || 'JUSTIFICADO (MANUAL)' }}
                    </span>
                    <span v-else-if="rec.estatus_prenomina && rec.estatus_prenomina.startsWith('RETARDO')" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-600">
                      <i class="ph ph-clock-countdown text-sm"></i>
                      {{ rec.estatus_prenomina }}
                    </span>
                    <span v-else-if="rec.estatus_prenomina && rec.estatus_prenomina.startsWith('PUNTUAL')" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-charcoal-900">
                      <i class="ph ph-check-circle text-sm"></i>
                      PUNTUAL
                    </span>
                    <span v-else class="inline-flex items-center gap-1.5 text-[11px] font-medium text-charcoal-500">
                      <i class="ph ph-sign-out text-sm"></i>
                      {{ rec.estatus_prenomina || 'SALIDA / REGISTRO' }}
                    </span>
                    <span v-if="rec.nota_incidencia" class="text-[10px] text-charcoal-400 italic">
                      "{{ rec.nota_incidencia }}"
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- MODAL CHECADA MANUAL / JUSTIFICACIÓN (DISTRIBUCIÓN HORIZONTAL AMPLIA) -->
      <div v-if="showManualModal" class="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop-anim animate-in fade-in duration-200">
        <div class="bg-white rounded-3xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl border border-charcoal-200 space-y-5">
          <div class="flex items-center justify-between pb-3 border-b border-charcoal-100">
            <div class="flex items-center gap-2.5">
              <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-pencil-simple-line text-lg text-charcoal-400"></i></span>
              <div>
                <h3 class="text-sm font-semibold text-charcoal-900">Registrar Checada Manual</h3>
                <p class="text-[11px] text-charcoal-400">Incidencia autorizada para pre-nómina</p>
              </div>
            </div>
            <button @click="showManualModal = false" class="text-charcoal-400 hover:text-charcoal-700 text-lg cursor-pointer">
              <i class="ph ph-x"></i>
            </button>
          </div>

          <form @submit.prevent="submitManualCheckin" class="space-y-4">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <!-- Empleado -->
              <div>
                <label class="block text-xs font-bold text-charcoal-700 mb-1">Colaborador</label>
                <select
                  v-model="manualForm.codigo_empleado"
                  required
                  class="w-full h-10 px-3 rounded-2xl border border-charcoal-200 bg-white text-xs font-semibold focus:ring-2 focus:ring-black focus:outline-none">
                  <option v-for="emp in employees" :key="emp.codigo_empleado" :value="emp.codigo_empleado">
                    #{{ emp.codigo_empleado }} — {{ emp.nombre }} ({{ emp.area_nombre || emp.area }})
                  </option>
                </select>
              </div>

              <!-- Fecha y Hora -->
              <div>
                <label class="block text-xs font-bold text-charcoal-700 mb-1">Fecha y Hora del Evento</label>
                <input
                  type="datetime-local"
                  v-model="manualForm.fecha_hora_evento"
                  required
                  class="w-full h-10 px-3 rounded-2xl border border-charcoal-200 bg-white text-xs font-semibold focus:ring-2 focus:ring-black focus:outline-none">
              </div>
            </div>

            <!-- Justificación / Nota -->
            <div>
              <label class="block text-xs font-bold text-charcoal-700 mb-1">Motivo / Nota de Incidencia</label>
              <input
                type="text"
                v-model="manualForm.nota_incidencia"
                required
                placeholder="Ej. Olvido de checada autorizado, Permiso médico..."
                class="w-full h-10 px-3 rounded-2xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none">
              
              <!-- Quick tag buttons -->
              <div class="flex flex-wrap gap-1.5 mt-2">
                <button
                  type="button"
                  v-for="tag in ['Olvido de checada autorizado', 'Permiso médico', 'Comisión externa', 'Falla eléctrica']"
                  :key="tag"
                  @click="setQuickNote(tag)"
                  class="text-[10px] px-2.5 py-1 bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-700 rounded-lg transition-colors cursor-pointer">
                  + {{ tag }}
                </button>
              </div>
            </div>

            <div class="pt-3 flex items-center justify-end gap-2 border-t border-charcoal-100">
              <button
                type="button"
                @click="showManualModal = false"
                class="px-4 py-2 text-xs font-semibold text-charcoal-600 hover:bg-charcoal-100 rounded-full transition-colors cursor-pointer">
                Cancelar
              </button>
              <button
                type="submit"
                :disabled="isSavingManual"
                class="px-5 py-2 bg-[#18181B] hover:bg-black text-white text-xs font-bold rounded-full shadow-md transition-all flex items-center gap-2 cursor-pointer">
                <i v-if="!isSavingManual" class="ph ph-check"></i>
                <div v-else class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                <span>{{ isSavingManual ? 'Guardando...' : 'Guardar Incidencia' }}</span>
              </button>
            </div>
          </form>
        </div>
      </div>

    </div>
  `
};
