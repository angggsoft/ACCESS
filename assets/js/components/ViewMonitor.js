// Component: ViewMonitor
// Monitor de Checadas en Tiempo Real con auto-refresco, filtros por método/estatus y sincronización ISAPI

import { ref, computed } from 'vue';

export default {
  name: 'ViewMonitor',
  props: {
    records: { type: Array, default: () => [] },
    summary: { type: Object, default: () => ({}) },
    isSyncing: { type: Boolean, default: false },
    lastUpdated: { type: String, default: '' }
  },
  emits: ['sync-clock', 'export-csv'],
  setup(props) {
    const searchQuery = ref('');
    const statusFilter = ref('all'); // 'all' | 'valid' | 'bounce'
    const methodFilter = ref('all'); // 'all' | 'HUELLA' | 'ROSTRO' | 'PIN'

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
          return matchName || matchEmp || matchArea || matchSerial;
        }
        return true;
      });
    });

    return {
      searchQuery,
      statusFilter,
      methodFilter,
      filteredRecords
    };
  },
  template: `
    <div class="w-full space-y-5 animate-in fade-in duration-150">

      <!-- ACCIONES -->
      <div class="flex items-center justify-end gap-2.5">
        <button type="button" :disabled="isSyncing" @click="$emit('sync-clock')"
          class="px-4 py-2 rounded-xl bg-white border border-charcoal-200 hover:bg-charcoal-50 text-charcoal-900 text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50">
          <i class="ph ph-arrows-clockwise text-sm" :class="{ 'animate-spin': isSyncing }"></i>
          <span>{{ isSyncing ? 'Sincronizando…' : 'Sincronizar' }}</span>
        </button>
        <button type="button" @click="$emit('export-csv')"
          class="px-4 py-2 rounded-xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 cursor-pointer">
          <i class="ph ph-download-simple text-sm"></i>
          <span>Exportar CSV</span>
        </button>
      </div>

      <!-- 3 KPIs -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-white rounded-3xl px-6 py-5 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ summary.total_checadas || 0 }}</span>
          <div><p class="text-sm font-bold text-charcoal-900">Eventos</p><p class="text-[11px] text-charcoal-400">totales</p></div>
        </div>
        <div class="bg-white rounded-3xl px-6 py-5 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-5xl font-black text-emerald-600 tracking-tight leading-none">{{ summary.checadas_validas || 0 }}</span>
          <div><p class="text-sm font-bold text-charcoal-900">Válidas</p><p class="text-[11px] text-charcoal-400">para pre-nómina</p></div>
        </div>
        <div class="bg-white rounded-3xl px-6 py-5 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-5xl font-black text-amber-500 tracking-tight leading-none">{{ summary.rebotes_ignorados || 0 }}</span>
          <div><p class="text-sm font-bold text-charcoal-900">Rebotes</p><p class="text-[11px] text-charcoal-400">menos de 180 s</p></div>
        </div>
      </div>

      <!-- FILTER BAR -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-sm flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <!-- Search -->
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400 text-base"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar por nombre, # empleado, área o serial..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900 text-charcoal-900">
        </div>

        <!-- Filter Pills -->
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="st in [
              { id: 'all', label: 'Todos' },
              { id: 'valid', label: 'Solo Válidos' },
              { id: 'bounce', label: 'Rebotes (<180s)' }
            ]"
            :key="st.id"
            type="button"
            @click="statusFilter = st.id"
            class="px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer"
            :class="statusFilter === st.id ? 'bg-[#18181B] text-white' : 'bg-charcoal-100 text-charcoal-600 hover:bg-charcoal-200'">
            {{ st.label }}
          </button>

          <span class="text-charcoal-300 mx-1">|</span>

          <button
            v-for="mt in [
              { id: 'all', label: 'Todo Método' },
              { id: 'HUELLA', label: 'Huella' },
              { id: 'ROSTRO', label: 'Rostro' },
              { id: 'PIN', label: 'PIN' }
            ]"
            :key="mt.id"
            type="button"
            @click="methodFilter = mt.id"
            class="px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer"
            :class="methodFilter === mt.id ? 'bg-indigo-600 text-white' : 'bg-charcoal-100 text-charcoal-600 hover:bg-charcoal-200'">
            {{ mt.label }}
          </button>
        </div>
      </div>

      <!-- LIVE LOG TABLE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
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
                  #{{ rec.serial_no || rec.id }}
                  <span class="block text-[10px] font-normal text-charcoal-400">Reg {{ rec.id }}</span>
                </td>
                <td class="py-3.5 px-4">
                  <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-[#18181B] text-white flex items-center justify-center text-xs font-bold shrink-0">
                      {{ (rec.nombre || 'E').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <div class="font-bold text-charcoal-900 text-sm">{{ rec.nombre }}</div>
                      <div class="text-[10px] text-charcoal-500 mono-code">No. Empleado: #{{ rec.codigo_empleado }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-3.5 px-4">
                  <span class="px-2.5 py-1 rounded-lg bg-charcoal-100 text-charcoal-800 font-semibold text-[11px]">
                    {{ rec.area }}
                  </span>
                </td>
                <td class="py-3.5 px-4">
                  <div class="flex items-center gap-2">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border"
                      :class="{
                        'bg-indigo-50 text-indigo-700 border-indigo-200': rec.metodo === 'HUELLA',
                        'bg-emerald-50 text-emerald-700 border-emerald-200': rec.metodo === 'ROSTRO',
                        'bg-amber-50 text-amber-700 border-amber-200': rec.metodo === 'PIN',
                        'bg-charcoal-100 text-charcoal-800 border-charcoal-200': !['HUELLA','ROSTRO','PIN'].includes(rec.metodo)
                      }">
                      <i class="ph text-sm" :class="{
                        'ph-fingerprint': rec.metodo === 'HUELLA',
                        'ph-scan-smiley': rec.metodo === 'ROSTRO',
                        'ph-password': rec.metodo === 'PIN'
                      }"></i>
                      {{ rec.metodo }}
                    </span>
                    <span class="text-[10px] text-charcoal-400 mono-code">(minor {{ rec.sub_event_type }})</span>
                  </div>
                </td>
                <td class="py-3.5 px-4">
                  <div class="font-semibold text-charcoal-800">{{ rec.reloj_nombre }}</div>
                  <div class="text-[10px] text-emerald-600 mono-code">192.168.11.71</div>
                </td>
                <td class="py-3.5 px-4 mono-code font-semibold text-charcoal-900">
                  {{ rec.fecha_hora_display }}
                </td>
                <td class="py-3.5 px-5 text-right">
                  <span v-if="!rec.es_rebote" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <i class="ph ph-check-circle text-sm"></i>
                    VÁLIDO (En Turno)
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                    <i class="ph ph-warning-circle text-sm"></i>
                    REBOTE IGNORADO (&lt;180s)
                  </span>
                </td>
              </tr>
              <tr v-if="!filteredRecords.length">
                <td colspan="7" class="py-12 text-center text-charcoal-400">
                  <i class="ph ph-fingerprint text-4xl mb-2 block text-charcoal-300"></i>
                  <p class="text-sm font-semibold text-charcoal-600">No hay registros que coincidan con el filtro</p>
                  <p class="text-xs text-charcoal-400 mt-1">Coloca tu huella, rostro o PIN en el reloj Hikvision para ver el evento en tiempo real.</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  `
};
