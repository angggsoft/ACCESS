// Component: ViewEmpleados
// Directorio de Empleados por Sucursal (Enrolamiento Físico en Reloj + Auto-Descubrimiento Push)

import { ref, computed } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewEmpleados',
  components: { ModalBase },
  props: {
    employees: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: 1 },
    sucursalId: { type: [Number, String, null], default: 1 }
  },
  emits: ['refresh', 'toast'],
  setup(props, { emit }) {
    const searchQuery = ref('');
    const selectedArea = ref('all');

    const isEmpModalOpen = ref(false);
    const isSaving = ref(false);
    const empForm = ref({
      codigo_empleado: '',
      nombre: '',
      area_nombre: 'General',
      puesto: 'Colaborador',
      turno: 'Matutino (08:00 - 17:00)',
      pin: '',
      tiene_huella: true,
      tiene_rostro: true
    });

    const filteredEmployees = computed(() => {
      return props.employees.filter(e => {
        if (selectedArea.value !== 'all' && e.area_nombre !== selectedArea.value) return false;
        if (searchQuery.value.trim()) {
          const q = searchQuery.value.toLowerCase();
          return (
            (e.nombre || '').toLowerCase().includes(q) ||
            String(e.codigo_empleado || '').includes(q) ||
            (e.puesto || '').toLowerCase().includes(q)
          );
        }
        return true;
      });
    });

    function openNewEmployee() {
      const nextId = props.employees.length
        ? Math.max(...props.employees.map(x => parseInt(x.codigo_empleado, 10) || 0)) + 1
        : 1;
      empForm.value = {
        codigo_empleado: String(nextId),
        nombre: '',
        area_nombre: props.areas[0]?.nombre || 'General',
        puesto: 'Colaborador',
        turno: 'Matutino (08:00 - 17:00)',
        pin: '',
        tiene_huella: true,
        tiene_rostro: true
      };
      isEmpModalOpen.value = true;
    }

    function openEditEmployee(emp) {
      empForm.value = {
        codigo_empleado: String(emp.codigo_empleado),
        nombre: emp.nombre,
        area_nombre: emp.area_nombre || props.areas[0]?.nombre || 'General',
        puesto: emp.puesto || 'Colaborador',
        turno: emp.turno || 'Matutino (08:00 - 17:00)',
        pin: emp.pin || '',
        tiene_huella: Boolean(emp.tiene_huella),
        tiene_rostro: Boolean(emp.tiene_rostro)
      };
      isEmpModalOpen.value = true;
    }

    async function saveEmployee() {
      if (!empForm.value.codigo_empleado || !empForm.value.nombre) {
        emit('toast', 'ID de reloj y Nombre del colaborador son obligatorios', 'error');
        return;
      }
      isSaving.value = true;
      try {
        const res = await fetch('/api/employees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...empForm.value,
            empresa_id: props.empresaId,
            sucursal_id: props.sucursalId
          })
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Colaborador actualizado en la sucursal');
          isEmpModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al guardar colaborador', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar colaborador', 'error');
      } finally {
        isSaving.value = false;
      }
    }

    return {
      searchQuery,
      selectedArea,
      filteredEmployees,
      isEmpModalOpen,
      isSaving,
      empForm,
      openNewEmployee,
      openEditEmployee,
      saveEmployee
    };
  },
  template: `
    <div class="w-full flex-1 flex flex-col space-y-5 animate-in fade-in duration-150">

      <!-- FILTERS & INFO -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-2xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar por nombre, ID de reloj o puesto..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900">
        </div>

        <div class="flex items-center gap-2.5">
          <span class="text-xs font-semibold text-charcoal-500">Área:</span>
          <select v-model="selectedArea" class="px-3.5 py-2 rounded-full border border-charcoal-200 text-xs font-semibold bg-white">
            <option value="all">Todas las Áreas</option>
            <option v-for="a in areas" :key="a.id" :value="a.nombre">{{ a.nombre }}</option>
          </select>

          <button
            type="button"
            @click="openNewEmployee"
            class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer">
            <i class="ph ph-user-plus"></i>
            <span>Registrar Colaborador</span>
          </button>
        </div>
      </div>

      <!-- EMPLOYEES TABLE / EMPTY STATE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden flex-1 flex flex-col">
        <div v-if="!filteredEmployees.length" class="flex-1 flex flex-col items-center justify-center p-10 text-center min-h-[280px]">
          <i class="ph ph-users-three text-5xl text-charcoal-300 mb-3"></i>
          <p class="text-sm font-bold text-charcoal-800">
            {{ employees.length === 0 ? 'Sin colaboradores registrados en esta sucursal' : 'No hay colaboradores que coincidan con el filtro' }}
          </p>
          <p class="text-[11px] text-charcoal-400 mt-1 max-w-sm">
            {{ employees.length === 0 ? 'Registra un colaborador manualmente o espera a que chequen en el reloj para auto-descubrirlos.' : 'Prueba ajustando el texto de búsqueda o el área seleccionada.' }}
          </p>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3.5 px-6">ID Reloj</th>
                <th class="py-3.5 px-4">Colaborador</th>
                <th class="py-3.5 px-4">Área y Turno</th>
                <th class="py-3.5 px-4">Huella (Reloj Local)</th>
                <th class="py-3.5 px-4">Rostro (Reloj Local)</th>
                <th class="py-3.5 px-4">Terminal Sucursal</th>
                <th class="py-3.5 px-6 text-right">Gestión RH</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="emp in filteredEmployees" :key="emp.codigo_empleado" class="hover:bg-charcoal-50/70 transition-colors">
                <td class="py-4 px-6 mono-code font-black text-sm text-charcoal-900">#{{ emp.codigo_empleado }}</td>
                <td class="py-4 px-4">
                  <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-[#18181B] text-white flex items-center justify-center text-xs font-bold shrink-0">
                      {{ (emp.nombre || 'E').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <div class="font-bold text-charcoal-900 text-sm">{{ emp.nombre }}</div>
                      <div class="text-[11px] text-charcoal-500">{{ emp.puesto }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-4">
                  <div class="font-semibold text-charcoal-900">{{ emp.area_nombre }}</div>
                  <div class="text-[11px] text-charcoal-400">{{ emp.turno }}</div>
                </td>
                <td class="py-4 px-4">
                  <span v-if="emp.tiene_huella" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <i class="ph ph-fingerprint text-sm"></i> ACTIVA EN RELOJ
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-charcoal-100 text-charcoal-500 border border-charcoal-200">
                    SIN REGISTRO
                  </span>
                </td>
                <td class="py-4 px-4">
                  <span v-if="emp.tiene_rostro" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    <i class="ph ph-scan-smiley text-sm"></i> ACTIVO EN RELOJ
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-charcoal-100 text-charcoal-500 border border-charcoal-200">
                    SIN REGISTRO
                  </span>
                </td>
                <td class="py-4 px-4">
                  <span class="mono-code text-[11px] px-2.5 py-1 rounded-xl bg-charcoal-100 text-charcoal-800 font-semibold">
                    {{ emp.reloj_asignado || 'Sucursal Activa' }}
                  </span>
                </td>
                <td class="py-4 px-6 text-right">
                  <button
                    type="button"
                    @click="openEditEmployee(emp)"
                    class="px-3.5 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white text-[11px] font-semibold transition-colors cursor-pointer">
                    <i class="ph ph-pencil-simple"></i> Asignar Área / Turno
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- MODAL: CREAR / EDITAR EMPLEADO EN SUCURSAL -->
      <ModalBase
        v-if="isEmpModalOpen"
        title="Asignación de Colaborador en Sucursal (Enrolamiento Local en Reloj)"
        :confirmLabel="isSaving ? 'Guardando...' : 'Guardar en Catálogo RH'"
        :confirmDisabled="isSaving"
        size="md"
        @close="isEmpModalOpen = false"
        @confirm="saveEmployee">
        
        <div class="space-y-4 text-xs">
          <div class="p-3.5 rounded-2xl bg-offwhite border border-charcoal-200 text-[11px] text-charcoal-600">
            <b>Nota:</b> El alta de huella o rostro se realiza localmente en el reloj físico Hikvision con el mismo <b>ID de Empleado</b>. Cuando el empleado checa, el reloj sube el evento automáticamente a esta sucursal.
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">ID en Reloj Físico</label>
              <input v-model="empForm.codigo_empleado" type="text" placeholder="Ej: 4"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div class="col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1">Nombre Completo</label>
              <input v-model="empForm.nombre" type="text" placeholder="Ej: Angel Flores"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Área / Departamento (Pre-Nómina)</label>
              <select v-model="empForm.area_nombre" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white">
                <option v-for="a in areas" :key="a.id" :value="a.nombre">{{ a.nombre }}</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Puesto / Cargo</label>
              <input v-model="empForm.puesto" type="text" placeholder="Ej: Supervisor"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>

          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Turno Asignado</label>
            <input v-model="empForm.turno" type="text" placeholder="Matutino (08:00 - 17:00)"
              class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
