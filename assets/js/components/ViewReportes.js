// Component: ViewReportes
// Consolidado de Pre-Nómina, Resumen por Empleado y Exportación CSV

import { computed } from 'vue';

export default {
  name: 'ViewReportes',
  props: {
    records: { type: Array, default: () => [] },
    employees: { type: Array, default: () => [] },
    summary: { type: Object, default: () => ({}) }
  },
  emits: ['export-csv', 'sync-clock'],
  setup(props) {
    const employeeConsolidation = computed(() => {
      return props.employees.map(emp => {
        const empRecords = props.records.filter(r => String(r.codigo_empleado) === String(emp.codigo_empleado));
        const validas = empRecords.filter(r => !r.es_rebote);
        const rebotes = empRecords.filter(r => r.es_rebote);
        const firstCheck = validas.length ? validas[validas.length - 1].fecha_hora_display : 'Sin registro';
        const lastCheck = validas.length ? validas[0].fecha_hora_display : 'Sin registro';

        return {
          ...emp,
          total_validas: validas.length,
          total_rebotes: rebotes.length,
          primera_checada: firstCheck,
          ultima_checada: lastCheck,
          estatus: validas.length > 0 ? 'ASISTENCIA REGISTRADA' : 'PENDIENTE'
        };
      });
    });

    return {
      employeeConsolidation
    };
  },
  template: `
    <div class="w-full space-y-6 animate-in fade-in duration-150">

      <!-- HEADER -->
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 class="text-3xl font-bold text-charcoal-900 tracking-tight">Pre-nómina</h2>
          <p class="text-xs text-sky-600 mt-0.5">Resumen de asistencia por colaborador</p>
        </div>

        <button
          type="button"
          @click="$emit('export-csv')"
          class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-all cursor-pointer shrink-0">
          <i class="ph ph-file-csv text-base"></i>
          <span>Descargar Pre-Nómina (CSV)</span>
        </button>
      </div>

      <!-- CONSOLIDATION TABLE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-charcoal-100">
          <h3 class="text-sm font-bold text-charcoal-900">Resumen de Asistencia por Colaborador</h3>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3.5 px-6">ID</th>
                <th class="py-3.5 px-4">Colaborador</th>
                <th class="py-3.5 px-4">Área / Turno</th>
                <th class="py-3.5 px-4">Checadas Válidas</th>
                <th class="py-3.5 px-4">Rebotes Depurados</th>
                <th class="py-3.5 px-4">Primera Checada</th>
                <th class="py-3.5 px-4">Última Checada</th>
                <th class="py-3.5 px-6 text-right">Estatus Periodo</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="row in employeeConsolidation" :key="row.codigo_empleado" class="hover:bg-charcoal-50/70">
                <td class="py-4 px-6 mono-code font-bold text-charcoal-900">#{{ row.codigo_empleado }}</td>
                <td class="py-4 px-4 font-bold text-charcoal-900">{{ row.nombre }}</td>
                <td class="py-4 px-4">
                  <div class="font-medium text-charcoal-800">{{ row.area_nombre }}</div>
                  <div class="text-[10px] text-charcoal-400">{{ row.turno }}</div>
                </td>
                <td class="py-4 px-4 mono-code font-bold text-emerald-700">{{ row.total_validas }}</td>
                <td class="py-4 px-4 mono-code font-semibold text-amber-700">{{ row.total_rebotes }}</td>
                <td class="py-4 px-4 mono-code text-charcoal-700">{{ row.primera_checada }}</td>
                <td class="py-4 px-4 mono-code text-charcoal-700">{{ row.ultima_checada }}</td>
                <td class="py-4 px-6 text-right">
                  <span v-if="row.total_validas > 0" class="px-3 py-1 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    {{ row.estatus }}
                  </span>
                  <span v-else class="px-3 py-1 rounded-full text-[10px] font-bold bg-charcoal-100 text-charcoal-500 border border-charcoal-200">
                    SIN CHECADAS HOY
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>
  `
};
