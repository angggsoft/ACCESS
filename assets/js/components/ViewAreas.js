// Component: ViewAreas (Módulo de Empresa, Sucursales, Áreas/Turnos y Acceso RH)
// Centraliza la gestión de Empresas, Sucursales, Áreas/Turnos/Horarios y Clave Dinámica TOTP (5 min)

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import ModalBase from './ModalBase.js';
import { confirmDialog } from './ModalConfirm.js';

export default {
  name: 'ViewAreas',
  components: { ModalBase },
  props: {
    areas: { type: Array, default: () => [] },
    companies: { type: Array, default: () => [] },
    empresaId: { type: [Number, String, null], default: 1 },
    sucursalId: { type: [Number, String, null], default: 1 },
    initialSection: { type: String, default: 'empresas' } // 'empresas' | 'areas' | 'invitar' | 'unirse' | 'nueva_empresa'
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
    const form = ref({
      id: null,
      codigo: '',
      nombre: '',
      responsable: '',
      turno: 'Matutino Operativo',
      horario: '08:00 - 17:00',
      tolerancia_min: 10,
      dias_laborales: '1,2,3,4,5',
      ubicacion: 'Sucursal Activa'
    });

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
      form.value = {
        id: null,
        codigo: `AREA-0${props.areas.length + 1}`,
        nombre: '',
        responsable: '',
        turno: 'Matutino',
        horario: '08:00 - 17:00',
        tolerancia_min: 10,
        dias_laborales: '1,2,3,4,5',
        ubicacion: activeBranch.value?.nombre || 'Sucursal Activa'
      };
      isModalOpen.value = true;
    }

    function editArea(a) {
      form.value = {
        ...a,
        dias_laborales: a.dias_laborales || '1,2,3,4,5'
      };
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
          body: JSON.stringify({
            ...form.value,
            empresa_id: props.empresaId,
            sucursal_id: props.sucursalId
          })
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
      isModalOpen,
      form,
      isWorkDaySelected,
      toggleWorkDay,
      formatWorkDays,
      openNewArea,
      editArea,
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
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
            :class="activeSection === 'empresas' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <i class="ph ph-buildings text-base"></i>
            <span>Empresas y Sucursales</span>
          </button>

          <button
            type="button"
            @click="setSection('areas')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
            :class="activeSection === 'areas' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <i class="ph ph-clock-user text-base"></i>
            <span>Áreas, Turnos y Horarios</span>
            <span class="text-[10px] mono-code px-1.5 py-0.5 rounded-full"
              :class="activeSection === 'areas' ? 'bg-white/20 text-white' : 'bg-charcoal-100 text-charcoal-700'">
              {{ areas.length }}
            </span>
          </button>

          <button
            type="button"
            @click="setSection('invitar')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
            :class="activeSection === 'invitar' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <i class="ph ph-users-three text-base"></i>
            <span>Equipo y Acceso (Código)</span>
            <span v-if="activeCompany" class="text-[10px] mono-code px-1.5 py-0.5 rounded-full"
              :class="activeSection === 'invitar' ? 'bg-white/20 text-white' : 'bg-charcoal-100 text-charcoal-700'">
              {{ activeCompany?.usuarios_miembros?.length || 0 }}
            </span>
          </button>

          <button
            type="button"
            @click="setSection('nueva_empresa')"
            class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
            :class="activeSection === 'nueva_empresa' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <i class="ph ph-plus-circle text-base"></i>
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
                    <div class="font-bold text-xs flex items-center gap-1.5">
                      <i class="ph ph-map-pin"></i>
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
                    class="text-[11px] font-semibold flex items-center gap-1 cursor-pointer text-charcoal-600 hover:text-charcoal-900">
                    <i class="ph ph-clock-user"></i>
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
          <button
            type="button"
            @click="openNewArea"
            class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-1.5 shrink-0 cursor-pointer">
            <i class="ph ph-plus-circle text-sm"></i>
            <span>Nueva Área / Turno</span>
          </button>
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
                <div>
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Turno y Horario</span>
                  <span class="font-bold text-charcoal-900 mono-code">{{ a.turno }} ({{ a.horario }})</span>
                </div>
                <div>
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Tolerancia Entrada</span>
                  <span class="font-bold text-emerald-700 mono-code">{{ a.tolerancia_min }} minutos</span>
                </div>
                <div class="col-span-2">
                  <span class="text-[10px] font-bold uppercase text-charcoal-400 block">Días Laborales (Pre-Nómina)</span>
                  <span class="font-semibold text-charcoal-800">{{ formatWorkDays(a.dias_laborales) }}</span>
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

      <!-- MODAL: NUEVA / EDITAR ÁREA -->
      <ModalBase
        v-if="isModalOpen"
        title="Configurar Área y Horario Operativo en Sucursal"
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

          <div>
            <label class="block font-bold text-charcoal-800 mb-1.5">Días Laborales de la Semana (Cálculo de Faltas)</label>
            <div class="grid grid-cols-7 gap-1.5">
              <button
                v-for="d in WEEK_DAYS"
                :key="d.num"
                type="button"
                @click="toggleWorkDay(d.num)"
                class="py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer text-center"
                :class="isWorkDaySelected(d.num)
                  ? 'bg-[#18181B] text-white border-[#18181B]'
                  : 'bg-offwhite text-charcoal-600 border-charcoal-200 hover:bg-charcoal-100'">
                {{ d.label }}
              </button>
            </div>
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
