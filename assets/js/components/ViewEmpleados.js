// Component: ViewEmpleados
// Directorio de Empleados y Enrolamiento Biométrico Remoto (ISAPI UserInfo + FDLib)

import { ref, computed } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewEmpleados',
  components: { ModalBase },
  props: {
    employees: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] }
  },
  emits: ['refresh', 'toast', 'sync-clock'],
  setup(props, { emit }) {
    const searchQuery = ref('');
    const selectedArea = ref('all');

    const isEmpModalOpen = ref(false);
    const isSaving = ref(false);
    const empForm = ref({
      codigo_empleado: '',
      nombre: '',
      area_nombre: 'Operaciones Cerro Gordo',
      puesto: 'Colaborador',
      turno: 'Matutino (08:00 - 17:00)',
      pin: '123456',
      admin_ui: true,
      sync_to_clock: true
    });

    const isFaceModalOpen = ref(false);
    const faceTargetEmp = ref(null);
    const selectedFaceFile = ref(null);
    const isUploadingFace = ref(false);

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
        : 4;
      empForm.value = {
        codigo_empleado: String(nextId),
        nombre: '',
        area_nombre: props.areas[0]?.nombre || 'TI y Sistemas',
        puesto: 'Especialista',
        turno: 'Matutino (08:00 - 17:00)',
        pin: '123456',
        admin_ui: true,
        sync_to_clock: true
      };
      isEmpModalOpen.value = true;
    }

    function openEditEmployee(emp) {
      empForm.value = {
        codigo_empleado: String(emp.codigo_empleado),
        nombre: emp.nombre,
        area_nombre: emp.area_nombre || 'Operaciones Cerro Gordo',
        puesto: emp.puesto || 'Colaborador',
        turno: emp.turno || 'Matutino (08:00 - 17:00)',
        pin: emp.pin || '123456',
        admin_ui: Boolean(emp.admin_ui),
        sync_to_clock: true
      };
      isEmpModalOpen.value = true;
    }

    async function saveEmployee() {
      if (!empForm.value.codigo_empleado || !empForm.value.nombre) {
        emit('toast', 'ID y Nombre del empleado son obligatorios', 'error');
        return;
      }
      isSaving.value = true;
      try {
        const res = await fetch('/api/employees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(empForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Empleado guardado y sincronizado con el reloj');
          isEmpModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al guardar empleado', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar empleado', 'error');
      } finally {
        isSaving.value = false;
      }
    }

    function openFaceUpload(emp) {
      faceTargetEmp.value = emp;
      selectedFaceFile.value = null;
      isFaceModalOpen.value = true;
    }

    function handleFileChange(e) {
      if (e.target.files && e.target.files[0]) {
        selectedFaceFile.value = e.target.files[0];
      }
    }

    async function uploadFace() {
      if (!selectedFaceFile.value || !faceTargetEmp.value) {
        emit('toast', 'Selecciona una imagen JPG primero', 'error');
        return;
      }
      isUploadingFace.value = true;
      try {
        const fd = new FormData();
        fd.append('file', selectedFaceFile.value);
        const res = await fetch(`/api/employees/${faceTargetEmp.value.codigo_empleado}/face`, {
          method: 'POST',
          body: fd
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Rostro enrolado en el reloj');
          isFaceModalOpen.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error al enrolar rostro', 'error');
        }
      } catch (e) {
        emit('toast', 'Error enviando fotografía al reloj', 'error');
      } finally {
        isUploadingFace.value = false;
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
      saveEmployee,
      isFaceModalOpen,
      faceTargetEmp,
      selectedFaceFile,
      isUploadingFace,
      openFaceUpload,
      handleFileChange,
      uploadFace
    };
  },
  template: `
    <div class="w-full space-y-5 animate-in fade-in duration-150">

      <!-- HEADER -->
      <div class="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h2 class="text-3xl font-bold text-charcoal-900 tracking-tight">Empleados</h2>
          <p class="text-xs text-sky-600 mt-0.5">Alta y credenciales biométricas</p>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            @click="$emit('sync-clock')"
            class="px-4 py-2.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-900 text-xs font-bold flex items-center gap-2 transition-all cursor-pointer">
            <i class="ph ph-arrows-clockwise text-sm"></i>
            <span>Importar Usuarios del Reloj</span>
          </button>

          <button
            type="button"
            @click="openNewEmployee"
            class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 shadow-sm transition-all cursor-pointer">
            <i class="ph ph-user-plus text-sm"></i>
            <span>Nuevo Empleado (Alta ISAPI)</span>
          </button>
        </div>
      </div>

      <!-- FILTERS -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-2xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar por nombre, ID o puesto..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900">
        </div>

        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-charcoal-500">Área:</span>
          <select v-model="selectedArea" class="px-3.5 py-2 rounded-full border border-charcoal-200 text-xs font-semibold bg-white">
            <option value="all">Todas las Áreas</option>
            <option v-for="a in areas" :key="a.id" :value="a.nombre">{{ a.nombre }}</option>
          </select>
        </div>
      </div>

      <!-- EMPLOYEES TABLE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3.5 px-6">ID Reloj</th>
                <th class="py-3.5 px-4">Colaborador</th>
                <th class="py-3.5 px-4">Área y Turno</th>
                <th class="py-3.5 px-4">Huella Dactilar</th>
                <th class="py-3.5 px-4">Rostro IA (FDLib)</th>
                <th class="py-3.5 px-4">PIN / Menú Admin</th>
                <th class="py-3.5 px-6 text-right">Acciones ISAPI</th>
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
                    <i class="ph ph-fingerprint text-sm"></i> ENROLADA
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-charcoal-100 text-charcoal-500 border border-charcoal-200">
                    PENDIENTE
                  </span>
                </td>
                <td class="py-4 px-4">
                  <span v-if="emp.tiene_rostro" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    <i class="ph ph-scan-smiley text-sm"></i> ENROLADO
                  </span>
                  <button
                    v-else
                    type="button"
                    @click="openFaceUpload(emp)"
                    class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 cursor-pointer transition-colors">
                    <i class="ph ph-camera-plus text-sm"></i> Subir Foto JPG
                  </button>
                </td>
                <td class="py-4 px-4">
                  <div class="flex items-center gap-1.5">
                    <span class="mono-code text-[11px] px-2 py-0.5 rounded bg-charcoal-100 text-charcoal-800 font-semibold">
                      PIN: {{ emp.pin || '••••' }}
                    </span>
                    <span v-if="emp.admin_ui" class="text-[10px] font-bold px-2 py-0.5 rounded bg-charcoal-900 text-white" title="Puede abrir el menú físico del reloj">
                      Admin UI
                    </span>
                  </div>
                </td>
                <td class="py-4 px-6 text-right space-x-1.5">
                  <button
                    type="button"
                    @click="openFaceUpload(emp)"
                    title="Subir fotografía de rostro al reloj"
                    class="px-3 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-[11px] font-semibold transition-colors cursor-pointer">
                    <i class="ph ph-camera"></i> Rostro
                  </button>
                  <button
                    type="button"
                    @click="openEditEmployee(emp)"
                    class="px-3 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white text-[11px] font-semibold transition-colors cursor-pointer">
                    <i class="ph ph-pencil-simple"></i> Editar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- MODAL: CREAR / EDITAR EMPLEADO -->
      <ModalBase
        v-if="isEmpModalOpen"
        title="Alta / Edición de Empleado en Reloj ISAPI"
        :confirmLabel="isSaving ? 'Sincronizando con Reloj...' : 'Guardar y Enviar al Reloj'"
        :confirmDisabled="isSaving"
        size="md"
        @close="isEmpModalOpen = false"
        @confirm="saveEmployee">
        
        <div class="space-y-4 text-xs">
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">No. Empleado (ID)</label>
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
              <label class="block font-bold text-charcoal-800 mb-1">Área / Departamento</label>
              <select v-model="empForm.area_nombre" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white">
                <option v-for="a in areas" :key="a.id" :value="a.nombre">{{ a.nombre }}</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Puesto / Rol</label>
              <input v-model="empForm.puesto" type="text" placeholder="Ej: Supervisor"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Turno Asignado</label>
              <input v-model="empForm.turno" type="text" placeholder="Matutino (08:00 - 17:00)"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">PIN Numérico (Teclado Reloj)</label>
              <input v-model="empForm.pin" type="text" placeholder="123456"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
          </div>

          <div class="p-3.5 rounded-3xl bg-charcoal-50 border border-charcoal-200 space-y-2.5">
            <label class="flex items-center justify-between cursor-pointer">
              <div>
                <span class="font-bold text-charcoal-900 block">Permiso de Menú Administrador en Reloj (localUIRight)</span>
                <span class="text-[11px] text-charcoal-500">Permite entrar al menú físico del reloj usando su ID y PIN numérico</span>
              </div>
              <input v-model="empForm.admin_ui" type="checkbox" class="w-4 h-4 accent-charcoal-900">
            </label>
          </div>
        </div>
      </ModalBase>

      <!-- MODAL: SUBIR ROSTRO JPG -->
      <ModalBase
        v-if="isFaceModalOpen"
        :title="'Enrolar Rostro IA — #' + (faceTargetEmp?.codigo_empleado || '') + ' ' + (faceTargetEmp?.nombre || '')"
        :confirmLabel="isUploadingFace ? 'Subiendo a FDLib...' : 'Subir Fotografía al Reloj'"
        :confirmDisabled="isUploadingFace || !selectedFaceFile"
        size="md"
        @close="isFaceModalOpen = false"
        @confirm="uploadFace">
        
        <div class="space-y-4 text-xs">
          <div class="p-4 rounded-3xl bg-indigo-50 border border-indigo-200 text-indigo-900">
            <p class="font-bold mb-1">Enrolamiento Facial Remoto (ISAPI FDLib)</p>
            <p class="text-[11px] leading-relaxed">
              Selecciona una fotografía tipo selfie o credencial en formato <b>.JPG</b> donde el rostro se vea de frente y bien iluminado. El reloj la procesará en su red neuronal y reconocerá al empleado de inmediato.
            </p>
          </div>

          <div>
            <label class="block font-bold text-charcoal-800 mb-2">Seleccionar Archivo de Imagen (.jpg / .jpeg)</label>
            <input
              type="file"
              accept="image/jpeg,image/jpg"
              @change="handleFileChange"
              class="w-full text-xs file:mr-4 file:py-2.5 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-[#18181B] file:text-white hover:file:bg-black cursor-pointer">
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
