// Component: ViewAdminSaas
// Consola Exclusiva del Administrador SaaS — Gestión de Usuarios y Suscripciones
// Aislamiento de Privacidad: Este rol NO tiene acceso a empresas, sucursales, relojes ni checadas.

import { ref, computed, onMounted } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ViewAdminSaas',
  components: { ModalBase },
  emits: ['toast'],
  setup(props, { emit }) {
    const users = ref([]);
    const kpis = ref({
      total_usuarios_rh: 0,
      suscripciones_activas: 0,
      suscripciones_vencidas: 0,
      suscripciones_suspendidas: 0
    });
    const searchQuery = ref('');
    const filterStatus = ref('TODOS');
    const isLoading = ref(false);

    // Modal Crear Usuario RH
    const isCreateModalOpen = ref(false);
    const newUserForm = ref({
      nombre: '',
      email: '',
      username: '',
      password: '',
      rol: 'Gerente de Recursos Humanos',
      plan: 'MENSUAL',
      estado: 'ACTIVA',
      dias_vigencia: 30,
      max_empresas: 5,
      max_relojes: 10,
      notas: ''
    });

    // Modal Editar Suscripción
    const isEditModalOpen = ref(false);
    const editingUser = ref(null);
    const editForm = ref({
      plan: 'MENSUAL',
      estado: 'ACTIVA',
      fecha_vencimiento: '',
      max_empresas: 5,
      max_relojes: 10,
      activo: true,
      new_password: '',
      notas: ''
    });

    const filteredUsers = computed(() => {
      return users.value.filter(u => {
        const subState = u.subscription?.estado || 'VENCIDA';
        if (filterStatus.value !== 'TODOS' && subState !== filterStatus.value) return false;
        if (searchQuery.value.trim()) {
          const q = searchQuery.value.toLowerCase();
          return (
            (u.nombre || '').toLowerCase().includes(q) ||
            (u.email || '').toLowerCase().includes(q) ||
            (u.username || '').toLowerCase().includes(q)
          );
        }
        return true;
      });
    });

    async function fetchAdminUsers() {
      isLoading.value = true;
      try {
        const res = await fetch('/api/admin/users');
        if (!res.ok) return;
        const data = await res.json();
        users.value = data.users || [];
        if (data.kpis) kpis.value = data.kpis;
      } catch (e) {
        console.error(e);
      } finally {
        isLoading.value = false;
      }
    }

    function openCreateUserModal() {
      newUserForm.value = {
        nombre: '',
        email: '',
        username: '',
        password: '123456',
        rol: 'Gerente de Recursos Humanos',
        plan: 'MENSUAL',
        estado: 'ACTIVA',
        dias_vigencia: 30,
        max_empresas: 5,
        max_relojes: 10,
        notas: 'Alta manual por Administrador'
      };
      isCreateModalOpen.value = true;
    }

    async function saveNewUser() {
      if (!newUserForm.value.nombre || !newUserForm.value.email) {
        emit('toast', 'Nombre y correo electrónico son obligatorios', 'error');
        return;
      }
      try {
        const res = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newUserForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Usuario RH creado con éxito');
          isCreateModalOpen.value = false;
          await fetchAdminUsers();
        } else {
          emit('toast', data.detail || 'Error al crear usuario', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al crear usuario', 'error');
      }
    }

    function openEditSubscription(u) {
      editingUser.value = u;
      editForm.value = {
        plan: u.subscription?.plan || 'MENSUAL',
        estado: u.subscription?.estado || 'ACTIVA',
        fecha_vencimiento: u.subscription?.fecha_vencimiento || new Date().toISOString().slice(0, 10),
        max_empresas: u.subscription?.max_empresas || 5,
        max_relojes: u.subscription?.max_relojes || 10,
        activo: Boolean(u.activo),
        new_password: '',
        notas: u.subscription?.notas || ''
      };
      isEditModalOpen.value = true;
    }

    function setQuickRenewal(days) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      editForm.value.fecha_vencimiento = d.toISOString().slice(0, 10);
      editForm.value.estado = 'ACTIVA';
    }

    async function saveSubscriptionChanges() {
      if (!editingUser.value) return;
      try {
        const res = await fetch(`/api/admin/users/${editingUser.value.id}/subscription`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(editForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Suscripción de ${editingUser.value.nombre} actualizada`);
          isEditModalOpen.value = false;
          await fetchAdminUsers();
        } else {
          emit('toast', data.detail || 'Error al actualizar suscripción', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red', 'error');
      }
    }

    async function quickToggleStatus(u, newState) {
      const payload = {
        plan: u.subscription?.plan || 'MENSUAL',
        estado: newState,
        fecha_vencimiento: u.subscription?.fecha_vencimiento,
        max_empresas: u.subscription?.max_empresas || 5,
        max_relojes: u.subscription?.max_relojes || 10
      };
      if (newState === 'ACTIVA') {
        const today = new Date().toISOString().slice(0, 10);
        if (!payload.fecha_vencimiento || payload.fecha_vencimiento < today) {
          const nextMonth = new Date();
          nextMonth.setDate(nextMonth.getDate() + 30);
          payload.fecha_vencimiento = nextMonth.toISOString().slice(0, 10);
        }
      }
      const res = await fetch(`/api/admin/users/${u.id}/subscription`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        emit('toast', `Estado de ${u.nombre} cambiado a ${newState}`);
        await fetchAdminUsers();
      }
    }

    onMounted(() => {
      fetchAdminUsers();
    });

    return {
      users,
      kpis,
      searchQuery,
      filterStatus,
      filteredUsers,
      isLoading,
      isCreateModalOpen,
      newUserForm,
      openCreateUserModal,
      saveNewUser,
      isEditModalOpen,
      editingUser,
      editForm,
      openEditSubscription,
      setQuickRenewal,
      saveSubscriptionChanges,
      quickToggleStatus,
      fetchAdminUsers
    };
  },
  template: `
    <div class="w-full space-y-5 animate-in fade-in duration-150">

      <!-- BANNER DE SEGURIDAD Y PRIVACIDAD CONFIDENCIAL -->
      <div class="bg-[#18181B] text-white rounded-3xl p-5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="flex items-start sm:items-center gap-3.5">
          <div class="w-11 h-11 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center text-xl text-emerald-400 shrink-0">
            <i class="ph ph-shield-check"></i>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-base font-bold tracking-tight">Consola de Administración de Cuentas y Suscripciones</h2>
              <span class="text-[10px] mono-code font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                PRIVACIDAD GARANTIZADA
              </span>
            </div>
            <p class="text-xs text-charcoal-300 mt-0.5">
              Como Administrador de la plataforma gestionas el acceso y vigencia de las suscripciones de usuarios de RH. Por políticas de confidencialidad, los datos internos de empresas, sucursales, empleados y relojes están aislados y encriptados.
            </p>
          </div>
        </div>

        <button
          type="button"
          @click="openCreateUserModal"
          class="px-5 py-2.5 rounded-full bg-white hover:bg-charcoal-100 text-charcoal-950 text-xs font-bold flex items-center gap-2 shrink-0 cursor-pointer transition-all shadow-xs">
          <i class="ph ph-user-plus text-base"></i>
          <span>Nuevo Usuario RH</span>
        </button>
      </div>

      <!-- 4 KPIS DE SUSCRIPCIONES -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-charcoal-900">{{ kpis.total_usuarios_rh }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Usuarios RH</p>
            <p class="text-[11px] text-charcoal-400">registrados</p>
          </div>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-emerald-600">{{ kpis.suscripciones_activas }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Activas</p>
            <p class="text-[11px] text-charcoal-400">con acceso vigente</p>
          </div>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-rose-600">{{ kpis.suscripciones_vencidas }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Vencidas</p>
            <p class="text-[11px] text-charcoal-400">requieren renovación</p>
          </div>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-amber-600">{{ kpis.suscripciones_suspendidas }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Suspendidas</p>
            <p class="text-[11px] text-charcoal-400">pausadas manualmente</p>
          </div>
        </div>
      </div>

      <!-- BARRA DE BÚSQUEDA Y FILTRO -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-2xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar cliente por nombre, correo o usuario..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900">
        </div>

        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-charcoal-500">Estatus Suscripción:</span>
          <select v-model="filterStatus" class="px-3.5 py-2 rounded-full border border-charcoal-200 text-xs font-semibold bg-white">
            <option value="TODOS">Todas las Cuentas</option>
            <option value="ACTIVA">Activas</option>
            <option value="VENCIDA">Vencidas</option>
            <option value="SUSPENDIDA">Suspendidas</option>
          </select>
        </div>
      </div>

      <!-- TABLA DE CLIENTES RH Y SUSCRIPCIONES -->
      <div class="bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-charcoal-200 text-[10px] font-bold uppercase tracking-wider text-charcoal-400 bg-charcoal-50">
                <th class="py-3.5 px-6">ID</th>
                <th class="py-3.5 px-4">Cliente / Usuario RH</th>
                <th class="py-3.5 px-4">Plan Contratado</th>
                <th class="py-3.5 px-4">Estatus Suscripción</th>
                <th class="py-3.5 px-4">Corte / Vencimiento</th>
                <th class="py-3.5 px-4">Cuota de Empresas</th>
                <th class="py-3.5 px-6 text-right">Gestión de Suscripción</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="u in filteredUsers" :key="u.id" class="hover:bg-charcoal-50/70 transition-colors">
                <td class="py-4 px-6 mono-code font-bold text-charcoal-500">#{{ u.id }}</td>
                <td class="py-4 px-4">
                  <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-[#18181B] text-white flex items-center justify-center text-xs font-bold shrink-0">
                      {{ (u.nombre || 'U').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <div class="font-bold text-charcoal-900 text-sm">{{ u.nombre }}</div>
                      <div class="text-[11px] text-charcoal-500 mono-code">{{ u.email }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-4">
                  <span class="mono-code text-[11px] font-bold px-2.5 py-1 rounded-xl bg-charcoal-100 text-charcoal-900">
                    {{ u.subscription?.plan || 'MENSUAL' }}
                  </span>
                </td>
                <td class="py-4 px-4">
                  <span
                    class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border"
                    :class="u.subscription?.is_active
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : (u.subscription?.estado === 'SUSPENDIDA' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-rose-50 text-rose-700 border-rose-200')">
                    <span class="w-1.5 h-1.5 rounded-full" :class="u.subscription?.is_active ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'"></span>
                    {{ u.subscription?.estado || 'VENCIDA' }}
                  </span>
                </td>
                <td class="py-4 px-4">
                  <div class="mono-code font-bold text-charcoal-900">{{ u.subscription?.fecha_vencimiento }}</div>
                  <div class="text-[11px]" :class="u.subscription?.is_active ? 'text-emerald-600 font-medium' : 'text-rose-600 font-semibold'">
                    {{ u.subscription?.is_active ? (u.subscription.dias_restantes + ' días restantes') : 'Acceso bloqueado' }}
                  </div>
                </td>
                <td class="py-4 px-4">
                  <span class="mono-code text-xs text-charcoal-700 font-semibold">
                    {{ u.empresas_vinculadas_count }} / {{ u.subscription?.max_empresas || 5 }} empresas
                  </span>
                  <div class="text-[10px] text-charcoal-400">Datos internos ocultos</div>
                </td>
                <td class="py-4 px-6 text-right space-x-1.5">
                  <button
                    v-if="!u.subscription?.is_active"
                    type="button"
                    @click="quickToggleStatus(u, 'ACTIVA')"
                    class="px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold transition-colors cursor-pointer">
                    <i class="ph ph-check-circle"></i> Activar (+30d)
                  </button>
                  <button
                    v-else
                    type="button"
                    @click="quickToggleStatus(u, 'SUSPENDIDA')"
                    class="px-3 py-1.5 rounded-full bg-amber-100 hover:bg-amber-200 text-amber-900 text-[11px] font-bold transition-colors cursor-pointer">
                    <i class="ph ph-pause-circle"></i> Suspender
                  </button>
                  <button
                    type="button"
                    @click="openEditSubscription(u)"
                    class="px-3.5 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white text-[11px] font-bold transition-colors cursor-pointer">
                    <i class="ph ph-sliders-horizontal"></i> Configurar
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- MODAL: CREAR NUEVO USUARIO RH + SUSCRIPCIÓN -->
      <ModalBase
        v-if="isCreateModalOpen"
        title="Registrar Nuevo Cliente RH y Suscripción"
        confirmLabel="Crear Cuenta y Activar"
        size="md"
        @close="isCreateModalOpen = false"
        @confirm="saveNewUser">
        <div class="space-y-4 text-xs">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Nombre Completo</label>
              <input v-model="newUserForm.nombre" type="text" placeholder="Ej: Laura Méndez"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Correo Electrónico (Login)</label>
              <input v-model="newUserForm.email" type="email" placeholder="laura@empresa.com"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Contraseña Inicial</label>
              <input v-model="newUserForm.password" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Puesto / Descripción</label>
              <input v-model="newUserForm.rol" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
            </div>
          </div>

          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Plan</label>
              <select v-model="newUserForm.plan" class="w-full px-3 py-2.5 rounded-xl border border-charcoal-200 bg-white font-semibold">
                <option value="MENSUAL">MENSUAL</option>
                <option value="ANUAL ENTERPRISE">ANUAL ENTERPRISE</option>
                <option value="PRUEBA">PRUEBA (TRIAL)</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Días de Vigencia</label>
              <input v-model="newUserForm.dias_vigencia" type="number"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Máx. Empresas</label>
              <input v-model="newUserForm.max_empresas" type="number"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold">
            </div>
          </div>
        </div>
      </ModalBase>

      <!-- MODAL: EDITAR SUSCRIPCIÓN DE USUARIO RH -->
      <ModalBase
        v-if="isEditModalOpen && editingUser"
        :title="'Gestionar Suscripción — ' + editingUser.nombre"
        confirmLabel="Guardar Cambios"
        size="md"
        @close="isEditModalOpen = false"
        @confirm="saveSubscriptionChanges">
        <div class="space-y-4 text-xs">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Plan de Suscripción</label>
              <select v-model="editForm.plan" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white font-bold">
                <option value="MENSUAL">MENSUAL</option>
                <option value="ANUAL ENTERPRISE">ANUAL ENTERPRISE</option>
                <option value="PRUEBA">PRUEBA (TRIAL)</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Estatus de Acceso</label>
              <select v-model="editForm.estado" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white font-bold">
                <option value="ACTIVA">ACTIVA (Acceso Permitido)</option>
                <option value="SUSPENDIDA">SUSPENDIDA (Acceso Pausado)</option>
                <option value="VENCIDA">VENCIDA (Requiere Pago)</option>
              </select>
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="font-bold text-charcoal-800">Fecha de Vencimiento</label>
              <div class="flex items-center gap-1.5">
                <button type="button" @click="setQuickRenewal(30)" class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold text-[10px] border border-emerald-200 cursor-pointer">+30 días</button>
                <button type="button" @click="setQuickRenewal(365)" class="px-2 py-0.5 rounded bg-sky-50 text-sky-700 font-bold text-[10px] border border-sky-200 cursor-pointer">+1 año</button>
              </div>
            </div>
            <input v-model="editForm.fecha_vencimiento" type="date"
              class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code font-bold">
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Límite de Empresas</label>
              <input v-model="editForm.max_empresas" type="number"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Restablecer Contraseña (Opcional)</label>
              <input v-model="editForm.new_password" type="text" placeholder="Dejar vacío para no cambiar"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code">
            </div>
          </div>

          <div>
            <label class="block font-bold text-charcoal-800 mb-1">Notas Administrativas</label>
            <input v-model="editForm.notas" type="text" placeholder="Ej: Factura #402 pagada"
              class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200">
          </div>
        </div>
      </ModalBase>

    </div>
  `
};
