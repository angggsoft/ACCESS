// Component: ViewConfiguracion
// Centro de Configuración Unificado e Intuitivo para Asistencia, Hardware ISAPI, Servidor, Correo y Operador

import { ref, computed, watch, onMounted } from 'vue';

export default {
  name: 'ViewConfiguracion',
  props: {
    devices: { type: Array, default: () => [] },
    companies: { type: Array, default: () => [] },
    user: { type: Object, default: () => ({ name: '', role: '', email: '', username: '', subscription: {} }) }
  },
  emits: ['toast', 'refresh', 'update-user'],
  setup(props, { emit }) {
    const activeTab = ref('cuenta');
    const isSaving = ref(false);

    // Formulario de parámetros de sistema y cuenta
    const form = ref({
      debounce_seconds: 180,
      tolerancia_minutos: 10,
      operator_name: props.user?.name || '',
      operator_role: props.user?.role || '',
      operator_email: props.user?.email || '',
      username: props.user?.username || '',
      operator_shift: props.user?.shift || 'Oficina RH',
      new_password: '',
      sound_alerts: true,
      auto_scroll: true,
      notify_unnamed_employees: true
    });

    const sub = computed(() => props.user?.subscription || {});
    const clocksUsed = computed(() => sub.value?.relojes_usados ?? props.devices.length);
    const clocksMax = computed(() => sub.value?.max_relojes ?? 1);
    const clocksPct = computed(() => clocksMax.value > 0 ? Math.min(100, Math.round((clocksUsed.value / clocksMax.value) * 100)) : 100);
    const companiesUsed = computed(() => sub.value?.empresas_usadas ?? props.companies.length);
    const companiesMax = computed(() => sub.value?.max_empresas ?? 5);

    watch(() => props.user, (u) => {
      if (!u) return;
      if (u.name) form.value.operator_name = u.name;
      if (u.role) form.value.operator_role = u.role;
      if (u.email) form.value.operator_email = u.email;
      if (u.username) form.value.username = u.username;
      if (u.shift) form.value.operator_shift = u.shift;
    }, { immediate: true });

    // Formulario SMTP para envío de correos
    const smtpForm = ref({
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_user: '',
      smtp_password: '',
      smtp_security: 'STARTTLS',
      remitente_nombre: 'ACCESS - Control Biométrico',
      remitente_email: '',
      destinatario_default: ''
    });
    const isSavingSmtp = ref(false);
    const isTestingSmtp = ref(false);
    const smtpFeedback = ref({ type: '', message: '' });
    const isSmtpConfigured = ref(false);

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = await res.json();
        if (data.settings) {
          const s = data.settings;
          form.value.debounce_seconds = parseInt(s.debounce_seconds) || 180;
          form.value.tolerancia_minutos = parseInt(s.tolerancia_minutos) || 10;
          if (!props.user?.name && s.operator_name) form.value.operator_name = s.operator_name;
          if (!props.user?.role && s.operator_role) form.value.operator_role = s.operator_role;
          if (!props.user?.email && s.operator_email) form.value.operator_email = s.operator_email;
          if (!props.user?.shift && s.operator_shift) form.value.operator_shift = s.operator_shift;
          form.value.sound_alerts = s.sound_alerts === '1' || s.sound_alerts === true;
          form.value.auto_scroll = s.auto_scroll === '1' || s.auto_scroll === true;
          form.value.notify_unnamed_employees = s.notify_unnamed_employees === undefined ? true : (s.notify_unnamed_employees === '1' || s.notify_unnamed_employees === true);
        }
      } catch (e) {
        console.error('Error cargando configuración:', e);
      }
    }

    async function loadEmailConfig() {
      try {
        const res = await fetch('/api/email/config');
        if (!res.ok) return;
        const json = await res.json();
        if (json.config) {
          isSmtpConfigured.value = Boolean(json.config.is_configured);
          smtpForm.value = {
            ...smtpForm.value,
            ...json.config,
            smtp_password: json.config.has_password ? '••••••••' : ''
          };
        }
      } catch (e) {
        // silent
      }
    }

    async function saveSettings(silent = false) {
      isSaving.value = true;
      try {
        const payload = {
          debounce_seconds: form.value.debounce_seconds,
          tolerancia_minutos: form.value.tolerancia_minutos,
          operator_name: form.value.operator_name,
          operator_role: form.value.operator_role,
          operator_email: form.value.operator_email,
          username: form.value.username,
          operator_shift: form.value.operator_shift,
          sound_alerts: form.value.sound_alerts ? '1' : '0',
          auto_scroll: form.value.auto_scroll ? '1' : '0',
          notify_unnamed_employees: form.value.notify_unnamed_employees ? '1' : '0'
        };
        if (form.value.new_password && form.value.new_password.trim()) {
          payload.new_password = form.value.new_password.trim();
        }

        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok) {
          form.value.new_password = '';
          localStorage.setItem('quodo_access_user', form.value.operator_name);
          emit('update-user', data.user || {
            name: form.value.operator_name,
            role: form.value.operator_role,
            email: form.value.operator_email,
            username: form.value.username,
            shift: form.value.operator_shift
          });
          if (!silent) emit('toast', 'Cuenta y configuración actualizadas correctamente.');
          emit('refresh');
        } else {
          if (!silent) emit('toast', data.detail || 'Error guardando configuración', 'error');
        }
      } catch (e) {
        if (!silent) emit('toast', 'Error de red al guardar', 'error');
      } finally {
        isSaving.value = false;
      }
    }

    function setDebouncePreset(seconds) {
      form.value.debounce_seconds = seconds;
      saveSettings(true);
      emit('toast', `Filtro anti-rebote establecido a ${seconds} segundos (${Math.round(seconds / 60)} min).`);
    }

    // Guardar ajustes SMTP
    async function saveSmtp() {
      isSavingSmtp.value = true;
      smtpFeedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/email/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(smtpForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          smtpFeedback.value = { type: 'success', message: 'Servidor SMTP guardado correctamente.' };
          await loadEmailConfig();
          emit('toast', 'Ajustes de correo guardados');
        } else {
          smtpFeedback.value = { type: 'error', message: data.detail || 'Error al guardar SMTP.' };
          emit('toast', 'Error guardando correo', 'error');
        }
      } catch (e) {
        smtpFeedback.value = { type: 'error', message: 'Error de red.' };
      } finally {
        isSavingSmtp.value = false;
      }
    }

    // Probar envío de correo SMTP
    async function testSmtp() {
      isTestingSmtp.value = true;
      smtpFeedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/email/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...smtpForm.value,
            to_email: smtpForm.value.destinatario_default || smtpForm.value.smtp_user
          })
        });
        const data = await res.json();
        if (res.ok) {
          smtpFeedback.value = { type: 'success', message: '¡Correo de prueba enviado con éxito!' };
          emit('toast', 'Correo de prueba enviado con éxito');
        } else {
          smtpFeedback.value = { type: 'error', message: data.detail || 'Fallo en la prueba de correo.' };
          emit('toast', 'Error en prueba de correo', 'error');
        }
      } catch (e) {
        smtpFeedback.value = { type: 'error', message: 'Error al conectar con el servidor de correo.' };
      } finally {
        isTestingSmtp.value = false;
      }
    }

    function applySmtpPreset(provider) {
      if (provider === 'gmail') {
        smtpForm.value.smtp_host = 'smtp.gmail.com';
        smtpForm.value.smtp_port = 587;
        smtpForm.value.smtp_security = 'STARTTLS';
      } else if (provider === 'outlook') {
        smtpForm.value.smtp_host = 'smtp.office365.com';
        smtpForm.value.smtp_port = 587;
        smtpForm.value.smtp_security = 'STARTTLS';
      }
    }

    // Acordeón de FAQs
    const openFaq = ref(null);
    function toggleFaq(i) {
      openFaq.value = openFaq.value === i ? null : i;
    }

    const faqs = [
      {
        q: '¿Qué es el filtro anti-rebote (Debounce) y por qué es importante?',
        a: 'Cuando un colaborador pasa su huella o rostro dos o más veces seguidas por duda o prisa, el sistema solo toma la primera checada como válida dentro de la ventana de tiempo elegida (por ejemplo, 3 minutos). Las checadas repetidas se clasifican como REBOTE IGNORADO para que la pre-nómina no duplique horas ni genere falsas anomalías.'
      },
      {
        q: '¿Qué sucede si se interrumpe el Wi-Fi o la red local de la empresa?',
        a: 'No se pierde ninguna checada. La terminal Hikvision cuenta con memoria flash interna autónoma con capacidad para más de 100,000 registros. En cuanto la red se restablece, el sistema ejecuta un Auto-Pull que descarga todas las checadas acumuladas en orden cronológico exacto.'
      },
      {
        q: '¿Cómo doy de alta a un colaborador nuevo?',
        a: 'Enrola su huella o rostro directamente en el reloj físico asignándole un ID. Al realizar su primera checada, el sistema lo registrará automáticamente como "Empleado #ID" en la sucursal y podrás completarle su nombre, área y turno desde Plantilla de Empleados si así lo deseas.'
      },
      {
        q: '¿Cómo funcionan los relojes contratados en mi suscripción?',
        a: 'Tu plan incluye un cupo específico de relojes checadores activos. Puedes consultar tus relojes usados y disponibles en la pestaña "Mi Cuenta y Suscripción". Si necesitas agregar más terminales, solicita al administrador ampliar tu capacidad.'
      },
      {
        q: '¿Dónde se almacenan las checadas y cómo se conectan las sucursales?',
        a: 'Toda la información de empresas, sucursales, empleados y checadas se almacena aislada en la nube bajo tu cuenta. Cada reloj físico envía sus registros mediante comunicación unidireccional segura (One-Way Push) sin abrir puertos en tu red local.'
      }
    ];

    onMounted(() => {
      loadSettings();
      loadEmailConfig();
    });

    return {
      activeTab,
      form,
      sub,
      clocksUsed,
      clocksMax,
      clocksPct,
      companiesUsed,
      companiesMax,
      smtpForm,
      isSavingSmtp,
      isTestingSmtp,
      smtpFeedback,
      isSmtpConfigured,
      isSaving,
      saveSettings,
      setDebouncePreset,
      saveSmtp,
      testSmtp,
      applySmtpPreset,
      openFaq,
      toggleFaq,
      faqs
    };
  },
  template: `
    <div class="w-full space-y-6 animate-in fade-in duration-150 pb-8">


      <!-- TABS NAVEGACIÓN -->
      <div class="flex items-center gap-2 border-b border-charcoal-200 pb-2 overflow-x-auto scrollbar-none">

        <button
          type="button"
          @click="activeTab = 'cuenta'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'cuenta' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-user-circle-gear text-base"></i>
          <span>Mi Cuenta y Suscripción</span>
        </button>

        <button
          type="button"
          @click="activeTab = 'asistencia'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'asistencia' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-shield-check text-base"></i>
          <span>Asistencia y Anti-Rebote</span>
        </button>

        <button
          type="button"
          @click="activeTab = 'correo'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'correo' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-envelope-simple text-base"></i>
          <span>Correo y Notificaciones (SMTP)</span>
        </button>

        <button
          type="button"
          @click="activeTab = 'ayuda'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'ayuda' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-question text-base"></i>
          <span>Ayuda y Guías</span>
        </button>

      </div>

      <!-- ================= TAB 1: MI CUENTA Y SUSCRIPCIÓN ================= -->
      <div v-if="activeTab === 'cuenta'" class="space-y-6">

        <!-- Tarjeta de Suscripción Activa y Cupo de Relojes -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <span class="text-[10px] mono-code font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-charcoal-900 text-white">
                  {{ sub.plan || 'MENSUAL' }}
                </span>
                <span
                  class="inline-flex items-center gap-1.5 text-[11px] font-semibold"
                  :class="sub.is_active ? 'text-charcoal-900' : 'text-rose-600'">
                  <span class="w-1.5 h-1.5 rounded-full" :class="sub.is_active ? 'bg-emerald-500' : 'bg-rose-500'"></span>
                  {{ sub.estado || 'ACTIVA' }}
                </span>
              </div>
              <h3 class="text-sm font-semibold text-charcoal-900 mt-2">Mi Suscripción Activa</h3>
              <p class="text-xs text-charcoal-500">Resumen de tu plan contratado, vigencia y capacidad de relojes checadores.</p>
            </div>

            <div class="text-left sm:text-right shrink-0">
              <span class="text-[11px] text-charcoal-400 block">Próximo corte / vencimiento</span>
              <span class="text-base font-black mono-code text-charcoal-900">{{ sub.fecha_vencimiento || '—' }}</span>
              <span class="text-[11px] font-semibold block" :class="sub.is_active ? 'text-charcoal-400' : 'text-rose-600'">
                {{ sub.is_active ? ((sub.dias_restantes ?? 0) + ' días restantes') : 'Requiere renovación' }}
              </span>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-2.5">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-charcoal-900 flex items-center gap-3">
                  <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-fingerprint text-lg text-charcoal-400"></i></span>
                  Relojes Checadores Contratados
                </span>
                <span class="mono-code text-xs font-black text-charcoal-900">{{ clocksUsed }} / {{ clocksMax }}</span>
              </div>
              <div class="w-full h-2 rounded-full bg-charcoal-200 overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-300"
                  :class="clocksUsed >= clocksMax ? 'bg-rose-500' : 'bg-charcoal-900'"
                  :style="{ width: clocksPct + '%' }">
                </div>
              </div>
              <p class="text-[11px]" :class="clocksUsed >= clocksMax ? 'text-charcoal-900 font-semibold' : 'text-charcoal-500'">
                {{ clocksUsed < clocksMax
                  ? ('Capacidad disponible: puedes registrar ' + (clocksMax - clocksUsed) + ' reloj(es) adicional(es).')
                  : 'Capacidad llena — contacta al administrador para contratar otro reloj.' }}
              </p>
            </div>

            <div class="p-4 rounded-2xl bg-offwhite border border-charcoal-200 space-y-2.5">
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-charcoal-800 flex items-center gap-1.5">
                  <i class="ph ph-buildings text-base text-charcoal-700"></i>
                  Empresas Vinculadas
                </span>
                <span class="mono-code text-xs font-black text-charcoal-900">{{ companiesUsed }} / {{ companiesMax }}</span>
              </div>
              <div class="w-full h-2 rounded-full bg-charcoal-200 overflow-hidden">
                <div
                  class="h-full rounded-full bg-[#18181B] transition-all duration-300"
                  :style="{ width: (companiesMax > 0 ? Math.min(100, Math.round((companiesUsed / companiesMax) * 100)) : 100) + '%' }">
                </div>
              </div>
              <p class="text-[11px] text-charcoal-500">
                Multiempresa y sucursales aisladas bajo tu cuenta de Recursos Humanos.
              </p>
            </div>
          </div>
        </div>

        <!-- Formulario Datos de Mi Cuenta -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="flex items-center gap-4">
            <div>
              <h3 class="text-base text-charcoal-700">Hola, <b class="font-bold text-charcoal-900">{{ form.operator_name || 'Mi Cuenta' }}</b></h3>
              <p class="text-xs text-charcoal-500">{{ form.operator_role || 'Recursos Humanos' }} • @{{ form.username }}</p>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Nombre Completo</label>
              <input v-model="form.operator_name" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Correo Electrónico (Login)</label>
              <input v-model="form.operator_email" type="email"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Nombre de Usuario (Username)</label>
              <input v-model="form.username" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Puesto / Cargo</label>
              <input v-model="form.operator_role" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Turno / Horario</label>
              <input v-model="form.operator_shift" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Nueva Contraseña (Opcional)</label>
              <input v-model="form.new_password" type="password" placeholder="Dejar vacío para mantener la actual"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <div class="pt-3 border-t border-charcoal-100 flex justify-end">
            <button
              type="button"
              :disabled="isSaving"
              @click="saveSettings(false)"
              class="px-6 py-2.5 rounded-2xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-floppy-disk text-base" :class="{ 'animate-spin': isSaving }"></i>
              <span>{{ isSaving ? 'Guardando...' : 'Guardar Cambios de Mi Cuenta' }}</span>
            </button>
          </div>
        </div>

      </div>

      <!-- ================= TAB 1: ASISTENCIA Y ANTI-REBOTE ================= -->
      <div v-if="activeTab === 'asistencia'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="flex items-center gap-2">
                <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-funnel text-lg text-charcoal-400"></i></span>
                <h3 class="text-sm font-semibold text-charcoal-900">Filtro Inteligente Anti-Rebote (Debounce)</h3>
              </div>
              <p class="text-xs text-charcoal-500 mt-1">
                Evita checadas duplicadas o accidentales cuando un colaborador pasa su huella/rostro varias veces en poco tiempo.
              </p>
            </div>
            
            <div class="text-right shrink-0">
              <span class="text-xs text-charcoal-400 block">Ventana actual:</span>
              <span class="text-xl font-bold mono-code text-charcoal-900">{{ form.debounce_seconds }} seg</span>
              <span class="text-[11px] text-charcoal-400 block">({{ Math.round(form.debounce_seconds / 60) }} minutos)</span>
            </div>
          </div>

          <!-- SELECTOR DE PRESETS RÁPIDOS -->
          <div class="space-y-2">
            <label class="block text-xs font-bold text-charcoal-700">Seleccionar ventana de protección recomendada:</label>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              
              <button
                type="button"
                @click="setDebouncePreset(60)"
                class="p-4 rounded-2xl border text-left transition-all cursor-pointer"
                :class="form.debounce_seconds === 60 ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-offwhite hover:bg-white text-charcoal-800'">
                <div class="text-xs font-bold">1 Minuto</div>
                <div class="text-[11px] mono-code" :class="form.debounce_seconds === 60 ? 'text-charcoal-300' : 'text-charcoal-500'">60 segundos</div>
                <span class="text-[10px] mt-2 block" :class="form.debounce_seconds === 60 ? 'text-charcoal-300' : 'text-charcoal-400'">Rápido / Flujo alto</span>
              </button>

              <button
                type="button"
                @click="setDebouncePreset(120)"
                class="p-4 rounded-2xl border text-left transition-all cursor-pointer"
                :class="form.debounce_seconds === 120 ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-offwhite hover:bg-white text-charcoal-800'">
                <div class="text-xs font-bold">2 Minutos</div>
                <div class="text-[11px] mono-code" :class="form.debounce_seconds === 120 ? 'text-charcoal-300' : 'text-charcoal-500'">120 segundos</div>
                <span class="text-[10px] mt-2 block" :class="form.debounce_seconds === 120 ? 'text-charcoal-300' : 'text-charcoal-400'">Moderado</span>
              </button>

              <button
                type="button"
                @click="setDebouncePreset(180)"
                class="p-4 rounded-2xl border text-left transition-all cursor-pointer relative overflow-hidden"
                :class="form.debounce_seconds === 180 ? 'border-[#18181B] bg-[#18181B] text-white' : 'border-charcoal-200 bg-white hover:bg-charcoal-50 text-charcoal-800'">
                <span class="absolute top-2 right-2 text-[9px] font-semibold uppercase tracking-wider text-charcoal-400">Recomendado</span>
                <div class="text-xs font-bold">3 Minutos</div>
                <div class="text-[11px] mono-code" :class="form.debounce_seconds === 180 ? 'text-charcoal-300' : 'text-charcoal-500'">180 segundos</div>
                <span class="text-[10px] mt-2 block" :class="form.debounce_seconds === 180 ? 'text-charcoal-300' : 'text-charcoal-500'">Estándar para nómina</span>
              </button>

              <button
                type="button"
                @click="setDebouncePreset(300)"
                class="p-4 rounded-2xl border text-left transition-all cursor-pointer"
                :class="form.debounce_seconds === 300 ? 'border-charcoal-900 bg-charcoal-900 text-white' : 'border-charcoal-200 bg-offwhite hover:bg-white text-charcoal-800'">
                <div class="text-xs font-bold">5 Minutos</div>
                <div class="text-[11px] mono-code" :class="form.debounce_seconds === 300 ? 'text-charcoal-300' : 'text-charcoal-500'">300 segundos</div>
                <span class="text-[10px] mt-2 block" :class="form.debounce_seconds === 300 ? 'text-charcoal-300' : 'text-charcoal-400'">Estricto / Turnos fijos</span>
              </button>

            </div>
          </div>

          <!-- INPUT PERSONALIZADO -->
          <div class="pt-2 flex items-center gap-3">
            <span class="text-xs text-charcoal-600 font-medium">O define un valor personalizado (en segundos):</span>
            <div class="flex items-center gap-2">
              <input
                v-model.number="form.debounce_seconds"
                type="number"
                min="10"
                max="3600"
                step="10"
                class="w-28 px-3 py-1.5 rounded-xl border border-charcoal-200 text-xs mono-code font-bold text-center focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              <span class="text-xs text-charcoal-400">segundos</span>
            </div>
          </div>

          <!-- DIAGRAMA VISUAL DIDÁCTICO -->
          <div class="p-4 rounded-2xl bg-charcoal-50 border border-charcoal-200/80 text-xs space-y-2">
            <div class="font-semibold text-charcoal-900 flex items-center gap-3">
              <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-info text-lg text-charcoal-400"></i></span>
              <span>¿Cómo se procesa en el sistema?</span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-charcoal-600">
              <div class="p-3 bg-white rounded-xl border border-charcoal-200 flex items-start gap-2">
                <span class="w-5 h-5 rounded-full bg-charcoal-100 text-charcoal-700 flex items-center justify-center font-bold text-xs shrink-0">1</span>
                <div>
                  <b class="text-charcoal-900">Primera Checada:</b> Se clasifica como <span class="mono-code font-bold text-charcoal-900">VÁLIDO</span> y se computa para la pre-nómina y cálculo de horas de la jornada.
                </div>
              </div>
              <div class="p-3 bg-white rounded-xl border border-charcoal-200 flex items-start gap-2">
                <span class="w-5 h-5 rounded-full bg-charcoal-100 text-charcoal-700 flex items-center justify-center font-bold text-xs shrink-0">2</span>
                <div>
                  <b class="text-charcoal-900">Checadas posteriores &lt;{{ form.debounce_seconds }}s:</b> Se clasifican como <span class="mono-code font-bold text-charcoal-500">REBOTE IGNORADO</span>. No alteran horas pero quedan en bitácora para auditoría.
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- TOLERANCIA Y PREFERENCIAS GENERALES -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-clock-countdown text-lg text-charcoal-400"></i></span><h3 class="text-sm font-semibold text-charcoal-900">Tolerancia de Asistencia y Notificaciones</h3></div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1.5">Tolerancia de Entrada General (Minutos)</label>
              <select v-model.number="form.tolerancia_minutos" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                <option :value="0">0 minutos (Sin tolerancia / Estricto)</option>
                <option :value="5">5 minutos de cortesía</option>
                <option :value="10">10 minutos (Recomendado estándar)</option>
                <option :value="15">15 minutos de tolerancia</option>
                <option :value="20">20 minutos (Flexible)</option>
              </select>
              <p class="text-[11px] text-charcoal-400 mt-1">Margen antes de marcar la checada con incidencia de retardo.</p>
            </div>

            <div class="space-y-3">
              <label class="block text-xs font-bold text-charcoal-800">Preferencias de Interfaz en Vivo</label>
              
              <label class="flex items-center gap-3 cursor-pointer">
                <input v-model="form.sound_alerts" type="checkbox" class="w-4 h-4 rounded text-charcoal-900 focus:ring-charcoal-900">
                <span class="text-xs text-charcoal-700">Avisos flotantes (Toast) al recibir nueva checada</span>
              </label>

              <label class="flex items-center gap-3 cursor-pointer">
                <input v-model="form.auto_scroll" type="checkbox" class="w-4 h-4 rounded text-charcoal-900 focus:ring-charcoal-900">
                <span class="text-xs text-charcoal-700">Destacar con animación verde cada checada entrante</span>
              </label>

              <label class="flex items-center gap-3 cursor-pointer">
                <input v-model="form.notify_unnamed_employees" type="checkbox" class="w-4 h-4 rounded text-charcoal-900 focus:ring-charcoal-900">
                <span class="text-xs text-charcoal-700">Recordatorio en Isla Dinámica cuando cheque un empleado sin nombre asignado (solo ID)</span>
              </label>
            </div>
          </div>

          <!-- BOTÓN GUARDAR -->
          <div class="pt-3 border-t border-charcoal-100 flex justify-end">
            <button
              type="button"
              :disabled="isSaving"
              @click="saveSettings(false)"
              class="px-6 py-2.5 rounded-2xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-floppy-disk text-base" :class="{ 'animate-spin': isSaving }"></i>
              <span>{{ isSaving ? 'Guardando...' : 'Guardar Parámetros de Asistencia' }}</span>
            </button>
          </div>
        </div>

      </div>

      <!-- ================= TAB 3: CORREO Y NOTIFICACIONES (SMTP) ================= -->
      <div v-if="activeTab === 'correo'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="flex items-center gap-2">
                <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-envelope-simple text-lg text-charcoal-400"></i></span>
                <h3 class="text-sm font-semibold text-charcoal-900">Servidor de Correo para Pre-Nómina y Reportes (SMTP)</h3>
              </div>
              <p class="text-xs text-charcoal-500 mt-1">
                Permite enviar la pre-nómina, bitácoras de incidencias y reportes a RH y gerencia directamente por correo.
              </p>
            </div>
            
            <span class="text-[11px] font-semibold flex items-center gap-1.5"
              :class="isSmtpConfigured ? 'text-charcoal-900' : 'text-charcoal-400'">
              <span class="w-1.5 h-1.5 rounded-full" :class="isSmtpConfigured ? 'bg-emerald-500' : 'bg-charcoal-300'"></span>
              {{ isSmtpConfigured ? 'SMTP Conectado' : 'Pendiente' }}
            </span>
          </div>

          <!-- PRESETS RÁPIDOS GMAIL Y OUTLOOK -->
          <div class="p-3.5 rounded-2xl bg-offwhite border border-charcoal-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <span class="text-charcoal-600 font-medium">Plantillas de configuración rápida:</span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                @click="applySmtpPreset('gmail')"
                class="px-3 py-1.5 rounded-xl bg-white border border-charcoal-200 hover:bg-charcoal-50 font-bold text-charcoal-800 transition-colors cursor-pointer flex items-center gap-1.5">
                <i class="ph ph-google-logo"></i>
                <span>Gmail (smtp.gmail.com)</span>
              </button>
              <button
                type="button"
                @click="applySmtpPreset('outlook')"
                class="px-3 py-1.5 rounded-xl bg-white border border-charcoal-200 hover:bg-charcoal-50 font-bold text-charcoal-800 transition-colors cursor-pointer flex items-center gap-1.5">
                <i class="ph ph-microsoft-outlook-logo"></i>
                <span>Outlook / Office 365</span>
              </button>
            </div>
          </div>

          <!-- FORMULARIO SMTP -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div class="sm:col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1">Servidor SMTP (Host)</label>
              <input v-model="smtpForm.smtp_host" type="text" placeholder="smtp.gmail.com"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Puerto</label>
              <input v-model.number="smtpForm.smtp_port" type="number" placeholder="587"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Seguridad</label>
              <select v-model="smtpForm.smtp_security" class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 bg-white focus:outline-none focus:ring-2 focus:ring-charcoal-900">
                <option value="STARTTLS">STARTTLS (Puerto 587 - Estándar)</option>
                <option value="SSL/TLS">SSL / TLS (Puerto 465)</option>
                <option value="NONE">Sin cifrado</option>
              </select>
            </div>

            <div class="sm:col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1">Usuario / Correo Remitente</label>
              <input v-model="smtpForm.smtp_user" type="email" placeholder="asistencia@empresa.com"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div class="sm:col-span-2">
              <label class="block font-bold text-charcoal-800 mb-1">Contraseña de Aplicación</label>
              <input v-model="smtpForm.smtp_password" type="password" placeholder="Clave de 16 caracteres de Google o contraseña SMTP"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 focus:outline-none focus:ring-2 focus:ring-charcoal-900">
              <p class="text-[10px] text-charcoal-400 mt-1">Para Gmail usa una 'Contraseña de Aplicación' generada en tu cuenta de Google.</p>
            </div>

            <div>
              <label class="block font-bold text-charcoal-800 mb-1">Destinatario por Defecto</label>
              <input v-model="smtpForm.destinatario_default" type="email" placeholder="rh@empresa.com"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <!-- MENSAJE DE FEEDBACK -->
          <div v-if="smtpFeedback.message" class="p-3 rounded-2xl text-xs font-medium flex items-center gap-2"
            :class="smtpFeedback.type === 'success' ? 'bg-charcoal-50 text-charcoal-800 border border-charcoal-200' : 'bg-rose-50 text-rose-800 border border-rose-200'">
            <i :class="['ph', smtpFeedback.type === 'success' ? 'ph-check-circle text-charcoal-400' : 'ph-x-circle text-rose-600', 'text-base']"></i>
            <span>{{ smtpFeedback.message }}</span>
          </div>

          <!-- BOTONERA ACCIÓN -->
          <div class="pt-4 border-t border-charcoal-100 flex items-center justify-between">
            <button
              type="button"
              :disabled="isTestingSmtp"
              @click="testSmtp"
              class="px-4 py-2.5 rounded-2xl bg-offwhite hover:bg-white border border-charcoal-200 text-charcoal-800 text-xs font-bold flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-paper-plane-tilt text-base" :class="{ 'animate-pulse': isTestingSmtp }"></i>
              <span>{{ isTestingSmtp ? 'Enviando prueba...' : 'Enviar Correo de Prueba' }}</span>
            </button>

            <button
              type="button"
              :disabled="isSavingSmtp"
              @click="saveSmtp"
              class="px-6 py-2.5 rounded-2xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-floppy-disk text-base" :class="{ 'animate-spin': isSavingSmtp }"></i>
              <span>{{ isSavingSmtp ? 'Guardando...' : 'Guardar Servidor SMTP' }}</span>
            </button>
          </div>

        </div>

      </div>

      <!-- ================= TAB 4: AYUDA Y PREGUNTAS FRECUENTES ================= -->
      <div v-if="activeTab === 'ayuda'" class="space-y-6">
        
        <!-- ACORDEÓN PREGUNTAS FRECUENTES -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-3">
          <h3 class="text-sm font-semibold text-charcoal-900 mb-2 flex items-center gap-3"><span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-question text-lg text-charcoal-400"></i></span><span>Preguntas Frecuentes y Buenas Prácticas</span></h3>

          <div
            v-for="(f, i) in faqs"
            :key="i"
            class="border border-charcoal-200 rounded-2xl overflow-hidden transition-colors">
            <button
              type="button"
              @click="toggleFaq(i)"
              class="w-full px-4 py-3.5 text-left text-xs font-bold text-charcoal-900 flex items-center justify-between gap-3 bg-offwhite hover:bg-charcoal-100/60 cursor-pointer transition-colors">
              <span>{{ f.q }}</span>
              <i :class="['ph text-sm text-charcoal-400 transition-transform duration-200', openFaq === i ? 'ph-caret-up rotate-180' : 'ph-caret-down']"></i>
            </button>
            <div v-show="openFaq === i" class="px-4 py-3 bg-white text-xs text-charcoal-600 leading-relaxed border-t border-charcoal-100 animate-in fade-in">
              {{ f.a }}
            </div>
          </div>

        </div>

      </div>

    </div>
  `
};
