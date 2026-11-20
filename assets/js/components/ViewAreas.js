// Component: ViewAreas (Módulo de Empresa, Sucursales, Áreas/Turnos y Acceso RH)
// Centraliza la gestión de Empresas, Sucursales, Áreas/Turnos/Horarios y Clave Dinámica TOTP (5 min)

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import ModalBase from './ModalBase.js';
import ScheduleBlocksEditor from './ScheduleBlocksEditor.js';
import { confirmDialog } from './ModalConfirm.js';

export default {
  name: 'ViewAreas',
  components: { ModalBase, ScheduleBlocksEditor },
  props: {
    areas: { type: Array, default: () => [] },
    schedules: { type: Array, default: () => [] },
    companies: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: 1 },
    sucursalId: { type: [Number, String, null], default: 1 },
    initialSection: { type: String, default: 'empresas' } // 'empresas' | 'areas' | 'horarios' | 'invitar' | 'unirse' | 'nueva_empresa'
  },
  emits: ['refresh', 'toast', 'select-scope', 'refresh-companies'],
  setup(props, { emit }) {
    const activeSection = ref('empresas');
    const feedback = ref({ type: '', message: '' });

    // ==========================================
    // SECCIÓN 1: EMPRESAS, SUCURSALES Y CLAVE TOTP
    // ==========================================
    const totpData = ref({
      codigo_invitacion: '',
      clave_dinamica: '------',
      clave_formateada: '--- ---',
      expires_in_seconds: 300,
      window_seconds: 300
    });
    const isLoadingTotp = ref(false);
    const isTotpVisible = ref(false);
    const isRemovingMember = ref(null);
    let totpCountdownTimer = null;

    const joinForm = ref({
      codigo_invitacion: '',
      clave_dinamica: ''
    });
    const isJoining = ref(false);

    const newCompForm = ref({
      nombre: '',
      rfc: '',
      industria: 'Manufactura y Operaciones',
      sucursal_inicial: 'Sucursal Matriz'
    });
    const isCreatingComp = ref(false);

    const isAddingBranch = ref(false);
    const newBranchForm = ref({
      nombre: '',
      ubicacion: '',
      codigo: '',
      debounce_seconds: 180,
      tolerancia_minutos: 10
    });

    const activeCompany = computed(() => {
      return props.companies.find(c => c.id === props.empresaId) || props.companies[0] || null;
    });

    const activeBranch = computed(() => {
      const sucs = activeCompany.value?.sucursales || [];
      return sucs.find(s => s.id === props.sucursalId) || sucs[0] || null;
    });

    const formattedCountdown = computed(() => {
      const sec = Math.max(0, Number(totpData.value.expires_in_seconds || 0));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    });

    const countdownProgressPct = computed(() => {
      const total = Number(totpData.value.window_seconds || 300);
      const rem = Math.max(0, Number(totpData.value.expires_in_seconds || 0));
      return Math.min(100, Math.round((rem / total) * 100));
    });

    function setSection(section) {
      feedback.value = { type: '', message: '' };
      if (section === 'crear' || section === 'nueva_empresa') {
        activeSection.value = 'nueva_empresa';
      } else if (section === 'agregar_sucursal') {
        activeSection.value = 'empresas';
        isAddingBranch.value = true;
      } else if (section === 'selector' || section === 'empresas') {
        activeSection.value = 'empresas';
      } else if (section === 'invitar' || section === 'unirse' || section === 'equipo') {
        activeSection.value = 'invitar';
      } else if (section === 'areas') {
        activeSection.value = 'areas';
      } else if (section === 'horarios' || section === 'schedules') {
        activeSection.value = 'horarios';
      } else {
        activeSection.value = 'empresas';
      }
    }

    async function fetchInviteTotp() {
      if (!activeCompany.value || !activeCompany.value.is_owner) return false;
      isLoadingTotp.value = true;
      try {
        const res = await fetch(`/api/companies/${activeCompany.value.id}/invite-totp`);
        const data = await res.json();
        if (!res.ok) {
          feedback.value = { type: 'error', message: data.detail || 'No se pudo generar la clave dinámica.' };
          return false;
        }
        if (data.invitation) {
          totpData.value = data.invitation;
        }
        return true;
      } catch (e) {
        console.error(e);
        feedback.value = { type: 'error', message: 'Error de conexión al generar la clave dinámica.' };
        return false;
      } finally {
        isLoadingTotp.value = false;
      }
    }

    function startTotpTimer() {
      stopTotpTimer();
      totpCountdownTimer = setInterval(() => {
        if (!isTotpVisible.value) {
          stopTotpTimer();
          return;
        }
        if (totpData.value.expires_in_seconds > 1) {
          totpData.value.expires_in_seconds -= 1;
        } else {
          fetchInviteTotp();
        }
      }, 1000);
    }

    function stopTotpTimer() {
      if (totpCountdownTimer) {
        clearInterval(totpCountdownTimer);
        totpCountdownTimer = null;
      }
    }

    async function requestInviteTotp() {
      if (!activeCompany.value || !activeCompany.value.is_owner) return;
      feedback.value = { type: '', message: '' };
      isTotpVisible.value = true;
      const ok = await fetchInviteTotp();
      if (ok && isTotpVisible.value) {
        startTotpTimer();
      } else if (!ok) {
        hideInviteTotp();
      }
    }

    function hideInviteTotp() {
      stopTotpTimer();
      isTotpVisible.value = false;
    }

    async function removeMember(member) {
      if (!activeCompany.value || !activeCompany.value.is_owner || !member || member.rol_empresa === 'OWNER') return;
      const ok = await confirmDialog({
        title: '¿Revocar acceso del miembro?',
        message: `Se retirará el acceso de ${member.nombre} (${member.email}) de la empresa "${activeCompany.value.nombre}".`,
        detail: 'Podrá volver a unirse únicamente si le proporcionas una nueva clave dinámica.',
        variant: 'danger',
        confirmLabel: 'Revocar acceso'
      });
      if (!ok) return;

      isRemovingMember.value = member.id;
      feedback.value = { type: '', message: '' };
      try {
        const res = await fetch(`/api/companies/${activeCompany.value.id}/members/${member.id}`, {
          method: 'DELETE'
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Acceso del miembro revocado correctamente');
          emit('refresh-companies', { empresaId: activeCompany.value.id });
        } else {
          feedback.value = { type: 'error', message: data.detail || 'No se pudo revocar el acceso.' };
        }
      } catch (e) {
        feedback.value = { type: 'error', message: 'Error de conexión con el servidor.' };
      } finally {
        isRemovingMember.value = null;
      }
    }

    watch([activeSection, () => props.empresaId], () => {
      stopTotpTimer();
      isTotpVisible.value = false;
    });

    onMounted(() => {
      if (props.initialSection) {
        setSection(props.initialSection);
      }
    });

    onUnmounted(() => {
      stopTotpTimer();
    });

    function selectCompanyAndBranch(compId, branchId) {
      emit('select-scope', { empresaId: compId, sucursalId: branchId });
    }

    function configureBranchAreas(compId, branchId) {
      emit('select-scope', { empresaId: compId, sucursalId: branchId });
      activeSection.value = 'areas';
    }

    async function copyInviteCredentials() {
      const text = `Empresa: ${activeCompany.value?.nombre}\nCódigo de Invitación: ${totpData.value.codigo_invitacion}\nClave Dinámica (5 min): ${totpData.value.clave_dinamica}`;
      try {
        await navigator.clipboard.writeText(text);
        emit('toast', 'Código de invitación y Clave Dinámica copiados al portapapeles');
      } catch (e) {
        emit('toast', 'Copiado: ' + totpData.value.clave_dinamica);
      }
    }

    async function submitJoinCompany() {
      if (!joinForm.value.codigo_invitacion || !joinForm.value.clave_dinamica) {
        feedback.value = { type: 'error', message: 'Ingresa tanto el Código de Invitación como la Clave Dinámica de 6 dígitos.' };
        return;
      }
      isJoining.value = true;
      feedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/companies/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(joinForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Unido a la empresa exitosamente');
          emit('refresh-companies', { empresaId: data.empresa_id });
          joinForm.value = { codigo_invitacion: '', clave_dinamica: '' };
          activeSection.value = 'empresas';
        } else {
          feedback.value = { type: 'error', message: data.detail || 'No se pudo validar la invitación.' };
        }
      } catch (e) {
        feedback.value = { type: 'error', message: 'Error de conexión con el servidor.' };
      } finally {
        isJoining.value = false;
      }
    }

    async function submitCreateCompany() {
      if (!newCompForm.value.nombre.trim()) {
        feedback.value = { type: 'error', message: 'El nombre de la empresa es obligatorio.' };
        return;
      }
      isCreatingComp.value = true;
      feedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newCompForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Empresa creada con éxito');
          emit('refresh-companies', {
            empresaId: data.company?.empresa_id,
            sucursalId: data.company?.sucursal_id
          });
          newCompForm.value = { nombre: '', rfc: '', industria: 'Manufactura y Operaciones', sucursal_inicial: 'Sucursal Matriz' };
          activeSection.value = 'empresas';
        } else {
          feedback.value = { type: 'error', message: data.detail || 'Error al crear la empresa.' };
        }
      } catch (e) {
        feedback.value = { type: 'error', message: 'Error de red.' };
      } finally {
        isCreatingComp.value = false;
      }
    }

    async function submitCreateBranch() {
      if (!newBranchForm.value.nombre.trim() || !activeCompany.value) {
        feedback.value = { type: 'error', message: 'El nombre de la sucursal es obligatorio.' };
        return;
      }
      try {
        const res = await fetch('/api/branches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            empresa_id: activeCompany.value.id,
            ...newBranchForm.value
          })
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Sucursal creada');
          isAddingBranch.value = false;
          newBranchForm.value = { nombre: '', ubicacion: '', codigo: '', debounce_seconds: 180, tolerancia_minutos: 10 };
          emit('refresh-companies', {
            empresaId: activeCompany.value.id,
            sucursalId: data.branch?.id
          });
        } else {
          feedback.value = { type: 'error', message: data.detail || 'Error al crear sucursal.' };
        }
      } catch (e) {
        feedback.value = { type: 'error', message: 'Error de red.' };
      }
    }

    // ==========================================
    // SECCIÓN 2: ÁREAS, TURNOS Y DÍAS LABORALES
    // ==========================================
    const WEEK_DAYS = [
      { num: '1', label: 'Lun' },
      { num: '2', label: 'Mar' },
      { num: '3', label: 'Mié' },
      { num: '4', label: 'Jue' },
      { num: '5', label: 'Vie' },
      { num: '6', label: 'Sáb' },
      { num: '7', label: 'Dom' }
    ];

    const isModalOpen = ref(false);
    const isReapplyingRules = ref(false);
    const isAreaScheduleDropdownOpen = ref(false);
    const isAreaScheduleDetailVisible = ref(false);
    const TOLERANCE_PRESETS = [0, 5, 10, 15, 20, 30];

    const form = ref({
      id: null,
      codigo: '',
      nombre: '',
      responsable: '',
      turno: 'Matutino',
      horario_id: null,
      horario: '08:00 - 17:00',
      tolerancia_min: 10,
      dias_laborales: '1,2,3,4,5',
      prefijo_id: '',
      ubicacion: 'Sucursal Activa'
    });

    const defaultBranchScheduleId = computed(() => {
      const list = props.schedules || [];
      if (!list.length) return null;
      const mat = list.find(s => String(s.nombre || '').toLowerCase().includes('matutino'));
      return Number((mat || list[0]).id);
    });

    const justSavedSchedule = ref(null);

    const selectedAreaSchedule = computed(() => {
      const list = props.schedules || [];
      if (form.value.horario_id && form.value.horario_id !== '__simple__') {
        const found = list.find(s => Number(s.id) === Number(form.value.horario_id));
        if (found) return found;
        if (justSavedSchedule.value && Number(justSavedSchedule.value.id) === Number(form.value.horario_id)) {
          return justSavedSchedule.value;
        }
      }
      if (!list.length) return justSavedSchedule.value || null;
      return list.find(s => Number(s.id) === Number(defaultBranchScheduleId.value)) || list[0] || null;
    });

    function toggleAreaScheduleDropdown(event) {
      if (event) event.stopPropagation();
      isAreaScheduleDropdownOpen.value = !isAreaScheduleDropdownOpen.value;
    }

    function toggleAreaScheduleDetail(event) {
      if (event) event.stopPropagation();
      isAreaScheduleDropdownOpen.value = false;
      isAreaScheduleDetailVisible.value = !isAreaScheduleDetailVisible.value;
    }

    function selectAreaSchedule(s, event) {
      if (event) event.stopPropagation();
      if (!s) return;
      form.value.horario_id = Number(s.id);
      form.value.turno = s.nombre || 'Matutino';
      form.value.tolerancia_min = s.tolerancia_min ?? 10;
      isAreaScheduleDropdownOpen.value = false;
    }

    function handleGlobalClickAreaDropdown(e) {
      if (!isAreaScheduleDropdownOpen.value) return;
      const inside = e.target.closest && e.target.closest('[data-area-schedule-dropdown]');
      if (!inside) {
        isAreaScheduleDropdownOpen.value = false;
      }
    }

    onMounted(() => window.addEventListener('click', handleGlobalClickAreaDropdown));
    onUnmounted(() => window.removeEventListener('click', handleGlobalClickAreaDropdown));

    // ==========================================
    // SECCIÓN 2B: CATÁLOGO DE HORARIOS FLEXIBLES
    // ==========================================
    const isScheduleModalOpen = ref(false);
    const isSavingSchedule = ref(false);
    const returnToAreaModal = ref(false);
    const scheduleForm = ref({
      id: null,
      nombre: '',
      descripcion: '',
      tolerancia_min: 10,
      bloques: []
    });

    function setScheduleTolerance(val) {
      const clamped = Math.max(0, Math.min(180, Math.round(Number(val) || 0)));
      scheduleForm.value.tolerancia_min = clamped;
    }

    function stepScheduleTolerance(delta) {
      setScheduleTolerance((Number(scheduleForm.value.tolerancia_min) || 0) + delta);
    }

    function defaultStandardBlocks() {
      return [1, 2, 3, 4, 5].map(d => ({
        dia_semana: d,
        orden_bloque: 1,
        hora_entrada: '08:00',
        hora_salida: '17:00'
      }));
    }

    function openNewSchedule(fromAreaModal = false) {
      if (!fromAreaModal) {
        activeSection.value = 'horarios';
        returnToAreaModal.value = false;
      }
      isAreaScheduleDropdownOpen.value = false;
      scheduleForm.value = {
        id: null,
        nombre: '',
        descripcion: '',
        tolerancia_min: 10,
        bloques: defaultStandardBlocks()
      };
      if (fromAreaModal && isModalOpen.value) {
        returnToAreaModal.value = true;
        isModalOpen.value = false;
      }
      isScheduleModalOpen.value = true;
    }

    function openNewScheduleFromArea(event) {
      if (event) event.stopPropagation();
      openNewSchedule(true);
    }

    function editSchedule(s, event) {
      if (event) event.stopPropagation();
      if (!s) return;
      isAreaScheduleDropdownOpen.value = false;
      const cameFromArea = Boolean(isModalOpen.value);
      scheduleForm.value = {
        id: s.id,
        nombre: s.nombre || '',
        descripcion: s.descripcion || '',
        tolerancia_min: s.tolerancia_min ?? 10,
        bloques: (s.bloques || []).map(b => ({
          dia_semana: Number(b.dia_semana),
          orden_bloque: Number(b.orden_bloque || 1),
          hora_entrada: String(b.hora_entrada || '08:00').slice(0, 5),
          hora_salida: String(b.hora_salida || '17:00').slice(0, 5)
        }))
      };
      if (cameFromArea) {
        returnToAreaModal.value = true;
        isModalOpen.value = false;
      } else {
        returnToAreaModal.value = false;
      }
      isScheduleModalOpen.value = true;
    }

    function closeScheduleModal() {
      isScheduleModalOpen.value = false;
      if (returnToAreaModal.value) {
        returnToAreaModal.value = false;
        isModalOpen.value = true;
      }
    }

    async function saveSchedule() {
      if (!scheduleForm.value.nombre.trim()) {
        emit('toast', 'El nombre del horario es obligatorio', 'error');
        return;
      }
      isSavingSchedule.value = true;
      try {
        const res = await fetch('/api/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...scheduleForm.value,
            es_plantilla: 1,
            empresa_id: props.empresaId,
            sucursal_id: props.sucursalId
          })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          emit('toast', data.message || 'Horario guardado correctamente');
          if (data.schedule && data.schedule.id) {
            justSavedSchedule.value = data.schedule;
            if (returnToAreaModal.value || isModalOpen.value) {
              form.value.horario_id = Number(data.schedule.id);
              form.value.turno = data.schedule.nombre || form.value.turno;
              form.value.tolerancia_min = data.schedule.tolerancia_min ?? form.value.tolerancia_min;
            }
          }
          isScheduleModalOpen.value = false;
          if (returnToAreaModal.value) {
            returnToAreaModal.value = false;
            isModalOpen.value = true;
          }
          emit('refresh');
        } else {
          emit('toast', data.detail || 'No se pudo guardar el horario', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al guardar el horario', 'error');
      } finally {
        isSavingSchedule.value = false;
      }
    }

    async function deleteSchedule(s) {
      const ok = await confirmDialog({
        title: '¿Eliminar esta plantilla de horario?',
        message: `Se eliminará "${s.nombre}" de la sucursal.`,
        detail: s.empleados_count > 0
          ? `${s.empleados_count} colaborador(es) asignados pasarán automáticamente a heredar el horario de su área.`
          : 'Esta acción no se puede deshacer.',
        variant: 'danger',
        confirmLabel: 'Eliminar horario'
      });
      if (!ok) return;
      try {
        const res = await fetch(`/api/schedules/${s.id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          emit('toast', data.message || `Horario '${s.nombre}' eliminado`);
          emit('refresh');
        } else {
          emit('toast', data.detail || 'No se pudo eliminar el horario', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al eliminar el horario', 'error');
      }
    }

    function formatDayBlocksSummary(s, dayNum) {
      const list = (s?.bloques_por_dia && s.bloques_por_dia[String(dayNum)]) || [];
      if (!list.length) return 'Descanso';
      return list.map(b => `${b.hora_entrada}-${b.hora_salida}`).join(', ');
    }

    function isWorkDaySelected(dayNum) {
      const list = String(form.value.dias_laborales || '1,2,3,4,5').split(',').map(x => x.trim());
      return list.includes(String(dayNum));
    }

    function toggleWorkDay(dayNum) {
      const curr = new Set(String(form.value.dias_laborales || '').split(',').map(x => x.trim()).filter(Boolean));
      const key = String(dayNum);
      if (curr.has(key)) {
        if (curr.size > 1) curr.delete(key);
      } else {
        curr.add(key);
      }
      form.value.dias_laborales = Array.from(curr).sort((a, b) => Number(a) - Number(b)).join(',');
    }

    function formatWorkDays(str) {
      const map = Object.fromEntries(WEEK_DAYS.map(d => [d.num, d.label]));
      return String(str || '1,2,3,4,5')
        .split(',')
        .map(x => map[x.trim()])
        .filter(Boolean)
        .join(', ');
    }

    function openNewArea() {
      activeSection.value = 'areas';
      isAreaScheduleDropdownOpen.value = false;
      const defSched = (props.schedules || []).find(s => Number(s.id) === Number(defaultBranchScheduleId.value)) || (props.schedules || [])[0] || null;
      form.value = {
        id: null,
        codigo: `AREA-0${props.areas.length + 1}`,
        nombre: '',
        responsable: '',
        turno: defSched?.nombre || 'Matutino',
        horario_id: defSched ? Number(defSched.id) : defaultBranchScheduleId.value,
        horario: '08:00 - 17:00',
        tolerancia_min: defSched?.tolerancia_min ?? 10,
        dias_laborales: '1,2,3,4,5',
        prefijo_id: '',
        ubicacion: activeBranch.value?.nombre || 'Sucursal Activa'
      };
      isModalOpen.value = true;
    }

    function editArea(a) {
      isAreaScheduleDropdownOpen.value = false;
      const hasLinked = a.horario_id && (props.schedules || []).some(s => Number(s.id) === Number(a.horario_id));
      const targetSchedId = hasLinked ? Number(a.horario_id) : defaultBranchScheduleId.value;
      const linkedSched = (props.schedules || []).find(s => Number(s.id) === Number(targetSchedId)) || null;
      const quickHorario = (a.hora_entrada && a.hora_salida) ? `${a.hora_entrada} - ${a.hora_salida}` : '08:00 - 17:00';
      form.value = {
        ...a,
        turno: linkedSched?.nombre || a.turno || 'Matutino',
        horario_id: targetSchedId,
        horario: (a.horario && !String(a.horario).startsWith('Mixto')) ? a.horario : quickHorario,
        dias_laborales: a.dias_laborales || '1,2,3,4,5',
        prefijo_id: a.prefijo_id || ''
      };
      isModalOpen.value = true;
    }

    async function reapplyRules() {
      if (!props.areas.length) {
        emit('toast', 'Crea al menos un área antes de re-aplicar reglas.', 'error');
        return;
      }
      const ok = await confirmDialog({
        title: '¿Re-aplicar reglas de área a empleados?',
        message: `Se reasignará el área de todos los empleados y checadas de "${activeBranch.value?.nombre || 'la sucursal activa'}" usando la cascada configurada.`,
        detail: 'Orden: 1) Prefijos de ID configurados en cada área, 2) Área asignada al reloj, 3) Primera área activa de la sucursal.',
        confirmLabel: 'Re-aplicar reglas'
      });
      if (!ok) return;

      isReapplyingRules.value = true;
      try {
        const res = await fetch('/api/areas/reapply-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            empresa_id: props.empresaId,
            sucursal_id: props.sucursalId
          })
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Reglas aplicadas correctamente');
          emit('refresh');
        } else {
          emit('toast', data.detail || 'No se pudieron re-aplicar las reglas', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al re-aplicar reglas', 'error');
      } finally {
        isReapplyingRules.value = false;
      }
    }

    async function saveArea() {
      if (!form.value.nombre) {
        emit('toast', 'El nombre del área es obligatorio', 'error');
        return;
      }
      try {
        const chosenSched = selectedAreaSchedule.value;
        const payload = {
          ...form.value,
          turno: chosenSched?.nombre || form.value.turno || 'Matutino',
          horario_id: chosenSched ? Number(chosenSched.id) : (form.value.horario_id || '__simple__'),
          empresa_id: props.empresaId,
          sucursal_id: props.sucursalId
        };
        const res = await fetch('/api/areas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
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
      const ok = await confirmDialog({
        title: '¿Eliminar esta área?',
        message: `Se eliminará el área "${a.nombre}" de la sucursal.`,
        detail: 'Esta acción no se puede deshacer.',
        variant: 'danger',
        confirmLabel: 'Eliminar área'
      });
      if (!ok) return;
      await fetch(`/api/areas/${a.id}`, { method: 'DELETE' });
      emit('toast', `Área '${a.nombre}' eliminada`);
      emit('refresh');
    }

    return {
      activeSection,
      setSection,
      feedback,
      activeCompany,
      activeBranch,
      totpData,
      isLoadingTotp,
      isTotpVisible,
      isRemovingMember,
      formattedCountdown,
      countdownProgressPct,
      fetchInviteTotp,
      requestInviteTotp,
      hideInviteTotp,
      copyInviteCredentials,
      removeMember,
      joinForm,
      isJoining,
      submitJoinCompany,
      newCompForm,
      isCreatingComp,
      submitCreateCompany,
      isAddingBranch,
      newBranchForm,
      submitCreateBranch,
      selectCompanyAndBranch,
      configureBranchAreas,
      WEEK_DAYS,
      TOLERANCE_PRESETS,
      isModalOpen,
      isReapplyingRules,
      isAreaScheduleDropdownOpen,
      isAreaScheduleDetailVisible,
      toggleAreaScheduleDropdown,
      toggleAreaScheduleDetail,
      selectAreaSchedule,
      form,
      defaultBranchScheduleId,
      selectedAreaSchedule,
      isScheduleModalOpen,
      isSavingSchedule,
      returnToAreaModal,
      scheduleForm,
      setScheduleTolerance,
      stepScheduleTolerance,
      openNewSchedule,
      openNewScheduleFromArea,
      editSchedule,
      closeScheduleModal,
      saveSchedule,
      deleteSchedule,
      formatDayBlocksSummary,
      isWorkDaySelected,
      toggleWorkDay,
      formatWorkDays,
      openNewArea,
      editArea,
      reapplyRules,
      saveArea,
      deleteArea
    };
  },
  template: `
    <div class="w-full flex-1 flex flex-col space-y-6 animate-in fade-in duration-150 pb-8">

      <!-- PESTAÑAS DEL MÓDULO DE EMPRESA -->
      <div class="bg-white rounded-3xl p-3 px-4 border border-charcoal-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          <button
            type="button"
            @click="setSection('empresas')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap"
            :class="activeSection === 'empresas' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-buildings text-base" :class="activeSection === 'empresas' ? 'text-white' : 'text-charcoal-400'"></i></span>
            <span>Empresas y Sucursales</span>
          </button>

          <button
            type="button"
            @click="setSection('areas')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap"
            :class="activeSection === 'areas' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-clock-user text-base" :class="activeSection === 'areas' ? 'text-white' : 'text-charcoal-400'"></i></span>
            <span>Áreas</span>
            <span class="text-[10px] mono-code px-1.5 py-0.5 rounded-full"
              :class="activeSection === 'areas' ? 'bg-white/20 text-white' : 'bg-charcoal-100 text-charcoal-700'">
              {{ areas.length }}
            </span>
          </button>

          <button
            type="button"
            @click="setSection('horarios')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap"
            :class="activeSection === 'horarios' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-calendar-check text-base" :class="activeSection === 'horarios' ? 'text-white' : 'text-charcoal-400'"></i></span>
            <span>Horarios y Turnos</span>
            <span class="text-[10px] mono-code px-1.5 py-0.5 rounded-full"
              :class="activeSection === 'horarios' ? 'bg-white/20 text-white' : 'bg-charcoal-100 text-charcoal-700'">
              {{ schedules.length }}
            </span>
          </button>

          <button
            type="button"
            @click="setSection('invitar')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap"
            :class="activeSection === 'invitar' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-users-three text-base" :class="activeSection === 'invitar' ? 'text-white' : 'text-charcoal-400'"></i></span>
            <span>Equipo y Acceso (Código)</span>
            <span v-if="activeCompany" class="text-[10px] mono-code px-1.5 py-0.5 rounded-full"
              :class="activeSection === 'invitar' ? 'bg-white/20 text-white' : 'bg-charcoal-100 text-charcoal-700'">
              {{ activeCompany?.usuarios_miembros?.length || 0 }}
            </span>
          </button>

          <button
            type="button"
            @click="setSection('nueva_empresa')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap"
            :class="activeSection === 'nueva_empresa' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-plus-circle text-base" :class="activeSection === 'nueva_empresa' ? 'text-white' : 'text-charcoal-400'"></i></span>
            <span>Nueva Empresa</span>
          </button>
        </div>

        <div v-if="activeCompany" class="text-[11px] text-charcoal-500 flex items-center gap-2 px-2">
          <span class="font-bold text-charcoal-900">{{ activeCompany.nombre }}</span>
          <span v-if="activeBranch" class="mono-code px-2 py-0.5 rounded-full bg-charcoal-100 text-charcoal-700">
            {{ activeBranch.nombre }}
          </span>
        </div>
      </div>

      <!-- ALERTA DE FEEDBACK -->
      <div v-if="feedback.message" class="p-4 rounded-2xl text-xs flex items-center justify-between"
        :class="feedback.type === 'error' ? 'bg-rose-50 text-rose-800 border border-rose-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'">
        <div class="flex items-center gap-2">
          <i :class="['ph', feedback.type === 'error' ? 'ph-warning-circle text-rose-600' : 'ph-check-circle text-emerald-600', 'text-base']"></i>
          <span class="font-medium">{{ feedback.message }}</span>
        </div>
        <button type="button" @click="feedback.message = ''" class="cursor-pointer"><i class="ph ph-x"></i></button>
      </div>

      <!-- ================= TAB 1: EMPRESAS Y SUCURSALES ================= -->
      <div v-if="activeSection === 'empresas'" class="space-y-6 text-xs">
        <div v-if="!companies.length" class="bg-white rounded-3xl p-10 border border-charcoal-200 shadow-sm text-center flex flex-col items-center justify-center min-h-[300px]">
          <i class="ph ph-buildings text-5xl text-charcoal-300 mb-3"></i>
          <h3 class="text-sm font-semibold text-charcoal-900">Aún no tienes empresas registradas</h3>
          <p class="text-xs text-charcoal-500 mt-1.5 max-w-md leading-relaxed">
            Crea tu primera empresa y sucursal matriz, o únete a una empresa existente usando su código de invitación y clave dinámica.
          </p>
          <div class="mt-5 flex items-center gap-3 flex-wrap justify-center">
            <button
              type="button"
              @click="setSection('nueva_empresa')"
              class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 cursor-pointer">
              <i class="ph ph-plus-circle text-base"></i>
              <span>Crear Primera Empresa</span>
            </button>
            <button
              type="button"
              @click="setSection('unirse')"
              class="px-5 py-2.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-bold flex items-center gap-2 cursor-pointer">
              <i class="ph ph-sign-in text-base"></i>
              <span>Unirme con Código</span>
            </button>
          </div>
        </div>

        <div v-else class="space-y-5">
          <div v-for="comp in companies" :key="comp.id"
            class="p-6 rounded-3xl border transition-all"
            :class="comp.id === empresaId ? 'bg-white border-charcoal-300 shadow-sm' : 'bg-white/90 border-charcoal-200'">

            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-charcoal-200/70">
              <div>
                <div class="flex items-center gap-3 flex-wrap">
                  <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-buildings text-lg text-charcoal-400"></i></span>
                  <h4 class="text-sm font-semibold text-charcoal-900">{{ comp.nombre }}</h4>
                  <span class="text-[10px] mono-code font-semibold tracking-wider"
                    :class="comp.is_owner ? 'text-charcoal-900' : 'text-charcoal-400'">
                    {{ comp.is_owner ? 'ADMINISTRADOR (CREADOR)' : 'MIEMBRO RH' }}
                  </span>
                </div>
                <p class="text-[11px] text-charcoal-500 mt-1">
                  {{ comp.industria }}
                  <span v-if="comp.rfc"> • RFC: <b class="mono-code text-charcoal-700">{{ comp.rfc }}</b></span>
                  • Código Empresa: <b class="mono-code text-charcoal-800">{{ comp.codigo_invitacion }}</b>
                </p>
              </div>

              <div class="flex items-center gap-2 flex-wrap">
                <button
                  v-if="comp.is_owner"
                  type="button"
                  @click="selectCompanyAndBranch(comp.id, comp.sucursales[0]?.id); setSection('invitar')"
                  class="px-3.5 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-900 font-bold text-[11px] flex items-center gap-1 cursor-pointer">
                  <i class="ph ph-key"></i> Clave Invitación
                </button>
                <button
                  type="button"
                  @click="selectCompanyAndBranch(comp.id, comp.sucursales[0]?.id); isAddingBranch = true"
                  class="px-3.5 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white font-bold text-[11px] flex items-center gap-1 cursor-pointer">
                  <i class="ph ph-plus"></i> Nueva Sucursal
                </button>
              </div>
            </div>

            <!-- Lista de Sucursales de esta Empresa -->
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-5">
              <div
                v-for="suc in comp.sucursales"
                :key="suc.id"
                @click="selectCompanyAndBranch(comp.id, suc.id)"
                class="p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 cursor-pointer"
                :class="(comp.id === empresaId && suc.id === sucursalId)
                  ? 'bg-white text-charcoal-900 border-charcoal-900 ring-1 ring-charcoal-900/10'
                  : 'bg-offwhite hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200'">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="font-bold text-xs flex items-center gap-2">
                      <span class="w-4 flex items-center justify-center shrink-0"><i class="ph ph-map-pin text-sm text-charcoal-400"></i></span>
                      <span>{{ suc.nombre }}</span>
                    </div>
                    <p class="text-[10px] mt-1 text-charcoal-500">
                      {{ suc.relojes_count || 0 }} reloj(es) • {{ suc.empleados_count || 0 }} empleados
                    </p>
                  </div>
                  <i v-if="comp.id === empresaId && suc.id === sucursalId" class="ph-fill ph-check-circle text-charcoal-900 text-base shrink-0"></i>
                </div>

                <div class="flex items-center justify-between pt-2 border-t border-charcoal-200/70">
                  <span class="text-[10px] mono-code text-charcoal-400">
                    {{ suc.codigo || 'SUC' }}
                  </span>
                  <button
                    type="button"
                    @click.stop="configureBranchAreas(comp.id, suc.id)"
                    class="text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer text-charcoal-600 hover:text-charcoal-900">
                    <i class="ph ph-clock-user text-sm text-charcoal-400"></i>
                    <span>Áreas y Turnos</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Formulario Inline para Agregar Nueva Sucursal a la Empresa Activa -->
          <div v-if="isAddingBranch && activeCompany" class="p-6 rounded-3xl bg-white border border-charcoal-300 shadow-sm space-y-5">
            <div class="flex items-center justify-between">
              <h5 class="text-sm font-semibold text-charcoal-900 flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-map-pin-plus text-lg text-charcoal-400"></i></span><span>Agregar Nueva Sucursal en {{ activeCompany.nombre }}</span></h5>
              <button type="button" @click="isAddingBranch = false" class="text-charcoal-400 hover:text-black cursor-pointer"><i class="ph ph-x"></i></button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label class="block font-bold text-charcoal-700 mb-1.5">Nombre de la Sucursal</label>
                <input v-model="newBranchForm.nombre" type="text" placeholder="Ej: Sucursal Querétaro Sur"
                  class="w-full px-4 py-2.5 rounded-xl border border-charcoal-200 bg-white">
              </div>
              <div>
                <label class="block font-bold text-charcoal-700 mb-1.5">Ubicación / Dirección</label>
                <input v-model="newBranchForm.ubicacion" type="text" placeholder="Ej: Parque Industrial Bernardo Quintana"
                  class="w-full px-4 py-2.5 rounded-xl border border-charcoal-200 bg-white">
              </div>
            </div>
            <div class="flex justify-end gap-2 pt-2">
              <button type="button" @click="isAddingBranch = false"
                class="px-4 py-2 rounded-full bg-charcoal-100 text-charcoal-700 font-bold text-xs cursor-pointer">
                Cancelar
              </button>
              <button type="button" @click="submitCreateBranch"
                class="px-5 py-2 rounded-full bg-[#18181B] text-white font-bold text-xs cursor-pointer">
                Guardar Sucursal
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= TAB 2: ÁREAS, TURNOS Y HORARIOS ================= -->
      <div v-else-if="activeSection === 'areas'" class="space-y-5">
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <span class="w-5 flex items-center justify-center shrink-0">
              <i class="ph ph-clock-user text-lg text-charcoal-400"></i>
            </span>
            <div class="min-w-0">
              <h3 class="text-sm font-semibold text-charcoal-900">Áreas, Turnos y Horarios</h3>
              <p class="text-[11px] text-charcoal-400">
                Entrada, salida, tolerancia y días laborales en <b class="text-charcoal-700">{{ activeBranch?.nombre || 'la sucursal activa' }}</b>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap shrink-0">
            <button
              type="button"
              :disabled="isReapplyingRules || !areas.length"
              @click="reapplyRules"
              class="px-4 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 disabled:opacity-50 text-charcoal-900 text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors">
              <i :class="['ph text-sm', isReapplyingRules ? 'ph-spinner animate-spin' : 'ph-arrows-clockwise']"></i>
              <span>{{ isReapplyingRules ? 'Aplicando...' : 'Re-aplicar reglas a empleados' }}</span>
            </button>
            <button
              type="button"
              @click="openNewArea"
              class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer">
              <i class="ph ph-plus-circle text-sm"></i>
              <span>Nueva Área / Turno</span>
            </button>
          </div>
        </div>

        <!-- ESTADO VACÍO: SIN ÁREAS -->
        <div v-if="!areas.length" class="flex-1 bg-white rounded-3xl p-10 border border-charcoal-200 shadow-sm text-center flex flex-col items-center justify-center min-h-[280px]">
          <i class="ph ph-clock-user text-5xl text-charcoal-300 mb-3"></i>
          <h3 class="text-sm font-semibold text-charcoal-900">Aún no hay áreas o turnos configurados</h3>
          <p class="text-xs text-charcoal-500 mt-1.5 max-w-md leading-relaxed">
            Crea las áreas operativas con su horario de entrada y tolerancia en minutos para calcular los retardos de pre-nómina.
          </p>
          <button
            type="button"
            @click="openNewArea"
            class="mt-5 px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 cursor-pointer transition-all shadow-xs">
            <i class="ph ph-plus-circle text-base"></i>
            <span>Crear Primera Área</span>
          </button>
        </div>

        <!-- AREAS CARDS GRID -->
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div
            v-for="a in areas"
            :key="a.id"
            class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm flex flex-col justify-between">

            <div>
              <div class="flex items-start justify-between gap-3 mb-4">
                <div class="flex items-center gap-3">
                  <span class="w-5 flex items-center justify-center shrink-0">
                    <i class="ph ph-buildings text-lg text-charcoal-400"></i>
                  </span>
                  <div>
                    <h3 class="text-sm font-semibold text-charcoal-900">{{ a.nombre }}</h3>
                    <span class="text-[10px] mono-code text-charcoal-400">{{ a.codigo }}</span>
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
                <div class="col-span-2 sm:col-span-1">
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Horario Base</span>
                  <span class="font-bold text-charcoal-900 block">{{ a.horario_nombre || a.turno }}</span>
                  <span class="font-semibold text-charcoal-700 mono-code text-[11px]">{{ a.horario_resumen || a.horario }}</span>
                </div>
                <div>
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Tolerancia Entrada</span>
                  <span class="font-bold text-emerald-700 mono-code">{{ a.tolerancia_min }} minutos</span>
                </div>
                <div v-if="a.horario_es_mixto && a.horario_detalle" class="col-span-2">
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Desglose Semanal</span>
                  <span class="font-medium text-charcoal-700 mono-code text-[11px]">{{ a.horario_detalle }}</span>
                </div>
                <div class="col-span-2">
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Días Laborales (Pre-Nómina)</span>
                  <span class="font-semibold text-charcoal-800">{{ formatWorkDays(a.dias_laborales) }}</span>
                </div>
                <div v-if="a.prefijo_id" class="col-span-2">
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Prefijos de Auto-Asignación</span>
                  <span class="font-bold text-charcoal-900 mono-code">{{ a.prefijo_id }}</span>
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
      </div>

      <!-- ================= TAB 2B: CATÁLOGO DE HORARIOS FLEXIBLES ================= -->
      <div v-else-if="activeSection === 'horarios'" class="space-y-5">
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <span class="w-5 flex items-center justify-center shrink-0">
              <i class="ph ph-calendar-check text-lg text-charcoal-400"></i>
            </span>
            <div class="min-w-0">
              <h3 class="text-sm font-semibold text-charcoal-900">Horarios y Jornadas Flexibles</h3>
              <p class="text-[11px] text-charcoal-400">
                Plantillas fijas, parciales o mixtas multi-bloque reutilizables por área o colaborador en <b class="text-charcoal-700">{{ activeBranch?.nombre || 'la sucursal activa' }}</b>
              </p>
            </div>
          </div>
          <button
            type="button"
            @click="openNewSchedule"
            class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0">
            <i class="ph ph-plus-circle text-sm"></i>
            <span>Nuevo Horario</span>
          </button>
        </div>

        <div v-if="!schedules.length" class="flex-1 bg-white rounded-3xl p-10 border border-charcoal-200 shadow-sm text-center flex flex-col items-center justify-center min-h-[280px]">
          <i class="ph ph-calendar-check text-5xl text-charcoal-300 mb-3"></i>
          <h3 class="text-sm font-semibold text-charcoal-900">Aún no hay plantillas de horario registradas</h3>
          <p class="text-xs text-charcoal-500 mt-1.5 max-w-md leading-relaxed">
            Crea horarios fijos, partidos o mixtos por día de la semana para asignarlos a áreas o a colaboradores específicos.
          </p>
          <button
            type="button"
            @click="openNewSchedule"
            class="mt-5 px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 cursor-pointer transition-all shadow-xs">
            <i class="ph ph-plus-circle text-base"></i>
            <span>Crear Primer Horario</span>
          </button>
        </div>

        <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          <div
            v-for="s in schedules"
            :key="s.id"
            class="bg-white rounded-3xl p-5 border border-charcoal-200 shadow-sm flex flex-col justify-between gap-4">

            <div class="space-y-3.5">
              <!-- Encabezado compacto alineado al diseño general -->
              <div class="flex items-start justify-between gap-2.5">
                <div class="flex items-center gap-3 min-w-0">
                  <span class="w-5 flex items-center justify-center shrink-0">
                    <i class="ph ph-calendar-check text-lg text-charcoal-400"></i>
                  </span>
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <h3 class="text-sm font-semibold text-charcoal-900 truncate">{{ s.nombre }}</h3>
                      <span
                        v-if="Number(s.id) === Number(defaultBranchScheduleId)"
                        class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                        Por defecto
                      </span>
                    </div>
                    <p v-if="s.descripcion" class="text-[11px] text-charcoal-500 mt-0.5 truncate">{{ s.descripcion }}</p>
                  </div>
                </div>

                <span
                  class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mono-code shrink-0"
                  :class="s.es_mixto ? 'bg-[#18181B] text-white' : 'bg-charcoal-100 text-charcoal-700'">
                  {{ s.es_mixto ? 'Mixto' : 'Fijo' }}
                </span>
              </div>

              <!-- Resumen limpio de la jornada -->
              <div class="p-3.5 rounded-2xl bg-offwhite border border-charcoal-200/70 space-y-2.5">
                <div class="text-xs mono-code font-bold text-charcoal-900 leading-relaxed">
                  {{ s.resumen_detalle || s.resumen_corto }}
                </div>

                <div class="flex items-center justify-between gap-2 pt-2 border-t border-charcoal-200/60 text-[11px]">
                  <!-- Indicador compacto Lun-Dom -->
                  <div class="flex items-center gap-1">
                    <span
                      v-for="d in WEEK_DAYS"
                      :key="d.num"
                      :title="d.label + ': ' + formatDayBlocksSummary(s, d.num)"
                      class="w-5 h-5 rounded-md text-[10px] font-bold flex items-center justify-center"
                      :class="formatDayBlocksSummary(s, d.num) === 'Descanso'
                        ? 'bg-charcoal-100/80 text-charcoal-400'
                        : 'bg-[#18181B] text-white'">
                      {{ d.label.slice(0, 1) }}
                    </span>
                  </div>

                  <div class="flex items-center gap-2 mono-code text-[11px]">
                    <span class="font-bold text-charcoal-900">{{ s.horas_semanales }}h/sem</span>
                    <span class="text-charcoal-300">·</span>
                    <span class="font-bold text-emerald-700">{{ s.tolerancia_min }}m tol.</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Pie con asignación y acciones -->
            <div class="pt-3 border-t border-charcoal-100 flex items-center justify-between gap-2">
              <span class="text-[11px] text-charcoal-500 mono-code">
                {{ s.areas_count || 0 }} área(s) · {{ s.empleados_count || 0 }} colab.
              </span>

              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  @click="editSchedule(s)"
                  class="px-3.5 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-xs font-semibold cursor-pointer">
                  <i class="ph ph-pencil-simple"></i> Editar
                </button>
                <button
                  type="button"
                  :disabled="schedules.length <= 1"
                  :title="schedules.length <= 1 ? 'Siempre debe existir al menos un horario en la sucursal' : 'Eliminar horario'"
                  @click="deleteSchedule(s)"
                  class="px-2.5 py-1.5 rounded-full text-red-600 hover:bg-red-50 disabled:opacity-35 disabled:cursor-not-allowed text-xs font-semibold cursor-pointer">
                  <i class="ph ph-trash"></i>
                </button>
              </div>
            </div>

          </div>
        </div>
      </div>

      <!-- ================= TAB 3: EQUIPO RH Y UNIRSE CON CÓDIGO ================= -->
      <div v-else-if="activeSection === 'invitar'" class="space-y-6 text-xs">

        <!-- 1. OPCIÓN POR DEFECTO: UNIRSE A UNA EMPRESA CON CÓDIGO -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 flex items-start gap-3">
            <span class="w-5 flex items-center justify-center shrink-0 mt-0.5"><i class="ph ph-sign-in text-lg text-charcoal-400"></i></span>
            <div>
              <h3 class="text-sm font-semibold text-charcoal-900">Unirse a una Empresa con Código</h3>
              <p class="text-[11px] text-charcoal-500 mt-0.5 leading-relaxed">
                Solicita al creador de la empresa el <b>Código de Invitación</b> y la <b>Clave Dinámica de 6 dígitos</b> vigente (la clave se genera bajo demanda y cambia cada 5 minutos por seguridad).
              </p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-4 sm:items-end">
            <div>
              <label class="block font-semibold text-charcoal-800 mb-1.5">Código de Invitación de la Empresa</label>
              <input v-model="joinForm.codigo_invitacion" type="text" placeholder="Ej: EMP-QUODO-01"
                class="w-full h-11 px-4 rounded-xl border border-charcoal-200 mono-code font-bold uppercase">
            </div>
            <div>
              <label class="block font-semibold text-charcoal-800 mb-1.5">Clave Dinámica Vigente (6 dígitos)</label>
              <input v-model="joinForm.clave_dinamica" type="text" maxlength="7" placeholder="Ej: 482910"
                class="w-full h-11 px-4 rounded-xl border border-charcoal-200 mono-code font-bold tracking-widest">
            </div>
            <button
              type="button"
              :disabled="isJoining"
              @click="submitJoinCompany"
              class="h-11 px-5 rounded-full bg-[#18181B] hover:bg-black disabled:opacity-60 text-white font-bold text-xs flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap">
              <i class="ph ph-sign-in"></i>
              <span>{{ isJoining ? 'Verificando...' : 'Unirme' }}</span>
            </button>
          </div>
        </div>

        <!-- 2. GENERADOR DE CLAVE DINÁMICA BAJO DEMANDA (SOLO CREADOR / OWNER) -->
        <div v-if="activeCompany && activeCompany.is_owner" class="space-y-4">
          <div v-if="!isTotpVisible" class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div class="space-y-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-[10px] mono-code uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-charcoal-100 text-charcoal-700 font-bold">
                  Invitar a mi Equipo RH
                </span>
                <span class="text-[11px] mono-code text-charcoal-500">
                  Código fijo: <b class="text-charcoal-900">{{ activeCompany.codigo_invitacion }}</b>
                </span>
              </div>
              <h4 class="text-sm font-semibold text-charcoal-900 flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-key text-lg text-charcoal-400"></i></span><span>Compartir acceso a {{ activeCompany.nombre }}</span></h4>
              <p class="text-[11px] text-charcoal-500 max-w-xl">
                Por seguridad, la clave dinámica de 6 dígitos solo se genera cuando la solicitas y tiene validez de 5 minutos.
              </p>
            </div>

            <button
              type="button"
              :disabled="isLoadingTotp"
              @click="requestInviteTotp"
              class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black disabled:opacity-60 text-white font-bold text-xs flex items-center gap-2 shrink-0 cursor-pointer">
              <i class="ph ph-key text-base"></i>
              <span>{{ isLoadingTotp ? 'Generando...' : 'Generar Clave Dinámica (5 min)' }}</span>
            </button>
          </div>

          <div v-else class="p-6 rounded-3xl bg-white border border-charcoal-200 shadow-sm space-y-5">
            <div class="flex items-center justify-between flex-wrap gap-3">
              <div>
                <span class="text-[10px] mono-code uppercase tracking-wider text-charcoal-400 font-semibold block">
                  Autorización Criptográfica TOTP • Ventana de 5 Minutos
                </span>
                <h4 class="text-sm font-semibold text-charcoal-900 mt-1 flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-key text-lg text-charcoal-400"></i></span><span>{{ activeCompany.nombre }}</span></h4>
              </div>
              <div class="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  @click="copyInviteCredentials"
                  class="px-3.5 py-2 rounded-full bg-[#18181B] hover:bg-black text-white font-semibold text-xs flex items-center gap-1.5 cursor-pointer">
                  <i class="ph ph-copy"></i> Copiar Datos
                </button>
                <button
                  type="button"
                  @click="hideInviteTotp"
                  class="px-3.5 py-2 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 font-semibold text-xs flex items-center gap-1.5 cursor-pointer">
                  <i class="ph ph-eye-slash"></i> Ocultar Clave
                </button>
              </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div class="p-5 rounded-2xl bg-offwhite border border-charcoal-200">
                <span class="text-[10px] uppercase text-charcoal-400 font-bold block">1. Código de Invitación Empresa</span>
                <span class="text-xl mono-code font-black tracking-wider text-charcoal-900 mt-1 block">
                  {{ totpData.codigo_invitacion || activeCompany.codigo_invitacion }}
                </span>
              </div>

              <div class="p-5 rounded-2xl bg-offwhite border border-charcoal-200">
                <div class="flex items-center justify-between">
                  <span class="text-[10px] uppercase text-charcoal-400 font-bold">2. Clave Dinámica (5 min)</span>
                  <span class="text-[11px] mono-code font-bold text-charcoal-500 flex items-center gap-1">
                    <i class="ph ph-timer"></i> {{ formattedCountdown }}
                  </span>
                </div>
                <span class="text-2xl mono-code font-black tracking-widest text-charcoal-900 mt-1 block">
                  {{ isLoadingTotp ? '--- ---' : totpData.clave_formateada }}
                </span>
              </div>
            </div>

            <div class="space-y-1">
              <div class="w-full h-1.5 rounded-full bg-charcoal-100 overflow-hidden">
                <div
                  class="h-full bg-charcoal-900 transition-all duration-1000"
                  :style="{ width: countdownProgressPct + '%' }"></div>
              </div>
              <p class="text-[11px] text-charcoal-400">
                Esta clave se regenera automáticamente cada <b>5 minutos</b> mientras permanezca visible. Compártela únicamente con el personal de RH que deseas autorizar en tu empresa.
              </p>
            </div>
          </div>
        </div>

        <div v-else-if="activeCompany" class="p-5 rounded-3xl bg-amber-50 border border-amber-200 text-amber-900 flex items-start gap-3">
          <i class="ph ph-shield-warning text-lg text-amber-700 shrink-0 mt-0.5"></i>
          <div>
            <p class="font-bold text-xs">Acceso como Miembro RH en {{ activeCompany.nombre }}</p>
            <p class="text-[11px] opacity-90 mt-0.5">
              Solo el creador/administrador de esta empresa puede generar claves dinámicas de invitación o revocar miembros. Puedes usar el formulario superior para unirte a otra empresa si cuentas con un código vigente.
            </p>
          </div>
        </div>

        <!-- 3. GESTIÓN DE PERSONAS UNIDAS -->
        <div v-if="activeCompany" class="p-6 rounded-3xl bg-white border border-charcoal-200 shadow-sm space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-charcoal-100">
            <div>
              <h5 class="text-sm font-semibold text-charcoal-900 flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-users-three text-lg text-charcoal-400"></i></span><span>Personas con acceso a {{ activeCompany.nombre }}</span></h5>
              <p class="text-[11px] text-charcoal-500">
                {{ activeCompany.is_owner ? 'Administra quién forma parte del equipo RH de esta empresa.' : 'Listado de colaboradores RH vinculados a esta empresa.' }}
              </p>
            </div>
            <span class="text-[11px] mono-code font-bold px-3 py-1 rounded-full bg-charcoal-100 text-charcoal-700 self-start sm:self-auto">
              {{ activeCompany.usuarios_miembros?.length || 0 }} integrante(s)
            </span>
          </div>

          <div v-if="activeCompany.usuarios_miembros && activeCompany.usuarios_miembros.length" class="divide-y divide-charcoal-100">
            <div v-for="m in activeCompany.usuarios_miembros" :key="m.id" class="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-bold text-charcoal-900 text-xs">{{ m.nombre }}</span>
                  <span class="text-[10px] mono-code font-semibold tracking-wider"
                    :class="m.rol_empresa === 'OWNER' ? 'text-charcoal-900' : 'text-charcoal-400'">
                    {{ m.rol_empresa === 'OWNER' ? 'ADMINISTRADOR (CREADOR)' : 'MIEMBRO RH' }}
                  </span>
                </div>
                <div class="text-[11px] text-charcoal-500 mt-0.5 flex items-center gap-2 flex-wrap">
                  <span class="mono-code">{{ m.email }}</span>
                  <span v-if="m.joined_at" class="text-charcoal-400">• Unido: {{ String(m.joined_at).slice(0, 10) }}</span>
                </div>
              </div>

              <div v-if="activeCompany.is_owner && m.rol_empresa !== 'OWNER'" class="shrink-0">
                <button
                  type="button"
                  :disabled="isRemovingMember === m.id"
                  @click="removeMember(m)"
                  class="px-3.5 py-1.5 rounded-full bg-rose-50 hover:bg-rose-100 disabled:opacity-60 text-rose-700 border border-rose-200 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer">
                  <i class="ph ph-user-minus"></i>
                  <span>{{ isRemovingMember === m.id ? 'Revocando...' : 'Revocar Acceso' }}</span>
                </button>
              </div>
            </div>
          </div>

          <div
            v-if="activeCompany.is_owner && !activeCompany.usuarios_miembros?.some(m => m.rol_empresa !== 'OWNER')"
            class="p-4 rounded-2xl bg-offwhite border border-charcoal-200/70 text-[11px] text-charcoal-600 flex items-center gap-2.5">
            <i class="ph ph-info text-base text-charcoal-500 shrink-0"></i>
            <span>Aún no hay otros miembros de RH unidos a esta empresa. Cuando necesites invitar a alguien, genera una clave dinámica arriba y sus accesos aparecerán aquí para gestionarlos.</span>
          </div>
        </div>
      </div>

      <!-- ================= TAB 5: CREAR NUEVA EMPRESA ================= -->
      <div v-else-if="activeSection === 'nueva_empresa'" class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-6 text-xs">
        <div>
          <h3 class="text-sm font-semibold text-charcoal-900 flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-plus-circle text-lg text-charcoal-400"></i></span><span>Registrar Nueva Empresa</span></h3>
          <p class="text-xs text-charcoal-500 mt-0.5">Crea una nueva razón social con su sucursal matriz y área operativa inicial.</p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label class="block font-bold text-charcoal-800 mb-2">Razón Social / Nombre de la Empresa</label>
            <input v-model="newCompForm.nombre" type="text" placeholder="Ej: Grupo Textil del Centro S.A."
              class="w-full px-4 py-3 rounded-xl border border-charcoal-200">
          </div>
          <div>
            <label class="block font-bold text-charcoal-800 mb-2">RFC / Identificador Fiscal (Opcional)</label>
            <input v-model="newCompForm.rfc" type="text" placeholder="GTC260101AAA"
              class="w-full px-4 py-3 rounded-xl border border-charcoal-200 mono-code uppercase">
          </div>
          <div>
            <label class="block font-bold text-charcoal-800 mb-2">Giro / Industria</label>
            <input v-model="newCompForm.industria" type="text" placeholder="Ej: Manufactura, Retail, Corporativo"
              class="w-full px-4 py-3 rounded-xl border border-charcoal-200">
          </div>
          <div>
            <label class="block font-bold text-charcoal-800 mb-2">Nombre de la Primera Sucursal</label>
            <input v-model="newCompForm.sucursal_inicial" type="text" placeholder="Ej: Planta Matriz"
              class="w-full px-4 py-3 rounded-xl border border-charcoal-200">
          </div>
        </div>

        <div class="flex justify-end pt-2">
          <button
            type="button"
            :disabled="isCreatingComp"
            @click="submitCreateCompany"
            class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white font-bold text-xs flex items-center gap-2 cursor-pointer">
            <i class="ph ph-buildings"></i>
            <span>{{ isCreatingComp ? 'Creando...' : 'Crear Empresa y Sucursal' }}</span>
          </button>
        </div>
      </div>

      <!-- MODAL UNIFICADO: CREACIÓN DE ÁREA <-> CREACIÓN DE HORARIO (SE CONVIERTE EN EL MISMO MODAL AL PULSAR +) -->
      <ModalBase
        v-if="isModalOpen || isScheduleModalOpen"
        :title="isScheduleModalOpen
          ? (scheduleForm.id ? 'Editar Plantilla de Horario' : 'Crear Nuevo Horario / Jornada')
          : (form.id ? 'Editar Área Operativa' : 'Crear Nueva Área Operativa')"
        :subtitle="isScheduleModalOpen
          ? 'Configura horarios fijos, parciales o mixtos con múltiples bloques por día.'
          : ('Define los datos del departamento y selecciona su horario base en ' + (activeBranch?.nombre || 'la sucursal activa') + '.')"
        :cancelLabel="(isScheduleModalOpen && returnToAreaModal) ? 'Volver al Área' : 'Cancelar'"
        :confirmLabel="isScheduleModalOpen
          ? (isSavingSchedule ? 'Guardando...' : 'Guardar Horario')
          : 'Guardar Área'"
        :confirmDisabled="isScheduleModalOpen ? isSavingSchedule : false"
        :size="isScheduleModalOpen ? 'wide' : 'xl'"
        :noScroll="true"
        @close="isScheduleModalOpen ? closeScheduleModal() : (isModalOpen = false)"
        @confirm="isScheduleModalOpen ? saveSchedule() : saveArea()">

        <!-- VISTA 1: MODAL ÚNICAMENTE PARA CREACIÓN / EDICIÓN DEL ÁREA -->
        <div v-if="!isScheduleModalOpen" key="view-area-only" class="space-y-4 text-xs animate-in fade-in duration-150">
          <!-- Fila 1: Código + Nombre del Área -->
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-4">
            <div class="sm:col-span-4">
              <label class="block font-bold text-charcoal-800 mb-1.5">Código</label>
              <input
                v-model="form.codigo"
                type="text"
                placeholder="AREA-01"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div class="sm:col-span-8">
              <label class="block font-bold text-charcoal-800 mb-1.5">Nombre del Área / Departamento *</label>
              <input
                v-model="form.nombre"
                type="text"
                placeholder="Ej: Producción Planta B"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <!-- Fila 2: Jefe / Responsable + Ubicación / Sede -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1.5">Jefe / Responsable</label>
              <input
                v-model="form.responsable"
                type="text"
                placeholder="Nombre del responsable"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1.5">Ubicación / Sede</label>
              <input
                v-model="form.ubicacion"
                type="text"
                placeholder="Ej: Sucursal Matriz"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <!-- Fila 3: Selector Propio de Horario + Botón [+] al lado  |  Prefijos de ID -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1.5">Horario Base del Área</label>
              <div class="flex items-center gap-2">
                <!-- Selector propio de la aplicación -->
                <div class="relative flex-1 min-w-0" data-area-schedule-dropdown>
                  <button
                    type="button"
                    @click="toggleAreaScheduleDropdown($event)"
                    class="w-full h-10 px-3.5 rounded-xl border text-left transition-all cursor-pointer flex items-center justify-between gap-2"
                    :class="isAreaScheduleDropdownOpen
                      ? 'bg-charcoal-50 border-charcoal-900 ring-2 ring-charcoal-900/10'
                      : 'bg-white hover:bg-charcoal-50 border-charcoal-200 hover:border-charcoal-300'">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="w-4 flex items-center justify-center shrink-0">
                        <i class="ph ph-clock-user text-sm text-charcoal-400"></i>
                      </span>
                      <span class="font-bold text-charcoal-900 truncate">
                        {{ selectedAreaSchedule ? selectedAreaSchedule.nombre : 'Horario Matutino' }}
                      </span>
                      <span
                        v-if="selectedAreaSchedule"
                        class="text-[11px] mono-code text-charcoal-500 truncate hidden md:inline">
                        ({{ selectedAreaSchedule.resumen_corto }})
                      </span>
                    </div>
                    <i
                      class="ph ph-caret-down text-xs text-charcoal-400 transition-transform duration-200 shrink-0"
                      :class="{ 'rotate-180 text-charcoal-900': isAreaScheduleDropdownOpen }"></i>
                  </button>

                  <!-- Panel Desplegable Propio de Horarios -->
                  <div
                    v-if="isAreaScheduleDropdownOpen"
                    @click.stop
                    class="absolute left-0 right-0 top-full mt-1.5 bg-white rounded-2xl border border-charcoal-200 shadow-2xl overflow-hidden z-50 flex flex-col">
                    <div class="p-1.5 max-h-56 overflow-y-auto space-y-1">
                      <button
                        v-for="s in schedules"
                        :key="s.id"
                        type="button"
                        @click="selectAreaSchedule(s, $event)"
                        class="w-full text-left px-3 py-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-between gap-2"
                        :class="selectedAreaSchedule && Number(selectedAreaSchedule.id) === Number(s.id)
                          ? 'bg-[#18181B] text-white'
                          : 'hover:bg-charcoal-50 text-charcoal-800'">
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="font-bold text-xs truncate">{{ s.nombre }}</span>
                            <span
                              v-if="Number(s.id) === Number(defaultBranchScheduleId)"
                              class="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
                              :class="selectedAreaSchedule && Number(selectedAreaSchedule.id) === Number(s.id)
                                ? 'bg-white/15 text-white'
                                : 'bg-emerald-50 text-emerald-700 border border-emerald-200'">
                              Por defecto
                            </span>
                          </div>
                          <div
                            class="text-[10px] mono-code mt-0.5 truncate"
                            :class="selectedAreaSchedule && Number(selectedAreaSchedule.id) === Number(s.id) ? 'text-white/75' : 'text-charcoal-500'">
                            {{ s.resumen_corto }} · {{ s.horas_semanales }}h/sem · {{ s.tolerancia_min }}m tol.
                          </div>
                        </div>
                        <i
                          v-if="selectedAreaSchedule && Number(selectedAreaSchedule.id) === Number(s.id)"
                          class="ph ph-check text-sm text-white shrink-0"></i>
                      </button>
                    </div>
                  </div>
                </div>

                <!-- Botón de Vista [ph-eye]: Ver detalle del horario seleccionado -->
                <button
                  type="button"
                  @click="toggleAreaScheduleDetail($event)"
                  :title="isAreaScheduleDetailVisible ? 'Ocultar detalle del horario' : 'Ver detalle del horario seleccionado'"
                  class="w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 cursor-pointer transition-colors"
                  :class="isAreaScheduleDetailVisible
                    ? 'bg-charcoal-900 text-white border-charcoal-900'
                    : 'bg-white hover:bg-charcoal-100 text-charcoal-700 border-charcoal-200'">
                  <i :class="['ph text-base', isAreaScheduleDetailVisible ? 'ph-eye-slash' : 'ph-eye']"></i>
                </button>

                <!-- Botón [+] a un lado del selector: convierte este mismo modal en el de creación de horario -->
                <button
                  type="button"
                  @click="openNewScheduleFromArea($event)"
                  title="Crear nuevo horario"
                  class="w-10 h-10 rounded-xl bg-[#18181B] hover:bg-black text-white flex items-center justify-center shrink-0 cursor-pointer transition-colors shadow-2xs">
                  <i class="ph ph-plus text-base"></i>
                </button>
              </div>
              <p class="text-[11px] text-charcoal-400 mt-1">
                Elige un horario, pulsa el icono de <b>vista</b> para ver su desglose o <b>+</b> para crear uno nuevo.
              </p>
            </div>

            <div>
              <label class="block font-bold text-charcoal-800 mb-1.5">Prefijos de ID para auto-asignación (Opcional)</label>
              <input
                v-model="form.prefijo_id"
                type="text"
                placeholder="Ej: 11, 12 (o dejar vacío)"
                class="w-full h-10 px-3.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              <p class="text-[11px] text-charcoal-400 mt-1">
                Auto-asigna empleados cuyos IDs del reloj inicien con estos prefijos.
              </p>
            </div>
          </div>

          <!-- Panel Desplegable de Vista de Detalle del Horario Seleccionado -->
          <div
            v-if="isAreaScheduleDetailVisible && selectedAreaSchedule"
            class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-3 animate-in fade-in duration-150">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="w-5 flex items-center justify-center shrink-0">
                  <i class="ph ph-calendar-check text-base text-charcoal-400"></i>
                </span>
                <span class="font-bold text-charcoal-900">{{ selectedAreaSchedule.nombre }}</span>
                <span
                  class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mono-code"
                  :class="selectedAreaSchedule.es_mixto ? 'bg-[#18181B] text-white' : 'bg-white border border-charcoal-200 text-charcoal-700'">
                  {{ selectedAreaSchedule.es_mixto ? 'Mixto / Parcial' : 'Fijo' }}
                </span>
              </div>
              <div class="flex items-center gap-2 mono-code text-[11px]">
                <span class="font-bold text-charcoal-900">{{ selectedAreaSchedule.horas_semanales }}h / sem</span>
                <span class="text-charcoal-300">·</span>
                <span class="font-bold text-emerald-700">{{ selectedAreaSchedule.tolerancia_min }} min tolerancia</span>
              </div>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <div
                v-for="d in WEEK_DAYS"
                :key="'area-preview-' + d.num"
                class="p-2.5 rounded-xl border text-center flex flex-col justify-between min-h-[60px]"
                :class="formatDayBlocksSummary(selectedAreaSchedule, d.num) === 'Descanso'
                  ? 'bg-charcoal-50/70 border-charcoal-200/60 text-charcoal-400'
                  : 'bg-white border-charcoal-200 text-charcoal-900 shadow-2xs'">
                <span class="text-[10px] font-bold uppercase tracking-wider block">{{ d.label }}</span>
                <span class="text-[10px] mono-code font-bold leading-tight mt-1 block">
                  {{ formatDayBlocksSummary(selectedAreaSchedule, d.num) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- VISTA 2: MODAL DE CREACIÓN / EDICIÓN DE HORARIO (EL MISMO MODAL SE CONVIERTE AQUÍ) -->
        <div v-else key="view-schedule-creator" class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start text-xs animate-in fade-in duration-150">

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
                  v-model="scheduleForm.nombre"
                  type="text"
                  placeholder="Ej: Mixto Partido Sistemas"
                  class="w-full h-9 px-3.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              </div>

              <div>
                <label class="block font-bold text-charcoal-800 mb-1">Descripción / Referencia (Opcional)</label>
                <input
                  v-model="scheduleForm.descripcion"
                  type="text"
                  placeholder="Ej: L-M-V partido 8-11 y 15-18, M-J tarde"
                  class="w-full h-9 px-3.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              </div>
            </div>

            <!-- Slider único de Tolerancia de Entrada (sin botones ni +/-) -->
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
                  {{ scheduleForm.tolerancia_min }} min
                </span>
              </div>

              <div class="pt-1 space-y-1.5">
                <input
                  type="range"
                  min="0"
                  max="60"
                  step="1"
                  :value="scheduleForm.tolerancia_min"
                  @input="setScheduleTolerance($event.target.value)"
                  :style="{
                    background: 'linear-gradient(to right, #18181B 0%, #18181B ' + Math.min(100, Math.round((Number(scheduleForm.tolerancia_min || 0) / 60) * 100)) + '%, #E4E4E7 ' + Math.min(100, Math.round((Number(scheduleForm.tolerancia_min || 0) / 60) * 100)) + '%, #E4E4E7 100%)'
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
            <ScheduleBlocksEditor v-model="scheduleForm.bloques" />
          </div>

        </div>
      </ModalBase>

    </div>
  `
};
