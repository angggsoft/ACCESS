// Component: ViewAreas
// Gestión de Áreas, Departamentos, Horarios y Tolerancias para Pre-Nómina

import { ref } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewAreas',
  components: { ModalBase },
  props: {
    areas: { type: Array, default: () => [] }
  },
  emits: ['refresh', 'toast'],
  setup(props, { emit }) {
    const isModalOpen = ref(false);
    const form = ref({
      codigo: '',
      nombre: '',
      responsable: '',
      turno: 'Matutino Operativo',
      horario: '08:00 - 17:00',
      tolerancia_min: 10,
      ubicacion: 'Planta Cerro Gordo'
    });

    function openNewArea() {
      form.value = {
        codigo: `AREA-0${props.areas.length + 1}`,
        nombre: '',
        responsable: '',
        turno: 'Matutino',
        horario: '08:00 - 17:00',
        tolerancia_min: 10,
        ubicacion: 'Planta Cerro Gordo'
      };
      isModalOpen.value = true;
    }

    function editArea(a) {
      form.value = { ...a };
      isModalOpen.value = true;
    }

    async function saveArea() {
      if (!form.value.nombre) {
        emit('toast', 'El nombre del área es obligatorio', 'error');
        return;
      }
      try {
        const res = await fetch('/api/areas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Área guardada');
          isModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al guardar área', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red', 'error');
      }
    }

    async function deleteArea(a) {
      if (!confirm(`¿Eliminar el área '${a.nombre}'?`)) return;
      await fetch(`/api/areas/${a.id}`, { method: 'DELETE' });
      emit('toast', `Área '${a.nombre}' eliminada`);
      emit('refresh');
    }

    return {
      isModalOpen,
      form,
      openNewArea,
      editArea,
      saveArea,
      deleteArea
    };
  },
  template: `
    <div class="w-full space-y-6 animate-in fade-in duration-150">

      <!-- ACCIONES -->
      <div class="flex items-center justify-end">
        <button
          type="button"
          @click="openNewArea"
          class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-all cursor-pointer shrink-0">
          <i class="ph ph-plus-circle text-base"></i>
          <span>Nueva Área / Turno</span>
        </button>
      </div>

      <!-- AREAS CARDS GRID -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div
          v-for="a in areas"
          :key="a.id"
          class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm flex flex-col justify-between">
          
          <div>
            <div class="flex items-start justify-between gap-3 mb-4">
              <div class="flex items-center gap-3">
                <div class="w-11 h-11 rounded-xl bg-charcoal-100 text-charcoal-900 flex items-center justify-center text-xl font-bold">
                  <i class="ph ph-buildings"></i>
                </div>
                <div>
                  <span class="text-[10px] mono-code font-bold px-2 py-0.5 rounded bg-charcoal-100 text-charcoal-700">{{ a.codigo }}</span>
                  <h3 class="text-base font-bold text-charcoal-900 mt-0.5">{{ a.nombre }}</h3>
                </div>
              </div>

              <span class="px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 mono-code">
                {{ a.empleados_count || 0 }} colaboradores
              </span>
            </div>

            <div class="grid grid-cols-2 gap-3 p-4 rounded-3xl bg-offwhite border border-charcoal-200/70 text-xs">
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Responsable</span>
                <span class="font-bold text-charcoal-900">{{ a.responsable }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Ubicación / Sede</span>
                <span class="font-semibold text-charcoal-700">{{ a.ubicacion }}</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Turno y Horario</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ a.turno }} ({{ a.horario }})</span>
              </div>
              <div>
                <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Tolerancia Entrada</span>
                <span class="font-bold text-emerald-700 mono-code">{{ a.tolerancia_min }} minutos</span>
              </div>
            </div>
          </div>

          <div class="pt-4 mt-4 border-t border-charcoal-100 flex items-center justify-end gap-2">
            <button
              type="button"
              @click="editArea(a)"
              class="px-3.5 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold cursor-pointer">
              <i class="ph ph-pencil-simple"></i> Editar
            </button>
            <button
              type="button"
              @click="deleteArea(a)"
              class="px-3 py-1.5 rounded-full text-red-600 hover:bg-red-50 text-xs font-semibold cursor-pointer">
              <i class="ph ph-trash"></i>
            </button>
          </div>

        </div>
      </div>

      <!-- MODAL: NUEVA / EDITAR ÁREA -->
      <ModalBase
        v-if="isModalOpen"
        title="Configurar Área y Horario Operativo"
        confirmLabel="Guardar Área"
        size="md"
        @close="isModalOpen = false"
        @confirm="saveArea">
        
        <div class="space-y-4 text-xs">
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Código</label>
              <input v-model="form.codigo" type="text" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
            <div class="col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1">Nombre del Área / Departamento</label>
              <input v-model="form.nombre" type="text" placeholder="Ej: Producción Planta B"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Jefe / Responsable</label>
              <input v-model="form.responsable" type="text" placeholder="Nombre del responsable"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Ubicación / Sede</label>
              <input v-model="form.ubicacion" type="text" placeholder="Ej: Cerro Gordo"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Nombre Turno</label>
              <input v-model="form.turno" type="text" placeholder="Matutino"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Horario</label>
              <input v-model="form.horario" type="text" placeholder="08:00 - 17:00"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Tolerancia (min)</label>
              <input v-model="form.tolerancia_min" type="number"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
