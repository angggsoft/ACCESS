// Component: ViewAdminSaas
// Consola Exclusiva del Administrador SaaS — Gestión de Usuarios y Suscripciones
// Aislamiento de Privacidad: Este rol NO tiene acceso a empresas, sucursales, relojes ni checadas.

import { ref, computed, onMounted } from 'vue';
import ModalBase from './ModalBase.js';
import { confirmDialog } from './ModalConfirm.js';

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
      suscripciones_suspendidas: 0,
      total_relojes_contratados: 0,
      total_relojes_activos: 0
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
      max_relojes: 1,
      notas: ''
    });

    // Modal Editar Suscripción
    const isEditModalOpen = ref(false);
    const editingUser = ref(null);
    const showEditPassword = ref(false);
    const editForm = ref({
      nombre: '',
      email: '',
      username: '',
      rol: '',
      plan: 'MENSUAL',
      estado: 'ACTIVA',
      fecha_vencimiento: '',
      max_empresas: 5,
      max_relojes: 1,
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
        max_relojes: 1,
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
      showEditPassword.value = false;
      editForm.value = {
        nombre: u.nombre || '',
        email: u.email || '',
        username: u.username || '',
        rol: u.puesto || '',
        plan: u.subscription?.plan || 'MENSUAL',
        estado: u.subscription?.estado || 'ACTIVA',
        fecha_vencimiento: u.subscription?.fecha_vencimiento || new Date().toISOString().slice(0, 10),
        max_empresas: u.subscription?.max_empresas ?? 5,
        max_relojes: u.subscription?.max_relojes ?? 1,
        activo: Boolean(u.activo),
        new_password: '',
        notas: u.subscription?.notas || ''
      };
      isEditModalOpen.value = true;
    }

    async function adjustClockQuota(u, delta) {
      const currentMax = u.subscription?.max_relojes ?? 1;
      const nextMax = Math.max(0, Number(currentMax) + delta);
      try {
        const res = await fetch(`/api/admin/users/${u.id}/subscription`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_relojes: nextMax })
        });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Capacidad de ${u.nombre}: ${nextMax} reloj(es) contratado(s)`);
          await fetchAdminUsers();
        } else {
          emit('toast', data.detail || 'No se pudo ajustar el cupo de relojes', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al ajustar cupo', 'error');
      }
    }

    async function deleteUserAccount(u) {
      if (!u) return;
      const confirmed = await confirmDialog({
        title: `¿Eliminar cuenta de ${u.nombre}?`,
        message: 'Esta acción eliminará al usuario, su suscripción y sus sesiones activas.',
        detail: `${u.email} (@${u.username})`,
        variant: 'danger',
        confirmLabel: 'Eliminar Cuenta'
      });
      if (!confirmed) return;

      try {
        const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
          emit('toast', data.message || 'Cuenta eliminada');
          isEditModalOpen.value = false;
          editingUser.value = null;
          await fetchAdminUsers();
        } else {
          emit('toast', data.detail || 'Error al eliminar la cuenta', 'error');
        }
      } catch (e) {
        emit('toast', 'Error de red al eliminar cuenta', 'error');
      }
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
      showEditPassword,
      editForm,
      openEditSubscription,
      setQuickRenewal,
      saveSubscriptionChanges,
      quickToggleStatus,
      adjustClockQuota,
      deleteUserAccount,
      fetchAdminUsers
    };
  },
  template: `
    <div class="w-full space-y-5 animate-in fade-in duration-150">

      <!-- 5 KPIS DE SUSCRIPCIONES Y RELOJES -->
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-charcoal-900">{{ kpis.total_usuarios_rh }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Usuarios RH</p>
            <p class="text-[11px] text-charcoal-400">registrados</p>
          </div>
        <i class="ph ph-users-three text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-charcoal-900">{{ kpis.suscripciones_activas }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Activas</p>
            <p class="text-[11px] text-charcoal-400">con acceso vigente</p>
          </div>
        <i class="ph ph-check-circle text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-charcoal-900">{{ kpis.suscripciones_vencidas }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Vencidas</p>
            <p class="text-[11px] text-charcoal-400">requieren renovación</p>
          </div>
        <i class="ph ph-clock-countdown text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4">
          <span class="text-4xl font-black text-charcoal-900">{{ kpis.suscripciones_suspendidas }}</span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Suspendidas</p>
            <p class="text-[11px] text-charcoal-400">pausadas manualmente</p>
          </div>
        <i class="ph ph-pause-circle text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
        <div class="bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm flex items-center gap-4 col-span-2 lg:col-span-1">
          <span class="text-2xl font-black mono-code text-charcoal-900">{{ kpis.total_relojes_activos || 0 }}<span class="text-charcoal-400 text-lg">/{{ kpis.total_relojes_contratados || 0 }}</span></span>
          <div>
            <p class="text-sm font-bold text-charcoal-900">Relojes Contratados</p>
            <p class="text-[11px] text-charcoal-400">en uso / pagados</p>
          </div>
        <i class="ph ph-fingerprint text-2xl text-charcoal-300 ml-auto shrink-0"></i>
        </div>
      </div>

      <!-- BARRA DE BÚSQUEDA, FILTRO Y ALTA -->
      <div class="bg-white rounded-3xl p-4 border border-charcoal-200 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div class="relative flex-1 max-w-md">
          <i class="ph ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-charcoal-400"></i>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Buscar cliente por nombre, correo o usuario..."
            class="w-full pl-10 pr-4 py-2 text-xs bg-offwhite border border-charcoal-200 rounded-full focus:outline-none focus:ring-2 focus:ring-charcoal-900">
        </div>

        <div class="flex items-center gap-2.5 flex-wrap">
          <span class="text-xs font-semibold text-charcoal-500">Estatus:</span>
          <select v-model="filterStatus" class="px-3.5 py-2 rounded-full border border-charcoal-200 text-xs font-semibold bg-white">
            <option value="TODOS">Todas las Cuentas</option>
            <option value="ACTIVA">Activas</option>
            <option value="VENCIDA">Vencidas</option>
            <option value="SUSPENDIDA">Suspendidas</option>
          </select>
          <button
            type="button"
            @click="openCreateUserModal"
            class="px-4 py-2 rounded-full bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors shadow-2xs whitespace-nowrap">
            <i class="ph ph-user-plus text-sm"></i>
            <span>Nuevo Usuario RH</span>
          </button>
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
                <th class="py-3.5 px-4">Relojes Contratados (Cobro por Reloj)</th>
                <th class="py-3.5 px-4">Empresas</th>
                <th class="py-3.5 px-6 text-right">Moderación y Suscripción</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr v-for="u in filteredUsers" :key="u.id" class="hover:bg-charcoal-50/70 transition-colors">
                <td class="py-4 px-6 mono-code font-bold text-charcoal-500">#{{ u.id }}</td>
                <td class="py-4 px-4">
                  <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full bg-charcoal-100 text-charcoal-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {{ (u.nombre || 'U').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-bold text-charcoal-900 text-sm">{{ u.nombre }}</span>
                        <span
                          v-if="!u.activo"
                          class="text-[11px] font-semibold text-rose-600">
                          Cuenta bloqueada
                        </span>
                      </div>
                      <div class="text-[11px] text-charcoal-500 mono-code">{{ u.email }} • @{{ u.username }}</div>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-4">
                  <span class="mono-code text-[11px] font-semibold text-charcoal-600">
                    {{ u.subscription?.plan || 'MENSUAL' }}
                  </span>
                </td>
                <td class="py-4 px-4">
                  <span
                    class="inline-flex items-center gap-1.5 text-[11px] font-semibold"
                    :class="u.subscription?.is_active ? 'text-charcoal-900' : (u.subscription?.estado === 'SUSPENDIDA' ? 'text-charcoal-500' : 'text-rose-600')">
                    <span class="w-1.5 h-1.5 rounded-full" :class="u.subscription?.is_active ? 'bg-emerald-500' : (u.subscription?.estado === 'SUSPENDIDA' ? 'bg-charcoal-300' : 'bg-rose-500')"></span>
                    {{ u.subscription?.estado || 'VENCIDA' }}
                  </span>
                </td>
                <td class="py-4 px-4">
                  <div class="mono-code font-bold text-charcoal-900">{{ u.subscription?.fecha_vencimiento }}</div>
                  <div class="text-[11px]" :class="u.subscription?.is_active ? 'text-charcoal-400 font-medium' : 'text-rose-600 font-semibold'">
                    {{ u.subscription?.is_active ? (u.subscription.dias_restantes + ' días restantes') : 'Acceso bloqueado' }}
                  </div>
                </td>
                <td class="py-4 px-4">
                  <div class="flex items-center gap-2">
                    <span
                      class="mono-code text-[11px] font-semibold"
                      :class="(u.relojes_vinculados_count || 0) >= (u.subscription?.max_relojes ?? 1) ? 'text-charcoal-900' : 'text-charcoal-500'">
                      {{ u.relojes_vinculados_count || 0 }} / {{ u.subscription?.max_relojes ?? 1 }} relojes
                    </span>
                    <div class="inline-flex items-center rounded-lg border border-charcoal-200 bg-white overflow-hidden">
                      <button
                        type="button"
                        @click="adjustClockQuota(u, -1)"
                        title="Quitar 1 licencia de reloj"
                        class="w-6 h-6 flex items-center justify-center text-charcoal-700 hover:bg-charcoal-100 font-bold cursor-pointer">
                        -
                      </button>
                      <button
                        type="button"
                        @click="adjustClockQuota(u, 1)"
                        title="Asignar +1 licencia de reloj"
                        class="w-6 h-6 flex items-center justify-center text-charcoal-700 hover:bg-charcoal-100 font-bold border-l border-charcoal-200 cursor-pointer">
                        +
                      </button>
                    </div>
                  </div>
                </td>
                <td class="py-4 px-4">
                  <span class="mono-code text-xs text-charcoal-700 font-semibold">
                    {{ u.empresas_vinculadas_count }} / {{ u.subscription?.max_empresas ?? 5 }}
                  </span>
                  <div class="text-[10px] text-charcoal-400">Datos internos ocultos</div>
                </td>
                <td class="py-4 px-6 text-right space-x-1.5 whitespace-nowrap">
                  <button
                    v-if="!u.subscription?.is_active"
                    type="button"
                    @click="quickToggleStatus(u, 'ACTIVA')"
                    class="px-3 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-900 text-[11px] font-semibold transition-colors cursor-pointer">
                    <i class="ph ph-check-circle"></i> Activar (+30d)
                  </button>
                  <button
                    v-else
                    type="button"
                    @click="quickToggleStatus(u, 'SUSPENDIDA')"
                    class="px-3 py-1.5 rounded-full bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-900 text-[11px] font-semibold transition-colors cursor-pointer">
                    <i class="ph ph-pause-circle"></i> Suspender
                  </button>
                  <button
                    type="button"
                    @click="openEditSubscription(u)"
                    class="px-3.5 py-1.5 rounded-full bg-[#18181B] hover:bg-black text-white text-[11px] font-bold transition-colors cursor-pointer">
                    <i class="ph ph-sliders-horizontal"></i> Moderar
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
        title="Registrar Nuevo Cliente RH"
        subtitle="Configura las credenciales iniciales, plan de suscripción y cupo contratado."
        confirmLabel="Crear Cuenta y Activar"
        size="xl"
        @close="isCreateModalOpen = false"
        @confirm="saveNewUser">
        <div class="space-y-4 text-xs">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Nombre Completo</label>
              <input v-model="newUserForm.nombre" type="text" placeholder="Ej: Laura Méndez"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Correo Electrónico (Login)</label>
              <input v-model="newUserForm.email" type="email" placeholder="laura@empresa.com"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Contraseña Inicial</label>
              <input v-model="newUserForm.password" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Puesto / Descripción</label>
              <input v-model="newUserForm.rol" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Plan</label>
              <select v-model="newUserForm.plan" class="w-full px-3 py-2.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                <option value="MENSUAL">MENSUAL</option>
                <option value="ANUAL ENTERPRISE">ANUAL ENTERPRISE</option>
                <option value="PRUEBA">PRUEBA (TRIAL)</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Días Vigencia</label>
              <input v-model.number="newUserForm.dias_vigencia" type="number" min="1"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Relojes Contratados</label>
              <input v-model.number="newUserForm.max_relojes" type="number" min="0"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Máx. Empresas</label>
              <input v-model.number="newUserForm.max_empresas" type="number" min="1"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>
        </div>
      </ModalBase>

      <!-- MODAL: MODERAR CUENTA Y SUSCRIPCIÓN DE USUARIO RH -->
      <ModalBase
        v-if="isEditModalOpen && editingUser"
        title="Moderar Cuenta y Suscripción"
        :subtitle="'Gestión de acceso, plan y licencias — Cliente #' + editingUser.id"
        confirmLabel="Guardar Cambios"
        size="wide"
        @close="isEditModalOpen = false"
        @confirm="saveSubscriptionChanges">

        <template #footer-left>
          <button
            type="button"
            @click="deleteUserAccount(editingUser)"
            class="px-4 py-2 rounded-full text-rose-600 hover:bg-rose-50 text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors">
            <i class="ph ph-trash text-sm"></i>
            <span>Eliminar Cuenta</span>
          </button>
        </template>

        <div class="space-y-5 text-xs">
          <!-- Ficha del Cliente RH (alineada al estilo de ficha de Reportes / Configuración) -->
          <div class="p-4 rounded-2xl bg-charcoal-50/70 border border-charcoal-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-start sm:items-center gap-3 min-w-0">
              <div class="w-9 h-9 rounded-full bg-[#18181B] text-white flex items-center justify-center text-xs font-bold shrink-0">
                {{ (editingUser.nombre || 'U').slice(0, 2).toUpperCase() }}
              </div>
              <div class="min-w-0 space-y-0.5">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-bold text-sm text-charcoal-900 truncate">{{ editingUser.nombre }}</span>
                  <span class="mono-code text-[11px] font-bold text-charcoal-500">#{{ editingUser.id }}</span>
                </div>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-charcoal-500 mono-code break-all">
                  <span>{{ editingUser.email }}</span>
                  <span>• @{{ editingUser.username }}</span>
                </div>
              </div>
            </div>

            <button
              type="button"
              @click="editForm.activo = !editForm.activo"
              class="px-3.5 py-2 rounded-xl border text-[11px] font-bold inline-flex items-center gap-2 shrink-0 self-start sm:self-center shadow-2xs cursor-pointer transition-colors"
              :class="editForm.activo
                ? 'bg-white border-charcoal-200 text-charcoal-900 hover:bg-charcoal-50'
                : 'bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100'">
              <span class="w-2 h-2 rounded-full" :class="editForm.activo ? 'bg-emerald-500' : 'bg-rose-500'"></span>
              <span>{{ editForm.activo ? 'Acceso habilitado' : 'Cuenta bloqueada' }}</span>
              <i class="ph ph-arrows-left-right text-charcoal-400"></i>
            </button>
          </div>

          <!-- Distribución fluida en columnas lado a lado en escritorio -->
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5 items-stretch">

            <!-- Columna 1: Datos de la Cuenta -->
            <div class="p-4 sm:p-5 rounded-2xl bg-white border border-charcoal-200 space-y-3.5 flex flex-col min-w-0">
              <div class="flex items-center gap-2 pb-2 border-b border-charcoal-100">
                <i class="ph ph-user-circle text-base text-charcoal-400 shrink-0"></i>
                <span class="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">
                  Datos del Cliente RH
                </span>
              </div>

              <div class="space-y-3 flex-1">
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Nombre Completo</label>
                  <input v-model="editForm.nombre" type="text"
                    class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                </div>
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Correo Electrónico</label>
                  <input v-model="editForm.email" type="email"
                    class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                </div>
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Usuario (Username)</label>
                  <input v-model="editForm.username" type="text"
                    class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                </div>
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Puesto / Cargo</label>
                  <input v-model="editForm.rol" type="text"
                    class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                </div>
              </div>
            </div>

            <!-- Columna 2: Suscripción, Vigencia y Notas -->
            <div class="p-4 sm:p-5 rounded-2xl bg-white border border-charcoal-200 space-y-3.5 flex flex-col min-w-0">
              <div class="flex items-center gap-2 pb-2 border-b border-charcoal-100">
                <i class="ph ph-credit-card text-base text-charcoal-400 shrink-0"></i>
                <span class="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">
                  Suscripción y Vigencia
                </span>
              </div>

              <div class="space-y-3 flex-1">
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Plan de Suscripción</label>
                  <select v-model="editForm.plan" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                    <option value="MENSUAL">MENSUAL</option>
                    <option value="ANUAL ENTERPRISE">ANUAL ENTERPRISE</option>
                    <option value="PRUEBA">PRUEBA (TRIAL)</option>
                  </select>
                </div>
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Estatus de Suscripción</label>
                  <select v-model="editForm.estado" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white font-semibold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                    <option value="ACTIVA">ACTIVA (Acceso Permitido)</option>
                    <option value="SUSPENDIDA">SUSPENDIDA (Acceso Pausado)</option>
                    <option value="VENCIDA">VENCIDA (Requiere Pago)</option>
                  </select>
                </div>
                <div>
                  <div class="flex flex-wrap items-center justify-between gap-1.5 mb-1">
                    <label class="font-bold text-charcoal-800">Fecha de Vencimiento</label>
                    <div class="flex items-center gap-1">
                      <button type="button" @click="setQuickRenewal(30)" class="px-2 py-0.5 rounded-md bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 font-bold text-[10px] border border-charcoal-200 cursor-pointer transition-colors">+30d</button>
                      <button type="button" @click="setQuickRenewal(365)" class="px-2 py-0.5 rounded-md bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 font-bold text-[10px] border border-charcoal-200 cursor-pointer transition-colors">+1 año</button>
                    </div>
                  </div>
                  <input v-model="editForm.fecha_vencimiento" type="date"
                    class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                </div>
                <div>
                  <label class="block font-bold text-charcoal-800 mb-1">Notas Administrativas</label>
                  <input v-model="editForm.notas" type="text" placeholder="Ej: Factura #402 pagada"
                    class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                </div>
              </div>
            </div>

            <!-- Columna 3: Capacidad, Cupo de Relojes/Empresas y Seguridad -->
            <div class="md:col-span-2 xl:col-span-1 flex flex-col gap-4 min-w-0">
              <div class="p-4 sm:p-5 rounded-2xl bg-offwhite border border-charcoal-200 space-y-3.5 flex-1">
                <div class="flex items-center gap-2 pb-2 border-b border-charcoal-200/70">
                  <i class="ph ph-fingerprint text-base text-charcoal-400 shrink-0"></i>
                  <span class="text-[11px] font-bold uppercase tracking-wider text-charcoal-400">
                    Licencias y Cupo
                  </span>
                </div>

                <div class="space-y-2.5">
                  <div>
                    <span class="font-bold text-charcoal-900 block">Relojes Checadores Contratados</span>
                    <span class="text-[11px] text-charcoal-500">
                      Uso actual: <b class="mono-code text-charcoal-800">{{ editingUser.relojes_vinculados_count || 0 }} / {{ editForm.max_relojes ?? 0 }}</b> reloj(es) vinculado(s)
                    </span>
                  </div>

                  <div class="flex flex-wrap items-center gap-1.5">
                    <button v-for="q in [1, 3, 5, 10]" :key="q" type="button" @click="editForm.max_relojes = q"
                      class="px-2.5 py-1 rounded-xl border text-[11px] font-bold mono-code cursor-pointer transition-colors"
                      :class="Number(editForm.max_relojes) === q ? 'bg-[#18181B] text-white border-[#18181B]' : 'bg-white text-charcoal-700 border-charcoal-200 hover:bg-charcoal-100'">
                      {{ q }}
                    </button>
                    <button type="button" @click="editForm.max_relojes = Number(editForm.max_relojes || 0) + 1"
                      class="px-2.5 py-1 rounded-xl bg-white hover:bg-charcoal-100 border border-charcoal-200 text-charcoal-900 text-[11px] font-bold mono-code cursor-pointer transition-colors">
                      +1
                    </button>
                  </div>
                </div>

                <div class="w-full h-1.5 rounded-full bg-charcoal-200 overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    :class="(editingUser.relojes_vinculados_count || 0) >= Number(editForm.max_relojes || 0) ? 'bg-rose-500' : 'bg-[#18181B]'"
                    :style="{ width: (Number(editForm.max_relojes) > 0 ? Math.min(100, Math.round(((editingUser.relojes_vinculados_count || 0) / Number(editForm.max_relojes)) * 100)) : 100) + '%' }">
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-3 pt-1">
                  <div class="min-w-0">
                    <label class="block font-bold text-charcoal-800 mb-1">Capacidad de Relojes</label>
                    <input v-model.number="editForm.max_relojes" type="number" min="0"
                      class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                  </div>
                  <div class="min-w-0">
                    <label class="block font-bold text-charcoal-800 mb-1">Límite de Empresas</label>
                    <input v-model.number="editForm.max_empresas" type="number" min="1"
                      class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code font-bold focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                  </div>
                </div>
              </div>

              <!-- Seguridad: Restablecer Contraseña -->
              <div class="p-4 sm:p-5 rounded-2xl bg-white border border-charcoal-200 space-y-2.5">
                <div class="flex flex-wrap items-center justify-between gap-1.5">
                  <div class="flex items-center gap-1.5">
                    <i class="ph ph-lock-key text-sm text-charcoal-400 shrink-0"></i>
                    <label class="font-bold text-charcoal-800">Restablecer Contraseña (Opcional)</label>
                  </div>
                  <button type="button" @click="showEditPassword = !showEditPassword" class="text-[10px] text-charcoal-600 hover:text-charcoal-900 font-semibold cursor-pointer">
                    {{ showEditPassword ? 'Ocultar' : 'Mostrar' }}
                  </button>
                </div>
                <input v-model="editForm.new_password" :type="showEditPassword ? 'text' : 'password'" placeholder="Dejar vacío para no cambiar"
                  class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              </div>
            </div>

          </div>
        </div>
      </ModalBase>

    </div>
  `
};
