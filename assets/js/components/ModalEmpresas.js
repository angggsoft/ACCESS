// Component: ModalEmpresas
// Gestión Multi-Empresa, Multi-Sucursal e Invitación Segura con Clave Dinámica cada 5 Minutos (TOTP 300s)

import { ref, computed, watch, onUnmounted } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ModalEmpresas',
  components: { ModalBase },
  props: {
    isOpen: { type: Boolean, default: false },
    initialTab: { type: String, default: 'selector' }, // 'selector' | 'invitar' | 'unirse' | 'nueva_empresa'
    companies: { type: Array, default: () => [] },
    activeCompanyId: { type: [Number, String, null], default: null },
    activeBranchId: { type: [Number, String, null], default: null }
  },
  emits: ['close', 'select-scope', 'refresh-companies', 'toast'],
  setup(props, { emit }) {
    const currentTab = ref('selector');
    const feedback = ref({ type: '', message: '' });

    // Estado Clave Dinámica TOTP (cada 5 minutos = 300s)
    const totpData = ref({
      codigo_invitacion: '',
      clave_dinamica: '------',
      clave_formateada: '--- ---',
      expires_in_seconds: 300,
      window_seconds: 300
    });
    const isLoadingTotp = ref(false);
    let totpCountdownTimer = null;

    // Formulario Unirse a Empresa
    const joinForm = ref({
      codigo_invitacion: '',
      clave_dinamica: ''
    });
    const isJoining = ref(false);

    // Formulario Nueva Empresa
    const newCompForm = ref({
      nombre: '',
      rfc: '',
      industria: 'Manufactura y Operaciones',
      sucursal_inicial: 'Sucursal Matriz'
    });
    const isCreatingComp = ref(false);

    // Formulario Nueva Sucursal
    const isAddingBranch = ref(false);
    const newBranchForm = ref({
      nombre: '',
      ubicacion: '',
      codigo: '',
      debounce_seconds: 180,
      tolerancia_minutos: 10
    });

    const activeCompany = computed(() => {
      return props.companies.find(c => c.id === props.activeCompanyId) || props.companies[0] || null;
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

    async function fetchInviteTotp() {
      if (!activeCompany.value || !activeCompany.value.is_owner) return;
      isLoadingTotp.value = true;
      try {
        const res = await fetch(`/api/companies/${activeCompany.value.id}/invite-totp`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.invitation) {
          totpData.value = data.invitation;
        }
      } catch (e) {
        console.error(e);
      } finally {
        isLoadingTotp.value = false;
      }
    }

    function startTotpTimer() {
      stopTotpTimer();
      totpCountdownTimer = setInterval(() => {
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

    watch(() => props.isOpen, (open) => {
      if (open) {
        currentTab.value = props.initialTab || 'selector';
        feedback.value = { type: '', message: '' };
        if (activeCompany.value && activeCompany.value.is_owner) {
          fetchInviteTotp();
          startTotpTimer();
        }
      } else {
        stopTotpTimer();
      }
    });

    watch([currentTab, () => props.activeCompanyId], () => {
      if (props.isOpen && currentTab.value === 'invitar' && activeCompany.value?.is_owner) {
        fetchInviteTotp();
        startTotpTimer();
      }
    });

    onUnmounted(() => {
      stopTotpTimer();
    });

    function selectCompanyAndBranch(compId, branchId) {
      emit('select-scope', { empresaId: compId, sucursalId: branchId });
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
          currentTab.value = 'selector';
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
          currentTab.value = 'selector';
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

    return {
      currentTab,
      feedback,
      activeCompany,
      totpData,
      isLoadingTotp,
      formattedCountdown,
      countdownProgressPct,
      fetchInviteTotp,
      copyInviteCredentials,
      joinForm,
      isJoining,
      submitJoinCompany,
      newCompForm,
      isCreatingComp,
      submitCreateCompany,
      isAddingBranch,
      newBranchForm,
      submitCreateBranch,
      selectCompanyAndBranch
    };
  },
  template: `
    <ModalBase
      v-if="isOpen"
      title="Centro Multi-Empresa, Sucursales y Acceso Seguro"
      size="xl"
      confirmLabel="Cerrar"
      @close="$emit('close')"
      @confirm="$emit('close')">

      <!-- PESTAÑAS -->
      <div class="flex items-center gap-2 pb-5 border-b border-charcoal-100 overflow-x-auto">
        <button
          type="button"
          @click="currentTab = 'selector'; feedback.message = ''"
          class="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          :class="currentTab === 'selector' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
          <i class="ph ph-buildings"></i>
          <span>Mis Empresas y Sucursales</span>
        </button>

        <button
          type="button"
          @click="currentTab = 'invitar'; feedback.message = ''"
          class="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          :class="currentTab === 'invitar' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
          <i class="ph ph-key"></i>
          <span>Invitar RH (Clave 5 min)</span>
        </button>

        <button
          type="button"
          @click="currentTab = 'unirse'; feedback.message = ''"
          class="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          :class="currentTab === 'unirse' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
          <i class="ph ph-sign-in"></i>
          <span>Unirse con Código</span>
        </button>

        <button
          type="button"
          @click="currentTab = 'nueva_empresa'; feedback.message = ''"
          class="px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap"
          :class="currentTab === 'nueva_empresa' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
          <i class="ph ph-plus-circle"></i>
          <span>Nueva Empresa</span>
        </button>
      </div>

      <!-- ALERTA DE ERROR / INFO -->
      <div v-if="feedback.message" class="mt-5 p-4 rounded-2xl text-xs flex items-center justify-between"
        :class="feedback.type === 'error' ? 'bg-rose-50 text-rose-800 border border-rose-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'">
        <div class="flex items-center gap-2">
          <i :class="['ph', feedback.type === 'error' ? 'ph-warning-circle text-rose-600' : 'ph-check-circle text-emerald-600', 'text-base']"></i>
          <span class="font-medium">{{ feedback.message }}</span>
        </div>
        <button type="button" @click="feedback.message = ''" class="cursor-pointer"><i class="ph ph-x"></i></button>
      </div>

      <!-- TAB 1: MIS EMPRESAS Y SUCURSALES -->
      <div v-if="currentTab === 'selector'" class="space-y-6 pt-6 text-xs">
        <div v-for="comp in companies" :key="comp.id"
          class="p-6 rounded-3xl border transition-all"
          :class="comp.id === activeCompanyId ? 'bg-offwhite border-charcoal-900 shadow-xs' : 'bg-white border-charcoal-200'">
          
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-charcoal-200/70">
            <div>
              <div class="flex items-center gap-2">
                <h4 class="text-sm font-bold text-charcoal-900">{{ comp.nombre }}</h4>
                <span class="text-[10px] mono-code font-bold px-2 py-0.5 rounded-full"
                  :class="comp.is_owner ? 'bg-[#18181B] text-white' : 'bg-sky-50 text-sky-700 border border-sky-200'">
                  {{ comp.is_owner ? 'ADMINISTRADOR (CREADOR)' : 'MIEMBRO RH' }}
                </span>
              </div>
              <p class="text-[11px] text-charcoal-500 mt-0.5">
                {{ comp.industria }} • Código Empresa: <b class="mono-code text-charcoal-800">{{ comp.codigo_invitacion }}</b>
              </p>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="comp.is_owner"
                type="button"
                @click="selectCompanyAndBranch(comp.id, comp.sucursales[0]?.id); currentTab = 'invitar'"
                class="px-3 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-900 font-bold text-[11px] flex items-center gap-1 cursor-pointer">
                <i class="ph ph-key"></i> Clave Invitación
              </button>
              <button
                type="button"
                @click="selectCompanyAndBranch(comp.id, comp.sucursales[0]?.id); isAddingBranch = true"
                class="px-3 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white font-bold text-[11px] flex items-center gap-1 cursor-pointer">
                <i class="ph ph-plus"></i> Sucursal
              </button>
            </div>
          </div>

          <!-- Lista de Sucursales de esta Empresa -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-5">
            <button
              v-for="suc in comp.sucursales"
              :key="suc.id"
              type="button"
              @click="selectCompanyAndBranch(comp.id, suc.id)"
              class="text-left p-4 rounded-2xl border transition-all flex items-center justify-between cursor-pointer"
              :class="(comp.id === activeCompanyId && suc.id === activeBranchId)
                ? 'bg-[#18181B] text-white border-[#18181B]'
                : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200'">
              <div>
                <div class="font-bold text-xs flex items-center gap-1.5">
                  <i class="ph ph-map-pin"></i>
                  <span>{{ suc.nombre }}</span>
                </div>
                <p class="text-[10px] mt-0.5" :class="(comp.id === activeCompanyId && suc.id === activeBranchId) ? 'text-charcoal-300' : 'text-charcoal-400'">
                  {{ suc.relojes_count || 0 }} reloj(es) • {{ suc.empleados_count || 0 }} empleados
                </p>
              </div>
              <i v-if="comp.id === activeCompanyId && suc.id === activeBranchId" class="ph ph-check-circle text-emerald-400 text-base"></i>
            </button>
          </div>
        </div>

        <!-- Formulario Inline para Agregar Nueva Sucursal a la Empresa Activa -->
        <div v-if="isAddingBranch && activeCompany" class="p-6 rounded-3xl bg-charcoal-50 border border-charcoal-300 space-y-5">
          <div class="flex items-center justify-between">
            <h5 class="font-bold text-charcoal-900">Agregar Nueva Sucursal en {{ activeCompany.nombre }}</h5>
            <button type="button" @click="isAddingBranch = false" class="text-charcoal-400 hover:text-black cursor-pointer"><i class="ph ph-x"></i></button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div>
              <label class="block font-bold text-charcoal-700 mb-2">Nombre de la Sucursal</label>
              <input v-model="newBranchForm.nombre" type="text" placeholder="Ej: Sucursal Querétaro Sur"
                class="w-full px-4 py-3 rounded-xl border border-charcoal-200 bg-white">
            </div>
            <div>
              <label class="block font-bold text-charcoal-700 mb-2">Ubicación / Dirección</label>
              <input v-model="newBranchForm.ubicacion" type="text" placeholder="Ej: Parque Industrial Bernardo Quintana"
                class="w-full px-4 py-3 rounded-xl border border-charcoal-200 bg-white">
            </div>
          </div>
          <div class="flex justify-end pt-2">
            <button type="button" @click="submitCreateBranch"
              class="px-4 py-2 rounded-full bg-[#18181B] text-white font-bold text-xs cursor-pointer">
              Guardar Sucursal
            </button>
          </div>
        </div>
      </div>

      <!-- TAB 2: INVITAR A EMPRESA CON CLAVE DINÁMICA DE 5 MINUTOS (TOTP 300s) -->
      <div v-else-if="currentTab === 'invitar'" class="space-y-6 pt-6 text-xs">
        <div v-if="!activeCompany || !activeCompany.is_owner" class="p-6 rounded-3xl bg-amber-50 border border-amber-200 text-amber-900">
          <p class="font-bold text-sm mb-1">Solo el Creador/Administrador de la empresa puede emitir invitaciones</p>
          <p class="text-xs opacity-90">
            En la empresa <b>{{ activeCompany?.nombre }}</b> tienes el rol de Miembro RH invitado. Selecciona una empresa creada por ti para ver su Clave Dinámica.
          </p>
        </div>

        <div v-else class="space-y-6">
          <div class="p-7 rounded-3xl bg-[#18181B] text-white space-y-5">
            <div class="flex items-center justify-between">
              <div>
                <span class="text-[10px] mono-code uppercase tracking-wider text-emerald-400 font-bold block">
                  Autorización Criptográfica TOTP • Ventana de 5 Minutos
                </span>
                <h4 class="text-base font-bold mt-0.5">{{ activeCompany.nombre }}</h4>
              </div>
              <button
                type="button"
                @click="copyInviteCredentials"
                class="px-3.5 py-2 rounded-full bg-white text-charcoal-950 font-bold text-xs flex items-center gap-1.5 hover:bg-charcoal-100 cursor-pointer">
                <i class="ph ph-copy"></i> Copiar Datos
              </button>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div class="p-5 rounded-2xl bg-white/10 border border-white/15">
                <span class="text-[10px] uppercase text-charcoal-300 font-bold block">1. Código de Invitación Empresa</span>
                <span class="text-xl mono-code font-black tracking-wider text-white mt-1 block">
                  {{ totpData.codigo_invitacion || activeCompany.codigo_invitacion }}
                </span>
              </div>

              <div class="p-5 rounded-2xl bg-emerald-500/15 border border-emerald-400/30">
                <div class="flex items-center justify-between">
                  <span class="text-[10px] uppercase text-emerald-300 font-bold">2. Clave Dinámica (5 min)</span>
                  <span class="text-[11px] mono-code font-bold text-emerald-300 flex items-center gap-1">
                    <i class="ph ph-timer"></i> {{ formattedCountdown }}
                  </span>
                </div>
                <span class="text-2xl mono-code font-black tracking-widest text-emerald-300 mt-1 block">
                  {{ totpData.clave_formateada }}
                </span>
              </div>
            </div>

            <!-- Barra de progreso de los 5 minutos -->
            <div class="space-y-1">
              <div class="w-full h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  class="h-full bg-emerald-400 transition-all duration-1000"
                  :style="{ width: countdownProgressPct + '%' }"></div>
              </div>
              <p class="text-[11px] text-charcoal-300">
                Esta clave se regenera automáticamente cada <b>5 minutos</b>. Compártela únicamente con el personal de RH que deseas autorizar en tu empresa.
              </p>
            </div>
          </div>

          <!-- Lista de Usuarios con Acceso a esta Empresa -->
          <div class="p-6 rounded-3xl bg-white border border-charcoal-200 space-y-3">
            <h5 class="font-bold text-charcoal-900">Usuarios de RH con acceso a {{ activeCompany.nombre }}</h5>
            <div class="divide-y divide-charcoal-100">
              <div v-for="m in activeCompany.usuarios_miembros" :key="m.id" class="py-3 flex items-center justify-between">
                <div>
                  <span class="font-bold text-charcoal-900">{{ m.nombre }}</span>
                  <span class="text-charcoal-400 mono-code ml-2">{{ m.email }}</span>
                </div>
                <span class="text-[10px] mono-code font-bold px-2 py-0.5 rounded-full"
                  :class="m.rol_empresa === 'OWNER' ? 'bg-charcoal-900 text-white' : 'bg-charcoal-100 text-charcoal-700'">
                  {{ m.rol_empresa }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 3: UNIRSE A UNA EMPRESA CON CÓDIGO + CLAVE DINÁMICA 5 MIN -->
      <div v-else-if="currentTab === 'unirse'" class="space-y-6 pt-6 text-xs">
        <div class="p-6 rounded-3xl bg-offwhite border border-charcoal-200">
          <p class="font-bold text-charcoal-900 mb-2">Vincularme a una Empresa Existente</p>
          <p class="text-[11px] text-charcoal-500">
            Solicita al creador de la empresa el <b>Código de Invitación</b> y la <b>Clave Dinámica de 6 dígitos</b> vigente (la clave cambia cada 5 minutos por seguridad).
          </p>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label class="block font-bold text-charcoal-800 mb-2">Código de Invitación de la Empresa</label>
            <input v-model="joinForm.codigo_invitacion" type="text" placeholder="Ej: EMP-QUODO-01"
              class="w-full px-4 py-3 rounded-xl border border-charcoal-200 mono-code font-bold uppercase">
          </div>
          <div>
            <label class="block font-bold text-charcoal-800 mb-2">Clave Dinámica Vigente (6 dígitos)</label>
            <input v-model="joinForm.clave_dinamica" type="text" maxlength="7" placeholder="Ej: 482910"
              class="w-full px-4 py-3 rounded-xl border border-charcoal-200 mono-code font-bold tracking-widest">
          </div>
        </div>

        <div class="flex justify-end pt-2">
          <button
            type="button"
            :disabled="isJoining"
            @click="submitJoinCompany"
            class="px-5 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white font-bold text-xs flex items-center gap-2 cursor-pointer">
            <i class="ph ph-check-circle"></i>
            <span>{{ isJoining ? 'Verificando Clave Dinámica...' : 'Validar y Unirme a la Empresa' }}</span>
          </button>
        </div>
      </div>

      <!-- TAB 4: CREAR NUEVA EMPRESA -->
      <div v-else-if="currentTab === 'nueva_empresa'" class="space-y-6 pt-6 text-xs">
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

    </ModalBase>
  `
};
