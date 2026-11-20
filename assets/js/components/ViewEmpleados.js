// Component: ViewEmpleados
// Directorio de Empleados por Sucursal (Enrolamiento Físico en Reloj + Auto-Descubrimiento Push)

import { ref, computed, onMounted, onUnmounted } from 'vue';
import ModalBase from './ModalBase.js';
import ScheduleBlocksEditor from './ScheduleBlocksEditor.js';

const WEEK_DAYS = [
  { num: '1', label: 'Lun' },
  { num: '2', label: 'Mar' },
  { num: '3', label: 'Mié' },
  { num: '4', label: 'Jue' },
  { num: '5', label: 'Vie' },
  { num: '6', label: 'Sáb' },
  { num: '7', label: 'Dom' }
];

export default {
  name: 'ViewEmpleados',
  components: { ModalBase, ScheduleBlocksEditor },
  props: {
    employees: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    schedules: { type: Array, default: () => [] },
    branches: { type: Array, default: () => [] },
    companyAreas: { type: Array, default: () => [] },
    companySchedules: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: 1 },
    sucursalId: { type: [Number, String, null], default: 1 }
  },
  emits: ['refresh', 'toast'],
  setup(props, { emit }) {
    const searchQuery = ref('');
    const selectedBranchFilter = ref('all');
    const selectedArea = ref('all');

    const isEmpModalOpen = ref(false);
    const isSaving = ref(false);
    const hasCustomBlocks = ref(false);
    const isEmpAreaDropdownOpen = ref(false);
    const isEmpScheduleDropdownOpen = ref(false);
    const isScheduleDetailVisible = ref(false);
    const isCreatingScheduleInEmpModal = ref(false);
    const isSavingNewSchedule = ref(false);
    const justSavedEmpSchedule = ref(null);

    const newScheduleForm = ref({
      id: null,
      nombre: '',
      descripcion: '',
      tolerancia_min: 10,
      bloques: []
    });

    const empForm = ref({
      codigo_empleado: '',
      codigo_contpaqi: '',
      nombre: '',
      sucursal_id: null,
      area_nombre: 'General',
      puesto: 'Colaborador',
      turno: 'Matutino (08:00 - 17:00)',
      horario_mode: 'area',
      horario_id: null,
      horario_tolerancia_min: 10,
      horario_bloques: [],
      pin: '',
      tiene_huella: true,
      tiene_rostro: true
    });

    function defaultEmployeeBlocks() {
      return [1, 2, 3, 4, 5].map(d => ({
        dia_semana: d,
        orden_bloque: 1,
        hora_entrada: '08:00',
        hora_salida: '17:00'
      }));
    }

    function cloneBlocks(list) {
      if (!Array.isArray(list) || !list.length) return [];
      return list.map((b, idx) => ({
        dia_semana: Number(b.dia_semana),
        orden_bloque: Number(b.orden_bloque || idx + 1),
        hora_entrada: String(b.hora_entrada || '08:00').slice(0, 5),
        hora_salida: String(b.hora_salida || '17:00').slice(0, 5)
      }));
    }

    const allCompanyAreas = computed(() => {
      return (props.companyAreas && props.companyAreas.length) ? props.companyAreas : (props.areas || []);
    });

    const allCompanySchedules = computed(() => {
      return (props.companySchedules && props.companySchedules.length) ? props.companySchedules : (props.schedules || []);
    });

    const filterAreaOptions = computed(() => {
      const pool = selectedBranchFilter.value === 'all'
        ? allCompanyAreas.value
        : allCompanyAreas.value.filter(a => Number(a.sucursal_id) === Number(selectedBranchFilter.value));
      const seen = new Set();
      const out = [];
      for (const a of pool) {
        if (!a?.nombre || seen.has(a.nombre)) continue;
        seen.add(a.nombre);
        out.push(a.nombre);
      }
      return out;
    });

    const modalAreas = computed(() => {
      const targetSuc = empForm.value.sucursal_id || props.sucursalId;
      const byBranch = targetSuc
        ? allCompanyAreas.value.filter(a => Number(a.sucursal_id) === Number(targetSuc))
        : [];
      return byBranch.length ? byBranch : allCompanyAreas.value;
    });

    const modalSchedules = computed(() => {
      const targetSuc = empForm.value.sucursal_id || props.sucursalId;
      const byBranch = targetSuc
        ? allCompanySchedules.value.filter(s => Number(s.sucursal_id) === Number(targetSuc))
        : [];
      return byBranch.length ? byBranch : allCompanySchedules.value;
    });

    const defaultBranchSchedule = computed(() => {
      const list = modalSchedules.value || [];
      if (!list.length) return justSavedEmpSchedule.value || null;
      return list.find(s => String(s.nombre || '').toLowerCase().includes('matutino')) || list[0];
    });

    const selectedAreaInfo = computed(() => {
      const target = String(empForm.value.area_nombre || '').trim().toLowerCase();
      return (modalAreas.value || []).find(a =>
        a.nombre === empForm.value.area_nombre ||
        String(a.nombre || '').trim().toLowerCase() === target
      ) || allCompanyAreas.value.find(a =>
        a.nombre === empForm.value.area_nombre ||
        String(a.nombre || '').trim().toLowerCase() === target
      ) || null;
    });

    const selectedTemplateSchedule = computed(() => {
      if (!empForm.value.horario_id) return null;
      const found = (allCompanySchedules.value || []).find(s => Number(s.id) === Number(empForm.value.horario_id));
      if (found) return found;
      if (justSavedEmpSchedule.value && Number(justSavedEmpSchedule.value.id) === Number(empForm.value.horario_id)) {
        return justSavedEmpSchedule.value;
      }
      return null;
    });

    // Horario efectivo seleccionado para mostrar en el selector y en la vista de detalle
    const activePreviewSchedule = computed(() => {
      if (empForm.value.horario_mode === 'plantilla' && selectedTemplateSchedule.value) {
        return selectedTemplateSchedule.value;
      }
      const areaSchedId = selectedAreaInfo.value?.horario_id;
      if (areaSchedId) {
        const fromArea = (allCompanySchedules.value || []).find(s => Number(s.id) === Number(areaSchedId));
        if (fromArea) return fromArea;
      }
      return defaultBranchSchedule.value || null;
    });

    function formatDayBlocksSummary(s, dayNum) {
      const list = (s?.bloques_por_dia && s.bloques_por_dia[String(dayNum)]) || [];
      if (list.length) {
        return list.map(b => `${b.hora_entrada}-${b.hora_salida}`).join(', ');
      }
      const rawBlocks = (s?.bloques || []).filter(b => Number(b.dia_semana) === Number(dayNum));
      if (rawBlocks.length) {
        return rawBlocks.map(b => `${b.hora_entrada}-${b.hora_salida}`).join(', ');
      }
      return 'Descanso';
    }

    function toggleEmpAreaDropdown(event) {
      if (event) event.stopPropagation();
      isEmpScheduleDropdownOpen.value = false;
      isEmpAreaDropdownOpen.value = !isEmpAreaDropdownOpen.value;
    }

    function selectEmpArea(areaName, event) {
      if (event) event.stopPropagation();
      empForm.value.area_nombre = areaName;
      isEmpAreaDropdownOpen.value = false;
    }

    function toggleEmpScheduleDropdown(event) {
      if (event) event.stopPropagation();
      isEmpAreaDropdownOpen.value = false;
      isEmpScheduleDropdownOpen.value = !isEmpScheduleDropdownOpen.value;
    }

    function selectInheritAreaSchedule(event) {
      if (event) event.stopPropagation();
      empForm.value.horario_mode = 'area';
      isEmpScheduleDropdownOpen.value = false;
    }

    function selectEmpTemplateSchedule(s, event) {
      if (event) event.stopPropagation();
      if (!s) return;
      empForm.value.horario_mode = 'plantilla';
      empForm.value.horario_id = Number(s.id);
      isEmpScheduleDropdownOpen.value = false;
    }

    function toggleScheduleDetailView(event) {
      if (event) event.stopPropagation();
      isEmpScheduleDropdownOpen.value = false;
      isEmpAreaDropdownOpen.value = false;
      isScheduleDetailVisible.value = !isScheduleDetailVisible.value;
    }

    function openCreateScheduleInEmpModal(event) {
      if (event) event.stopPropagation();
      isEmpScheduleDropdownOpen.value = false;
      isEmpAreaDropdownOpen.value = false;
      newScheduleForm.value = {
        id: null,
        nombre: '',
        descripcion: '',
        tolerancia_min: 10,
        bloques: defaultEmployeeBlocks()
      };
      isCreatingScheduleInEmpModal.value = true;
    }

    function closeCreateScheduleInEmpModal() {
      isCreatingScheduleInEmpModal.value = false;
    }

    function setNewScheduleTolerance(val) {
      const clamped = Math.max(0, Math.min(180, Math.round(Number(val) || 0)));
      newScheduleForm.value.tolerancia_min = clamped;
    }

    async function saveNewScheduleFromEmpModal() {
      if (!newScheduleForm.value.nombre.trim()) {
        emit('toast', 'El nombre del horario es obligatorio', 'error');
        return;
      }
      isSavingNewSchedule.value = true;
      try {
        const res = await fetch('/api/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...newScheduleForm.value,
            es_plantilla: 1,
            empresa_id: props.empresaId,
            sucursal_id: empForm.value.sucursal_id || props.sucursalId
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          emit('toast', data.message || 'Horario creado y seleccionado para el colaborador');
          if (data.schedule && data.schedule.id) {
            justSavedEmpSchedule.value = data.schedule;
            empForm.value.horario_mode = 'plantilla';
            empForm.value.horario_id = Number(data.schedule.id);
          }
          isCreatingScheduleInEmpModal.value = false;
          emit('refresh');
        } else {
          emit('toast', data.detail || 'No se pudo guardar el horario', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar el horario', 'error');
      } finally {
        isSavingNewSchedule.value = false;
      }
    }

    function handleGlobalClickEmpDropdowns(e) {
      if (isEmpAreaDropdownOpen.value) {
        const insideArea = e.target.closest && e.target.closest('[data-emp-area-dropdown]');
        if (!insideArea) isEmpAreaDropdownOpen.value = false;
      }
      if (isEmpScheduleDropdownOpen.value) {
        const insideSched = e.target.closest && e.target.closest('[data-emp-schedule-dropdown]');
        if (!insideSched) isEmpScheduleDropdownOpen.value = false;
      }
    }

    onMounted(() => window.addEventListener('click', handleGlobalClickEmpDropdowns));
    onUnmounted(() => window.removeEventListener('click', handleGlobalClickEmpDropdowns));

    function setHorarioMode(mode) {
      const prevMode = empForm.value.horario_mode;
      empForm.value.horario_mode = mode;
      if (mode === 'plantilla' && !empForm.value.horario_id && modalSchedules.value.length) {
        empForm.value.horario_id = modalSchedules.value[0].id;
      } else if (mode === 'personalizado' && prevMode !== 'personalizado') {
        const sourceBlocks = prevMode === 'plantilla'
          ? selectedTemplateSchedule.value?.bloques
          : (selectedAreaInfo.value?.horario_bloques || defaultBranchSchedule.value?.bloques);
        const sourceTol = prevMode === 'plantilla'
          ? selectedTemplateSchedule.value?.tolerancia_min
          : (selectedAreaInfo.value?.tolerancia_min ?? defaultBranchSchedule.value?.tolerancia_min);
        if (!hasCustomBlocks.value || !empForm.value.horario_bloques.length) {
          const cloned = cloneBlocks(sourceBlocks);
          empForm.value.horario_bloques = cloned.length ? cloned : defaultEmployeeBlocks();
          if (sourceTol !== undefined && sourceTol !== null) {
            empForm.value.horario_tolerancia_min = Number(sourceTol);
          }
        }
        hasCustomBlocks.value = true;
      }
    }

    function onEmpBranchChange() {
      isEmpAreaDropdownOpen.value = false;
      isEmpScheduleDropdownOpen.value = false;
      const areasList = modalAreas.value || [];
      if (areasList.length) {
        const currentLow = String(empForm.value.area_nombre || '').trim().toLowerCase();
        const match = areasList.find(a => String(a.nombre || '').trim().toLowerCase() === currentLow);
        empForm.value.area_nombre = match ? match.nombre : areasList[0].nombre;
      }
      const schedsList = modalSchedules.value || [];
      if (empForm.value.horario_mode === 'plantilla' && schedsList.length) {
        const hasMatch = schedsList.some(s => Number(s.id) === Number(empForm.value.horario_id));
        if (!hasMatch) {
          empForm.value.horario_id = defaultBranchSchedule.value?.id || schedsList[0].id;
        }
      }
    }

    // Modal Importar / Plantilla CSV
    const isCsvModalOpen = ref(false);
    const csvFileInputRef = ref(null);
    const selectedCsvFile = ref(null);
    const isDownloadingTemplate = ref(false);
    const isUploadingCsv = ref(false);
    const csvImportResult = ref(null);
    const csvImportError = ref('');

    function openCsvModal() {
      selectedCsvFile.value = null;
      csvImportResult.value = null;
      csvImportError.value = '';
      if (csvFileInputRef.value) {
        csvFileInputRef.value.value = '';
      }
      isCsvModalOpen.value = true;
    }

    function onCsvFileChange(ev) {
      const files = ev?.target?.files;
      selectedCsvFile.value = (files && files.length) ? files[0] : null;
      csvImportError.value = '';
      csvImportResult.value = null;
    }

    async function downloadTemplateCsv() {
      isDownloadingTemplate.value = true;
      csvImportError.value = '';
      try {
        const params = new URLSearchParams();
        if (props.empresaId) params.set('empresa_id', String(props.empresaId));
        if (selectedBranchFilter.value === 'all') {
          params.set('sucursal_id', '0');
          params.set('all_branches', 'true');
        } else {
          params.set('sucursal_id', String(selectedBranchFilter.value));
        }
        const res = await fetch(`/api/employees/template-csv?${params.toString()}`);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          csvImportError.value = errData.detail || 'No se pudo descargar la plantilla CSV.';
          emit('toast', csvImportError.value, 'error');
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = selectedBranchFilter.value === 'all'
          ? `plantilla_empleados_empresa_${props.empresaId || 'actual'}.csv`
          : `plantilla_empleados_sucursal_${selectedBranchFilter.value}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        emit('toast', 'Plantilla CSV pre-llenada descargada');
      } catch (e) {
        csvImportError.value = 'Error de red al descargar la plantilla CSV.';
        emit('toast', csvImportError.value, 'error');
      } finally {
        isDownloadingTemplate.value = false;
      }
    }

    async function uploadCsvFile() {
      if (!selectedCsvFile.value) {
        csvImportError.value = 'Selecciona primero un archivo .csv para subir.';
        return;
      }
      isUploadingCsv.value = true;
      csvImportError.value = '';
      csvImportResult.value = null;
      try {
        const formData = new FormData();
        formData.append('file', selectedCsvFile.value);
        if (props.empresaId) formData.append('empresa_id', String(props.empresaId));
        if (selectedBranchFilter.value !== 'all') {
          formData.append('sucursal_id', String(selectedBranchFilter.value));
        } else if (props.sucursalId) {
          formData.append('sucursal_id', String(props.sucursalId));
        }

        const res = await fetch('/api/employees/import-csv', {
          method: 'POST',
          body: formData
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          csvImportError.value = data.detail || 'Error al procesar el archivo CSV.';
          emit('toast', csvImportError.value, 'error');
          return;
        }
        csvImportResult.value = data;
        emit('toast', data.message || 'Catálogo de colaboradores actualizado desde CSV');
        emit('refresh');
      } catch (e) {
        csvImportError.value = 'Error de red al subir el archivo CSV.';
        emit('toast', csvImportError.value, 'error');
      } finally {
        isUploadingCsv.value = false;
      }
    }

    const filteredEmployees = computed(() => {
      return props.employees.filter(e => {
        if (selectedBranchFilter.value !== 'all' && Number(e.sucursal_id) !== Number(selectedBranchFilter.value)) return false;
        if (selectedArea.value !== 'all' && e.area_nombre !== selectedArea.value) return false;
        if (searchQuery.value.trim()) {
          const q = searchQuery.value.toLowerCase();
          return (
            (e.nombre || '').toLowerCase().includes(q) ||
            String(e.codigo_empleado || '').includes(q) ||
            String(e.codigo_contpaqi || '').toLowerCase().includes(q) ||
            (e.puesto || '').toLowerCase().includes(q) ||
            (e.sucursal_base_nombre || '').toLowerCase().includes(q)
          );
        }
        return true;
      });
    });

    function openEditEmployee(emp) {
      const origen = emp.horario_origen || 'AREA';
      const mode = origen === 'PERSONALIZADO'
        ? 'personalizado'
        : (origen === 'ASIGNADO' ? 'plantilla' : 'area');
      const initialBlocks = cloneBlocks(emp.horario_bloques);
      hasCustomBlocks.value = (mode === 'personalizado');
      isEmpAreaDropdownOpen.value = false;
      isEmpScheduleDropdownOpen.value = false;
      isScheduleDetailVisible.value = false;
      isCreatingScheduleInEmpModal.value = false;
      const targetSucId = emp.sucursal_id || props.sucursalId || props.branches[0]?.id || null;
      empForm.value.sucursal_id = targetSucId;
      empForm.value = {
        codigo_empleado: String(emp.codigo_empleado),
        codigo_contpaqi: emp.codigo_contpaqi || '',
        nombre: emp.sin_nombre ? '' : (emp.nombre || ''),
        sucursal_id: targetSucId,
        area_nombre: emp.area_nombre || modalAreas.value[0]?.nombre || 'General',
        puesto: emp.puesto || 'Colaborador',
        turno: emp.turno || 'Matutino (08:00 - 17:00)',
        horario_mode: mode === 'personalizado' ? 'plantilla' : mode,
        horario_id: (mode === 'plantilla' && emp.horario_id) ? Number(emp.horario_id) : (defaultBranchSchedule.value?.id || modalSchedules.value[0]?.id || null),
        horario_tolerancia_min: emp.horario_tolerancia_min ?? 10,
        horario_bloques: initialBlocks.length ? initialBlocks : defaultEmployeeBlocks(),
        pin: emp.pin || '',
        tiene_huella: Boolean(emp.tiene_huella),
        tiene_rostro: Boolean(emp.tiene_rostro)
      };
      if (origen !== 'ASIGNADO') {
        empForm.value.horario_mode = 'area';
      }
      isEmpModalOpen.value = true;
    }

    function openEditByCode(empNo) {
      const target = props.employees.find(e => String(e.codigo_empleado) === String(empNo));
      if (target) {
        openEditEmployee(target);
      } else {
        const targetSucId = props.sucursalId || props.branches[0]?.id || null;
        empForm.value.sucursal_id = targetSucId;
        const defaultArea = modalAreas.value[0] || props.areas[0] || null;
        const cloned = cloneBlocks(defaultArea?.horario_bloques);
        hasCustomBlocks.value = false;
        isEmpAreaDropdownOpen.value = false;
        isEmpScheduleDropdownOpen.value = false;
        isScheduleDetailVisible.value = false;
        isCreatingScheduleInEmpModal.value = false;
        empForm.value = {
          codigo_empleado: String(empNo),
          codigo_contpaqi: '',
          nombre: '',
          sucursal_id: targetSucId,
          area_nombre: defaultArea?.nombre || 'General',
          puesto: 'Colaborador',
          turno: 'Matutino (08:00 - 17:00)',
          horario_mode: 'area',
          horario_id: defaultBranchSchedule.value?.id || modalSchedules.value[0]?.id || null,
          horario_tolerancia_min: defaultArea?.tolerancia_min ?? 10,
          horario_bloques: cloned.length ? cloned : defaultEmployeeBlocks(),
          pin: '',
          tiene_huella: false,
          tiene_rostro: false
        };
        isEmpModalOpen.value = true;
      }
    }

    async function saveEmployee() {
      if (!empForm.value.codigo_empleado) {
        emit('toast', 'El ID de reloj es obligatorio', 'error');
        return;
      }
      if (empForm.value.horario_mode === 'plantilla' && !empForm.value.horario_id) {
        emit('toast', 'Selecciona una plantilla de horario', 'error');
        return;
      }
      const finalName = (empForm.value.nombre || '').trim() || `Empleado #${empForm.value.codigo_empleado}`;
      isSaving.value = true;
      try {
        const payload = {
          ...empForm.value,
          nombre: finalName,
          horario_id: empForm.value.horario_mode === 'plantilla' ? Number(empForm.value.horario_id) : null,
          horario_bloques: empForm.value.horario_mode === 'personalizado' ? empForm.value.horario_bloques : [],
          empresa_id: props.empresaId,
          sucursal_id: empForm.value.sucursal_id || props.sucursalId
        };
        const res = await fetch('/api/employees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Colaborador actualizado en la empresa');
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
      WEEK_DAYS,
      searchQuery,
      selectedBranchFilter,
      selectedArea,
      filterAreaOptions,
      modalAreas,
      modalSchedules,
      filteredEmployees,
      isEmpModalOpen,
      isSaving,
      empForm,
      defaultBranchSchedule,
      selectedAreaInfo,
      selectedTemplateSchedule,
      activePreviewSchedule,
      formatDayBlocksSummary,
      isEmpAreaDropdownOpen,
      isEmpScheduleDropdownOpen,
      isScheduleDetailVisible,
      isCreatingScheduleInEmpModal,
      isSavingNewSchedule,
      newScheduleForm,
      toggleEmpAreaDropdown,
      selectEmpArea,
      toggleEmpScheduleDropdown,
      selectInheritAreaSchedule,
      selectEmpTemplateSchedule,
      toggleScheduleDetailView,
      openCreateScheduleInEmpModal,
      closeCreateScheduleInEmpModal,
      setNewScheduleTolerance,
      saveNewScheduleFromEmpModal,
      setHorarioMode,
      onEmpBranchChange,
      openEditEmployee,
      openEditByCode,
      saveEmployee,
      isCsvModalOpen,
      csvFileInputRef,
      selectedCsvFile,
      isDownloadingTemplate,
      isUploadingCsv,
      csvImportResult,
      csvImportError,
      openCsvModal,
      onCsvFileChange,
      downloadTemplateCsv,
      uploadCsvFile
    };
  },
  template: `
    <div class="w-full flex-1 flex flex-col space-y-5 animate-in fade-in duration-150">

      <!-- FILTERS & INFO -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar por nombre, ID de reloj o puesto..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900">
        </div>

        <div class="flex items-center gap-2.5 flex-wrap">
          <span class="text-xs font-semibold text-charcoal-500">Sucursal Base:</span>
          <select v-model="selectedBranchFilter" class="px-3.5 py-2 rounded-full border border-charcoal-200 text-xs font-semibold bg-white">
            <option value="all">Todas las Sucursales</option>
            <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.nombre }}</option>
          </select>
          <span class="text-xs font-semibold text-charcoal-500">Área:</span>
          <select v-model="selectedArea" class="px-3.5 py-2 rounded-full border border-charcoal-200 text-xs font-semibold bg-white">
            <option value="all">Todas las Áreas</option>
            <option v-for="aName in filterAreaOptions" :key="aName" :value="aName">{{ aName }}</option>
          </select>
          <button
            type="button"
            @click="openCsvModal"
            class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs">
            <i class="ph ph-file-csv text-sm"></i>
            <span>Importar / Plantilla CSV</span>
          </button>
        </div>
      </div>

      <!-- EMPLOYEES TABLE / EMPTY STATE -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden flex-1 flex flex-col">
        <div v-if="!filteredEmployees.length" class="flex-1 flex flex-col items-center justify-center p-10 text-center min-h-[280px]">
          <i class="ph ph-users-three text-5xl text-charcoal-300 mb-3"></i>
          <p class="text-sm font-bold text-charcoal-800">
            {{ employees.length === 0 ? 'Sin colaboradores registrados en esta empresa' : 'No hay colaboradores que coincidan con el filtro' }}
          </p>
          <p class="text-[11px] text-charcoal-400 mt-1 max-w-sm">
            {{ employees.length === 0 ? 'Los colaboradores se registrarán automáticamente como "Empleado #ID" al realizar su primera checada en cualquier reloj de la empresa.' : 'Prueba ajustando el texto de búsqueda, sucursal base o el área seleccionada.' }}
          </p>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3.5 px-6">ID Reloj</th>
                <th class="py-3.5 px-4">Colaborador</th>
                <th class="py-3.5 px-4">Área y Horario</th>
                <th class="py-3.5 px-4">Huella (Reloj Local)</th>
                <th class="py-3.5 px-4">Rostro (Reloj Local)</th>
                <th class="py-3.5 px-4">Sucursal Base</th>
                <th class="py-3.5 px-6 text-right">Gestión RH</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="emp in filteredEmployees" :key="emp.codigo_empleado" class="hover:bg-charcoal-50/70 transition-colors">
                <td class="py-4 px-6 mono-code font-black text-sm text-charcoal-900">
                  <div>#{{ emp.codigo_empleado }}</div>
                  <div v-if="emp.codigo_contpaqi" class="text-[10px] font-medium text-charcoal-400 mt-0.5">
                    CONTPAQi: {{ emp.codigo_contpaqi }}
                  </div>
                </td>
                <td class="py-4 px-4">
                  <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-charcoal-100 text-charcoal-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {{ (emp.nombre || 'E').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-bold text-charcoal-900 text-sm">{{ emp.nombre }}</span>
                        <span
                          v-if="emp.sin_nombre"
                          class="text-[11px] font-medium text-charcoal-400">
                          Sin nombre asignado
                        </span>
                      </div>
                      <div class="text-[11px] text-charcoal-500">{{ emp.puesto }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-4">
                  <div class="font-semibold text-charcoal-900">{{ emp.area_nombre }}</div>
                  <div v-if="emp.horario_origen === 'PERSONALIZADO'" class="mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span class="px-1.5 py-0.5 rounded bg-[#18181B] text-white text-[9px] font-bold uppercase tracking-wider">Personalizado</span>
                    <span class="text-[11px] text-charcoal-600 mono-code">{{ emp.horario_resumen || emp.turno }}</span>
                  </div>
                  <div v-else-if="emp.horario_origen === 'ASIGNADO'" class="mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span class="px-1.5 py-0.5 rounded bg-charcoal-100 text-charcoal-800 text-[9px] font-bold uppercase tracking-wider">{{ emp.horario_nombre }}</span>
                    <span class="text-[11px] text-charcoal-500 mono-code">{{ emp.horario_resumen }}</span>
                  </div>
                  <div v-else-if="emp.horario_origen === 'DEFAULT'" class="text-[11px] text-charcoal-400 mt-0.5">
                    Por defecto · <span class="mono-code">{{ emp.horario_resumen || emp.turno }}</span>
                  </div>
                  <div v-else class="text-[11px] text-charcoal-400 mt-0.5">
                    Heredado · <span class="mono-code">{{ emp.horario_resumen || emp.turno }}</span>
                  </div>
                </td>
                <td class="py-4 px-4">
                  <span v-if="emp.tiene_huella" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-charcoal-900">
                    <i class="ph ph-fingerprint text-sm"></i> ACTIVA EN RELOJ
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 text-[11px] font-medium text-charcoal-400">
                    SIN REGISTRO
                  </span>
                </td>
                <td class="py-4 px-4">
                  <span v-if="emp.tiene_rostro" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-charcoal-900">
                    <i class="ph ph-scan-smiley text-sm"></i> ACTIVO EN RELOJ
                  </span>
                  <span v-else class="inline-flex items-center gap-1.5 text-[11px] font-medium text-charcoal-400">
                    SIN REGISTRO
                  </span>
                </td>
                <td class="py-4 px-4">
                  <div class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-charcoal-100 text-charcoal-800 text-[11px] font-bold">
                    <i class="ph ph-map-pin text-xs text-charcoal-500"></i>
                    <span>{{ emp.sucursal_base_nombre || 'Sin asignar' }}</span>
                  </div>
                  <div class="mono-code text-[10px] text-charcoal-400 mt-1">
                    Alta: {{ emp.reloj_asignado || 'Terminal' }}
                  </div>
                </td>
                <td class="py-4 px-6 text-right">
                  <button
                    type="button"
                    @click="openEditEmployee(emp)"
                    class="px-3.5 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white text-[11px] font-semibold transition-colors cursor-pointer">
                    <i class="ph ph-pencil-simple"></i> Editar Datos / Nombre
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- MODAL UNIFICADO: EDICIÓN DE COLABORADOR <-> CREACIÓN DE HORARIO (SE CONVIERTE EN EL MISMO MODAL AL PULSAR +) -->
      <ModalBase
        v-if="isEmpModalOpen"
        :title="isCreatingScheduleInEmpModal
          ? 'Crear Nuevo Horario / Jornada'
          : 'Ficha de Colaborador en Empresa (Sucursal Base y Horario)'"
        :subtitle="isCreatingScheduleInEmpModal
          ? 'Configura horarios fijos, parciales o mixtos con múltiples bloques por día.'
          : 'Asigna sucursal base, nombre, área, código CONTPAQi y horario operativo del colaborador.'"
        :cancelLabel="isCreatingScheduleInEmpModal ? 'Volver al Colaborador' : 'Cancelar'"
        :confirmLabel="isCreatingScheduleInEmpModal
          ? (isSavingNewSchedule ? 'Guardando...' : 'Guardar Horario')
          : (isSaving ? 'Guardando...' : 'Guardar en Catálogo RH')"
        :confirmDisabled="isCreatingScheduleInEmpModal ? isSavingNewSchedule : isSaving"
        :size="isCreatingScheduleInEmpModal ? 'wide' : 'xl'"
        :noScroll="true"
        @close="isCreatingScheduleInEmpModal ? closeCreateScheduleInEmpModal() : (isEmpModalOpen = false)"
        @confirm="isCreatingScheduleInEmpModal ? saveNewScheduleFromEmpModal() : saveEmployee()">

        <!-- VISTA 1: MODAL DEL COLABORADOR (MISMO COMPORTAMIENTO QUE EL MODAL DE ÁREA) -->
        <div v-if="!isCreatingScheduleInEmpModal" key="emp-view" class="space-y-4 text-xs animate-in fade-in duration-150">

          <!-- Fila 1: ID en Reloj + Nombre Completo + Código CONTPAQi + Sucursal Base -->
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div class="sm:col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1.5">ID en Reloj</label>
              <input
                v-model="empForm.codigo_empleado"
                type="text"
                readonly
                class="w-full h-10 px-3 rounded-xl border border-charcoal-200 mono-code font-bold bg-charcoal-100 text-charcoal-500 cursor-not-allowed focus:outline-none">
            </div>
            <div class="sm:col-span-4">
              <label class="block font-bold text-charcoal-800 mb-1.5">Nombre Completo</label>
              <input
                v-model="empForm.nombre"
                type="text"
                :placeholder="'Empleado #' + empForm.codigo_empleado"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div class="sm:col-span-3">
              <label class="block font-bold text-charcoal-800 mb-1.5">Código CONTPAQi</label>
              <input
                v-model="empForm.codigo_contpaqi"
                type="text"
                maxlength="7"
                :placeholder="'Por defecto ' + empForm.codigo_empleado"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div class="sm:col-span-3">
              <label class="block font-bold text-charcoal-800 mb-1.5">Sucursal Base</label>
              <select
                v-model="empForm.sucursal_id"
                @change="onEmpBranchChange"
                class="w-full h-10 px-3 rounded-xl border border-charcoal-200 bg-white font-bold text-charcoal-900 focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                <option v-for="b in branches" :key="b.id" :value="b.id">{{ b.nombre }}</option>
              </select>
            </div>
          </div>

          <!-- Fila 2: Área / Departamento (Selector propio) + Puesto / Cargo + Horario (Selector propio + Vista + [+]) -->
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 items-start">

            <!-- Selector Propio de Área / Departamento -->
            <div class="sm:col-span-4 relative" data-emp-area-dropdown>
              <label class="block font-bold text-charcoal-800 mb-1.5">Área / Departamento</label>
              <button
                type="button"
                @click="toggleEmpAreaDropdown($event)"
                class="w-full h-10 px-3.5 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between gap-2"
                :class="isEmpAreaDropdownOpen
                  ? 'bg-charcoal-50 border-charcoal-900 ring-2 ring-charcoal-900/10'
                  : 'bg-white hover:bg-charcoal-50 border-charcoal-200 hover:border-charcoal-300'">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-4 flex items-center justify-center shrink-0">
                    <i class="ph ph-buildings text-sm text-charcoal-400"></i>
                  </span>
                  <span class="font-bold text-charcoal-900 truncate">{{ empForm.area_nombre || 'General' }}</span>
                </div>
                <i
                  class="ph ph-caret-down text-xs text-charcoal-400 transition-transform duration-200 shrink-0"
                  :class="{ 'rotate-180 text-charcoal-900': isEmpAreaDropdownOpen }"></i>
              </button>

              <div
                v-if="isEmpAreaDropdownOpen"
                @click.stop
                class="absolute left-0 right-0 top-full mt-1.5 bg-white rounded-2xl border border-charcoal-200 shadow-2xl overflow-hidden z-50 flex flex-col">
                <div class="p-1.5 max-h-56 overflow-y-auto space-y-1">
                  <button
                    v-for="a in modalAreas"
                    :key="a.id"
                    type="button"
                    @click="selectEmpArea(a.nombre, $event)"
                    class="w-full text-left px-3 py-2 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2"
                    :class="empForm.area_nombre === a.nombre
                      ? 'bg-[#18181B] text-white'
                      : 'hover:bg-charcoal-50 text-charcoal-800'">
                    <div class="min-w-0">
                      <div class="font-bold text-xs truncate">{{ a.nombre }}</div>
                      <div
                        class="text-[10px] mono-code truncate"
                        :class="empForm.area_nombre === a.nombre ? 'text-white/75' : 'text-charcoal-400'">
                        {{ a.horario_nombre || a.turno }} · {{ a.horario_resumen || a.horario }}
                      </div>
                    </div>
                    <i v-if="empForm.area_nombre === a.nombre" class="ph ph-check text-sm text-white shrink-0"></i>
                  </button>
                </div>
              </div>
            </div>

            <!-- Puesto / Cargo -->
            <div class="sm:col-span-3">
              <label class="block font-bold text-charcoal-800 mb-1.5">Puesto / Cargo</label>
              <input
                v-model="empForm.puesto"
                type="text"
                placeholder="Ej: Supervisor"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <!-- Selector Propio de Horario + Botón Vista [ph-eye] + Botón Crear [+] -->
            <div class="sm:col-span-5">
              <label class="block font-bold text-charcoal-800 mb-1.5">Horario del Colaborador</label>
              <div class="flex items-center gap-2">
                <!-- Selector propio de horario -->
                <div class="relative flex-1 min-w-0" data-emp-schedule-dropdown>
                  <button
                    type="button"
                    @click="toggleEmpScheduleDropdown($event)"
                    class="w-full h-10 px-3.5 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between gap-2"
                    :class="isEmpScheduleDropdownOpen
                      ? 'bg-charcoal-50 border-charcoal-900 ring-2 ring-charcoal-900/10'
                      : 'bg-white hover:bg-charcoal-50 border-charcoal-200 hover:border-charcoal-300'">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="w-4 flex items-center justify-center shrink-0">
                        <i class="ph ph-clock-user text-sm text-charcoal-400"></i>
                      </span>
                      <span class="font-bold text-charcoal-900 truncate">
                        {{ empForm.horario_mode === 'area'
                          ? ('Heredar del Área (' + (activePreviewSchedule?.nombre || selectedAreaInfo?.horario_nombre || 'Matutino') + ')')
                          : (activePreviewSchedule?.nombre || 'Horario Matutino') }}
                      </span>
                    </div>
                    <i
                      class="ph ph-caret-down text-xs text-charcoal-400 transition-transform duration-200 shrink-0"
                      :class="{ 'rotate-180 text-charcoal-900': isEmpScheduleDropdownOpen }"></i>
                  </button>

                  <!-- Panel Desplegable Propio de Horarios -->
                  <div
                    v-if="isEmpScheduleDropdownOpen"
                    @click.stop
                    class="absolute left-0 right-0 top-full mt-1.5 bg-white rounded-2xl border border-charcoal-200 shadow-2xl overflow-hidden z-50 flex flex-col">
                    <div class="p-1.5 max-h-56 overflow-y-auto space-y-1">
                      <!-- Opción 1: Heredar del Área -->
                      <button
                        type="button"
                        @click="selectInheritAreaSchedule($event)"
                        class="w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2"
                        :class="empForm.horario_mode === 'area'
                          ? 'bg-[#18181B] text-white'
                          : 'hover:bg-charcoal-50 text-charcoal-800'">
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="font-bold text-xs truncate">
                              Heredar horario de {{ empForm.area_nombre || 'su Área' }}
                            </span>
                            <span
                              class="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
                              :class="empForm.horario_mode === 'area'
                                ? 'bg-white/15 text-white'
                                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'">
                              Por área
                            </span>
                          </div>
                          <div
                            class="text-[10px] mono-code mt-0.5 truncate"
                            :class="empForm.horario_mode === 'area' ? 'text-white/75' : 'text-charcoal-500'">
                            {{ selectedAreaInfo?.horario_nombre || defaultBranchSchedule?.nombre || 'Matutino' }} · {{ selectedAreaInfo?.horario_resumen || defaultBranchSchedule?.resumen_corto || '08:00-17:00' }}
                          </div>
                        </div>
                        <i v-if="empForm.horario_mode === 'area'" class="ph ph-check text-sm text-white shrink-0"></i>
                      </button>

                      <div class="border-t border-charcoal-100 my-1"></div>

                      <!-- Opciones del Catálogo de Horarios de la Sucursal -->
                      <button
                        v-for="s in modalSchedules"
                        :key="s.id"
                        type="button"
                        @click="selectEmpTemplateSchedule(s, $event)"
                        class="w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2"
                        :class="(empForm.horario_mode === 'plantilla' && Number(empForm.horario_id) === Number(s.id))
                          ? 'bg-[#18181B] text-white'
                          : 'hover:bg-charcoal-50 text-charcoal-800'">
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="font-bold text-xs truncate">{{ s.nombre }}</span>
                            <span
                              class="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider mono-code"
                              :class="(empForm.horario_mode === 'plantilla' && Number(empForm.horario_id) === Number(s.id))
                                ? 'bg-white/15 text-white'
                                : 'bg-charcoal-100 text-charcoal-700'">
                              {{ s.es_mixto ? 'Mixto' : 'Fijo' }}
                            </span>
                          </div>
                          <div
                            class="text-[10px] mono-code mt-0.5 truncate"
                            :class="(empForm.horario_mode === 'plantilla' && Number(empForm.horario_id) === Number(s.id)) ? 'text-white/75' : 'text-charcoal-500'">
                            {{ s.resumen_corto }} · {{ s.horas_semanales }}h/sem · {{ s.tolerancia_min }}m tol.
                          </div>
                        </div>
                        <i
                          v-if="empForm.horario_mode === 'plantilla' && Number(empForm.horario_id) === Number(s.id)"
                          class="ph ph-check text-sm text-white shrink-0"></i>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- Botón de Vista [ph-eye]: Ver detalle del horario seleccionado -->
                <button
                  type="button"
                  @click="toggleScheduleDetailView($event)"
                  :title="isScheduleDetailVisible ? 'Ocultar detalle del horario' : 'Ver detalle del horario seleccionado'"
                  class="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                  :class="isScheduleDetailVisible
                    ? 'bg-charcoal-900 text-white border-charcoal-900'
                    : 'bg-white hover:bg-charcoal-100 text-charcoal-700 border-charcoal-200'">
                  <i :class="['ph text-base', isScheduleDetailVisible ? 'ph-eye-slash' : 'ph-eye']"></i>
                </button>

                <!-- Botón [+] a un lado: convierte este mismo modal en el creador de horario -->
                <button
                  type="button"
                  @click="openCreateScheduleInEmpModal($event)"
                  title="Crear nuevo horario"
                  class="w-10 h-10 rounded-xl bg-[#18181B] hover:bg-black text-white flex items-center justify-center shrink-0 cursor-pointer transition-colors shadow-2xs">
                  <i class="ph ph-plus text-base"></i>
                </button>
              </div>
              <p class="text-[11px] text-charcoal-400 mt-1">
                Elige un horario, pulsa el icono de <b>vista</b> para ver su desglose o <b>+</b> para crear uno nuevo.
              </p>
            </div>
          </div>

          <!-- Panel Desplegable de Vista de Detalle del Horario Seleccionado (al pulsar el botón de vista) -->
          <div
            v-if="isScheduleDetailVisible && activePreviewSchedule"
            class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-3 animate-in fade-in duration-150">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="w-5 flex items-center justify-center shrink-0">
                  <i class="ph ph-calendar-check text-base text-charcoal-400"></i>
                </span>
                <span class="font-bold text-charcoal-900">{{ activePreviewSchedule.nombre }}</span>
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mono-code"
                  :class="activePreviewSchedule.es_mixto ? 'bg-[#18181B] text-white' : 'bg-white border border-charcoal-200 text-charcoal-700'">
                  {{ activePreviewSchedule.es_mixto ? 'Mixto / Parcial' : 'Fijo' }}
                </span>
                <span v-if="empForm.horario_mode === 'area'" class="text-[11px] text-charcoal-500">
                  (Heredado del área {{ empForm.area_nombre }})
                </span>
              </div>
              <div class="flex items-center gap-2 mono-code text-[11px]">
                <span class="font-bold text-charcoal-900">{{ activePreviewSchedule.horas_semanales }}h / sem</span>
                <span class="text-charcoal-300">·</span>
                <span class="font-bold text-emerald-700">{{ activePreviewSchedule.tolerancia_min }} min tolerancia</span>
              </div>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <div
                v-for="d in WEEK_DAYS"
                :key="'emp-preview-' + d.num"
                class="p-2.5 rounded-xl border text-center flex flex-col justify-between min-h-[60px]"
                :class="formatDayBlocksSummary(activePreviewSchedule, d.num) === 'Descanso'
                  ? 'bg-charcoal-50/70 border-charcoal-200/60 text-charcoal-400'
                  : 'bg-white border-charcoal-200 text-charcoal-900 shadow-2xs'">
                <span class="text-[10px] font-bold uppercase tracking-wider block">{{ d.label }}</span>
                <span class="text-[10px] mono-code font-bold leading-tight mt-1 block">
                  {{ formatDayBlocksSummary(activePreviewSchedule, d.num) }}
                </span>
              </div>
            </div>
          </div>

          <div class="p-3.5 rounded-2xl bg-offwhite border border-charcoal-200/80 text-[11px] text-charcoal-600 flex items-center gap-2.5">
            <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-fingerprint text-lg text-charcoal-400"></i></span>
            <span>
              Los colaboradores pertenecen a la empresa. Su <b>Sucursal Base</b> define su adscripción y área, pero pueden checar en cualquier reloj de otra sucursal donde hayas dado de alta el mismo <b>ID en Reloj</b>.
            </span>
          </div>
        </div>

        <!-- VISTA 2: MODAL DE CREACIÓN DE HORARIO (EL MISMO MODAL SE CONVIERTE AQUÍ AL PULSAR +) -->
        <div v-else key="emp-schedule-creator" class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start text-xs animate-in fade-in duration-150">

          <!-- COLUMNA IZQUIERDA (4 cols): IDENTIFICACIÓN Y SLIDER DE TOLERANCIA -->
          <div class="lg:col-span-4 space-y-3.5">
            <div class="p-4 rounded-3xl bg-white border border-charcoal-200 space-y-3.5">
              <div class="flex items-center gap-3 pb-2.5 border-b border-charcoal-100">
                <span class="w-5 flex items-center justify-center shrink-0">
                  <i class="ph ph-calendar-check text-lg text-charcoal-400"></i>
                </span>
                <div>
                  <span class="text-[11px] font-bold uppercase tracking-wider text-charcoal-400 block">
                    Datos del Horario
                  </span>
                  <span class="text-[11px] text-charcoal-500">
                    Nombre identificador en áreas y empleados
                  </span>
                </div>
              </div>

              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Nombre del Horario *</label>
                <input
                  v-model="newScheduleForm.nombre"
                  type="text"
                  placeholder="Ej: Mixto Partido Sistemas"
                  class="w-full h-9 px-3.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              </div>

              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Descripción / Referencia (Opcional)</label>
                <input
                  v-model="newScheduleForm.descripcion"
                  type="text"
                  placeholder="Ej: L-M-V partido 8-11 y 15-18, M-J tarde"
                  class="w-full h-9 px-3.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              </div>
            </div>

            <!-- Slider único de Tolerancia de Entrada -->
            <div class="p-4 rounded-3xl bg-white border border-charcoal-200 space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-3">
                  <span class="w-5 flex items-center justify-center shrink-0">
                    <i class="ph ph-clock-countdown text-lg text-charcoal-400"></i>
                  </span>
                  <div>
                    <span class="text-[11px] font-bold uppercase tracking-wider text-charcoal-400 block">
                      Tolerancia de Entrada
                    </span>
                    <span class="text-[11px] text-charcoal-500">
                      Desliza para definir el margen sin retardo
                    </span>
                  </div>
                </div>
                <span class="px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 mono-code font-bold text-xs shrink-0">
                  {{ newScheduleForm.tolerancia_min }} min
                </span>
              </div>

              <div class="pt-1 space-y-1.5">
                <input
                  type="range"
                  min="0"
                  max="60"
                  step="1"
                  :value="newScheduleForm.tolerancia_min"
                  @input="setNewScheduleTolerance($event.target.value)"
                  :style="{
                    background: 'linear-gradient(to right, #18181B 0%, #18181B ' + Math.min(100, Math.round((Number(newScheduleForm.tolerancia_min || 0) / 60) * 100)) + '%, #E4E4E7 ' + Math.min(100, Math.round((Number(newScheduleForm.tolerancia_min || 0) / 60) * 100)) + '%, #E4E4E7 100%)'
                  }"
                  class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
                <div class="flex items-center justify-between text-[10px] mono-code font-semibold text-charcoal-400">
                  <span>0 min</span>
                  <span>15 min</span>
                  <span>30 min</span>
                  <span>45 min</span>
                  <span>60 min</span>
                </div>
              </div>
            </div>

            <!-- Nota informativa de reglas de asistencia -->
            <div class="p-3.5 rounded-3xl bg-offwhite border border-charcoal-200/80 space-y-1.5 text-[11px] text-charcoal-600">
              <div class="font-semibold text-charcoal-900 flex items-center gap-3">
                <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-info text-lg text-charcoal-400"></i></span>
                <span>Motor de Jornadas Mixtas y Partidas</span>
              </div>
              <p class="leading-relaxed">
                Activa cualquier día y pulsa <b>+ Bloque</b> para turnos partidos. El sistema contabiliza máximo 1 retardo por día y reporta las horas reales trabajadas.
              </p>
            </div>
          </div>

          <!-- COLUMNA DERECHA (8 cols): MATRIZ SEMANAL COMPACTA SIN SCROLL -->
          <div class="lg:col-span-8">
            <ScheduleBlocksEditor v-model="newScheduleForm.bloques" />
          </div>

        </div>
      </ModalBase>

      <!-- MODAL: IMPORTAR / PLANTILLA CSV (DISTRIBUCIÓN HORIZONTAL 2 COLUMNAS) -->
      <ModalBase
        v-if="isCsvModalOpen"
        title="Importar / Actualizar Catálogo por CSV"
        subtitle="Edita masivamente nombres, códigos CONTPAQi, áreas, puestos y turnos desde Excel."
        size="xl"
        :hideConfirm="true"
        cancelLabel="Cerrar"
        @close="isCsvModalOpen = false">

        <div class="space-y-4 text-xs">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
            <!-- Paso 1: Descargar plantilla pre-llenada -->
            <div class="p-5 rounded-3xl bg-offwhite border border-charcoal-200 flex flex-col justify-between space-y-4">
              <div class="flex items-start gap-3">
                <span class="w-6 h-6 rounded-full bg-[#18181B] text-white text-[11px] font-bold flex items-center justify-center shrink-0">1</span>
                <div class="space-y-1.5">
                  <h4 class="font-bold text-charcoal-900 text-xs">Descargar Plantilla Pre-llenada</h4>
                  <p class="text-[11px] text-charcoal-500 leading-relaxed">
                    Incluye todos los colaboradores actuales de esta sucursal (incluyendo los auto-descubiertos como <span class="mono-code">Empleado #ID</span>). Ábrelo en Excel, completa sus nombres y códigos CONTPAQi, y guarda el archivo CSV.
                  </p>
                </div>
              </div>
              <button
                type="button"
                :disabled="isDownloadingTemplate"
                @click="downloadTemplateCsv"
                class="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-charcoal-100 border border-charcoal-300 text-charcoal-900 font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 transition-colors">
                <i :class="['ph text-base', isDownloadingTemplate ? 'ph-spinner animate-spin' : 'ph-download-simple']"></i>
                <span>{{ isDownloadingTemplate ? 'Generando plantilla...' : '1. Descargar Plantilla Actual (.csv)' }}</span>
              </button>
            </div>

            <!-- Paso 2: Subir y actualizar -->
            <div class="p-5 rounded-3xl bg-white border border-charcoal-200 flex flex-col justify-between space-y-4">
              <div class="space-y-3">
                <div class="flex items-start gap-3">
                  <span class="w-6 h-6 rounded-full bg-[#18181B] text-white text-[11px] font-bold flex items-center justify-center shrink-0">2</span>
                  <div class="space-y-1.5">
                    <h4 class="font-bold text-charcoal-900 text-xs">Subir CSV Actualizado</h4>
                    <p class="text-[11px] text-charcoal-500 leading-relaxed">
                      Compatible con CSV separado por comas (<span class="mono-code">,</span>) o punto y coma (<span class="mono-code">;</span>). Al importar, los nombres y áreas se propagan automáticamente al historial de checadas.
                    </p>
                  </div>
                </div>

                <input
                  ref="csvFileInputRef"
                  type="file"
                  accept=".csv,text/csv"
                  @change="onCsvFileChange"
                  class="w-full text-xs text-charcoal-700 file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-charcoal-100 file:text-charcoal-800 hover:file:bg-charcoal-200 cursor-pointer border border-charcoal-200 rounded-xl p-1.5 bg-offwhite"
                />
              </div>

              <button
                type="button"
                :disabled="isUploadingCsv || !selectedCsvFile"
                @click="uploadCsvFile"
                class="w-full py-2.5 px-4 rounded-xl bg-[#18181B] hover:bg-black text-white font-bold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 transition-colors">
                <i :class="['ph text-base', isUploadingCsv ? 'ph-spinner animate-spin' : 'ph-upload-simple']"></i>
                <span>{{ isUploadingCsv ? 'Procesando archivo...' : '2. Subir y Actualizar Catálogo' }}</span>
              </button>
            </div>
          </div>

          <!-- Error -->
          <div v-if="csvImportError" class="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
            <i class="ph ph-warning-circle text-base text-rose-600 shrink-0 mt-0.5"></i>
            <span class="font-medium">{{ csvImportError }}</span>
          </div>

          <!-- Resumen de importación -->
          <div v-if="csvImportResult" class="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-900 space-y-2">
            <div class="flex items-center gap-2 font-bold">
              <i class="ph ph-check-circle text-lg text-emerald-600"></i>
              <span>Importación Exitosa</span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
              <div class="p-2.5 rounded-xl bg-white border border-emerald-200/80">
                <div class="text-[10px] uppercase font-bold text-charcoal-400">Actualizados</div>
                <div class="text-base font-black mono-code text-charcoal-900">{{ csvImportResult.updated_employees || 0 }}</div>
              </div>
              <div class="p-2.5 rounded-xl bg-white border border-emerald-200/80">
                <div class="text-[10px] uppercase font-bold text-charcoal-400">Nuevos Creados</div>
                <div class="text-base font-black mono-code text-charcoal-900">{{ csvImportResult.created_employees || 0 }}</div>
              </div>
              <div class="p-2.5 rounded-xl bg-white border border-emerald-200/80 col-span-2 sm:col-span-1">
                <div class="text-[10px] uppercase font-bold text-charcoal-400">Checadas Act.</div>
                <div class="text-base font-black mono-code text-emerald-700">{{ csvImportResult.updated_checkins || 0 }}</div>
              </div>
            </div>
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
