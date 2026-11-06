// Component: ViewConfiguracion
// Centro de Configuración Unificado e Intuitivo para Asistencia, Hardware ISAPI, Servidor, Correo y Operador

import { ref, computed, watch, onMounted } from 'vue';

export default {
  name: 'ViewConfiguracion',
  props: {
    devices: { type: Array, default: () => [] },
    user: { type: Object, default: () => ({ name: 'Angel Flores', role: 'Ingeniero de Sistemas y Hardware', email: 'angel.flores@quodo.mx' }) }
  },
  emits: ['toast', 'refresh', 'update-user'],
  setup(props, { emit }) {
    const activeTab = ref('asistencia');
    const isSaving = ref(false);
    const isTestingConn = ref(false);
    const connResult = ref(null);
    const isCalibratingTime = ref(false);
    const isSettingWebhook = ref(false);

    // Formulario de parámetros de sistema
    const form = ref({
      debounce_seconds: 180,
      tolerancia_minutos: 10,
      operator_name: props.user?.name || 'Angel Flores',
      operator_role: props.user?.role || 'Ingeniero de Sistemas y Hardware',
      operator_email: props.user?.email || 'angel.flores@quodo.mx',
      operator_shift: 'Mixto (08:00 - 17:30)',
      sound_alerts: true,
      auto_scroll: true,
      local_ip: '127.0.0.1',
      webhook_port: 8000,
      webhook_url: ''
    });

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

    const activeClock = computed(() => {
      return props.devices[0] || {
        id: 1,
        nombre: 'Cerro Gordo',
        ip: '192.168.11.71',
        puerto: 80,
        usuario: 'admin',
        modelo: 'DS-K1T320MFWX-B',
        firmware: 'V3.5.2',
        estado: 'ONLINE',
        red_tipo: 'Wi-Fi (TBS)'
      };
    });

    const clockEdit = ref({
      nombre: '',
      ip: '',
      puerto: 80,
      usuario: 'admin',
      password: ''
    });

    watch(activeClock, (clk) => {
      if (clk) {
        clockEdit.value = {
          nombre: clk.nombre || '',
          ip: clk.ip || '',
          puerto: clk.puerto || 80,
          usuario: clk.usuario || 'admin',
          password: ''
        };
      }
    }, { immediate: true });

    async function loadSettings() {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = await res.json();
        if (data.settings) {
          const s = data.settings;
          form.value.debounce_seconds = parseInt(s.debounce_seconds) || 180;
          form.value.tolerancia_minutos = parseInt(s.tolerancia_minutos) || 10;
          if (s.operator_name) form.value.operator_name = s.operator_name;
          if (s.operator_role) form.value.operator_role = s.operator_role;
          if (s.operator_email) form.value.operator_email = s.operator_email;
          if (s.operator_shift) form.value.operator_shift = s.operator_shift;
          form.value.sound_alerts = s.sound_alerts === '1' || s.sound_alerts === true;
          form.value.auto_scroll = s.auto_scroll === '1' || s.auto_scroll === true;
          if (s.local_ip) form.value.local_ip = s.local_ip;
          if (s.webhook_port) form.value.webhook_port = s.webhook_port;
          form.value.webhook_url = s.webhook_url || `http://${s.local_ip || '127.0.0.1'}:8000/api/v1/webhooks/hikvision`;
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
          operator_shift: form.value.operator_shift,
          sound_alerts: form.value.sound_alerts ? '1' : '0',
          auto_scroll: form.value.auto_scroll ? '1' : '0'
        };

        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          localStorage.setItem('quodo_access_user', form.value.operator_name);
          emit('update-user', {
            name: form.value.operator_name,
            role: form.value.operator_role,
            email: form.value.operator_email
          });
          if (!silent) emit('toast', 'Configuración guardada correctamente.');
        } else {
          if (!silent) emit('toast', 'Error guardando configuración', 'error');
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

    async function testClockConnection() {
      isTestingConn.value = true;
      connResult.value = null;
      try {
        const clkId = activeClock.value.id || 1;
        const res = await fetch(`/api/devices/${clkId}/test-connection`, { method: 'POST' });
        const data = await res.json();
        connResult.value = data;
        if (data.ok) {
          emit('toast', `¡Conexión exitosa! (${data.latency_ms} ms)`);
          emit('refresh');
        } else {
          emit('toast', data.error || 'No se pudo contactar al reloj', 'error');
        }
      } catch (e) {
        connResult.value = { ok: false, error: 'Error de red al intentar conectar' };
        emit('toast', 'Error al probar conexión con el reloj', 'error');
      } finally {
        isTestingConn.value = false;
      }
    }

    async function calibrateClockTime() {
      isCalibratingTime.value = true;
      try {
        const clkId = activeClock.value.id || 1;
        const res = await fetch(`/api/devices/${clkId}/sync-time`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Hora del reloj calibrada exitosamente.`);
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error calibrando hora', 'error');
        }
      } catch (e) {
        emit('toast', 'Error al calibrar hora del reloj', 'error');
      } finally {
        isCalibratingTime.value = false;
      }
    }

    async function setupWebhook() {
      isSettingWebhook.value = true;
      try {
        const clkId = activeClock.value.id || 1;
        const res = await fetch(`/api/devices/${clkId}/setup-webhook`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          emit('toast', `Webhook Push enlazado hacia ${data.webhook || form.value.webhook_url}`);
          emit('refresh');
        } else {
          emit('toast', data.detail || 'Error configurando webhook', 'error');
        }
      } catch (e) {
        emit('toast', 'Error al configurar webhook', 'error');
      } finally {
        isSettingWebhook.value = false;
      }
    }

    function copyWebhookUrl() {
      if (navigator.clipboard && form.value.webhook_url) {
        navigator.clipboard.writeText(form.value.webhook_url);
        emit('toast', 'URL del Webhook copiada al portapapeles');
      }
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
        a: 'Ve al módulo "Plantilla de Empleados" y haz clic en "Nuevo Empleado". Puedes registrar su nombre, área y asignar un PIN de teclado. Al guardar, el colaborador queda registrado tanto en el sistema como en la memoria del reloj de inmediato.'
      },
      {
        q: '¿Cómo calibro la hora oficial si el reloj checador tiene desfase?',
        a: 'Simplemente ingresa a la pestaña "Terminal Checador" en esta ventana y presiona el botón "Calibrar Hora Reloj". En un solo segundo, el sistema enviará la hora y fecha exacta de la computadora al hardware mediante el protocolo ISAPI.'
      },
      {
        q: '¿Dónde se guardan los datos y la base de datos?',
        a: 'Todos los registros, checadas y fotografías se almacenan localmente en SQLite (access.db) de alta velocidad dentro de las instalaciones de la empresa. No depende de servidores en la nube de terceros y los datos están completamente protegidos bajo tu control.'
      }
    ];

    onMounted(() => {
      loadSettings();
      loadEmailConfig();
    });

    return {
      activeTab,
      form,
      smtpForm,
      isSavingSmtp,
      isTestingSmtp,
      smtpFeedback,
      isSmtpConfigured,
      activeClock,
      clockEdit,
      isSaving,
      isTestingConn,
      connResult,
      isCalibratingTime,
      isSettingWebhook,
      saveSettings,
      setDebouncePreset,
      testClockConnection,
      calibrateClockTime,
      setupWebhook,
      copyWebhookUrl,
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
          @click="activeTab = 'asistencia'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'asistencia' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-shield-check text-base"></i>
          <span>Asistencia y Anti-Rebote</span>
        </button>

        <button
          type="button"
          @click="activeTab = 'reloj'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'reloj' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-fingerprint text-base"></i>
          <span>Terminal Checador (ISAPI)</span>
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
          @click="activeTab = 'red'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'red' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-hard-drives text-base"></i>
          <span>Servidor Local y Red</span>
        </button>

        <button
          type="button"
          @click="activeTab = 'perfil'"
          class="px-4 py-2 rounded-2xl text-xs font-bold transition-all cursor-pointer flex items-center gap-2 shrink-0"
          :class="activeTab === 'perfil' ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100 hover:text-charcoal-900'">
          <i class="ph ph-user-gear text-base"></i>
          <span>Perfil del Operador</span>
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

      <!-- ================= TAB 1: ASISTENCIA Y ANTI-REBOTE ================= -->
      <div v-if="activeTab === 'asistencia'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center text-lg">
                  <i class="ph ph-funnel"></i>
                </div>
                <h3 class="text-base font-bold text-charcoal-900">Filtro Inteligente Anti-Rebote (Debounce)</h3>
              </div>
              <p class="text-xs text-charcoal-500 mt-1">
                Evita checadas duplicadas o accidentales cuando un colaborador pasa su huella/rostro varias veces en poco tiempo.
              </p>
            </div>
            
            <div class="text-right shrink-0">
              <span class="text-xs text-charcoal-400 block">Ventana actual:</span>
              <span class="text-xl font-bold mono-code text-charcoal-900">{{ form.debounce_seconds }} seg</span>
              <span class="text-[11px] text-emerald-600 block">({{ Math.round(form.debounce_seconds / 60) }} minutos)</span>
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
                :class="form.debounce_seconds === 180 ? 'border-emerald-600 bg-[#18181B] text-white' : 'border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50 text-charcoal-800'">
                <span class="absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500 text-white">RECOMENDADO</span>
                <div class="text-xs font-bold">3 Minutos</div>
                <div class="text-[11px] mono-code" :class="form.debounce_seconds === 180 ? 'text-emerald-400' : 'text-emerald-700'">180 segundos</div>
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
            <div class="font-bold text-charcoal-900 flex items-center gap-1.5">
              <i class="ph ph-info text-sky-600"></i>
              <span>¿Cómo se procesa en el sistema?</span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-charcoal-600">
              <div class="p-3 bg-white rounded-xl border border-emerald-100 flex items-start gap-2">
                <span class="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs shrink-0">1</span>
                <div>
                  <b class="text-emerald-800">Primera Checada:</b> Se clasifica como <span class="mono-code font-bold text-emerald-700">VÁLIDO</span> y se computa para la pre-nómina y cálculo de horas de la jornada.
                </div>
              </div>
              <div class="p-3 bg-white rounded-xl border border-amber-100 flex items-start gap-2">
                <span class="w-5 h-5 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-xs shrink-0">2</span>
                <div>
                  <b class="text-amber-800">Checadas posteriores &lt;{{ form.debounce_seconds }}s:</b> Se clasifican como <span class="mono-code font-bold text-amber-700">REBOTE IGNORADO</span>. No alteran horas pero quedan en bitácora para auditoría.
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- TOLERANCIA Y PREFERENCIAS GENERALES -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <h3 class="text-base font-bold text-charcoal-900">Tolerancia de Asistencia y Notificaciones</h3>

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

      <!-- ================= TAB 2: TERMINAL CHECADOR (ISAPI) ================= -->
      <div v-if="activeTab === 'reloj'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-6">
          <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div class="flex items-center gap-3.5">
              <div class="w-12 h-12 rounded-2xl bg-[#18181B] text-white flex items-center justify-center text-2xl shrink-0">
                <i class="ph ph-fingerprint"></i>
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <h3 class="text-lg font-bold text-charcoal-900">{{ activeClock.nombre }}</h3>
                  <span class="text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full border flex items-center gap-1"
                    :class="activeClock.estado === 'ONLINE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'">
                    <span class="w-1.5 h-1.5 rounded-full" :class="activeClock.estado === 'ONLINE' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'"></span>
                    {{ activeClock.estado }}
                  </span>
                </div>
                <p class="text-xs text-charcoal-500">{{ activeClock.ip }}:{{ activeClock.puerto }} • {{ activeClock.red_tipo }} • {{ activeClock.ubicacion }}</p>
              </div>
            </div>

            <!-- RESULTADO DE CONEXIÓN EN VIVO -->
            <div v-if="connResult" class="px-3.5 py-1.5 rounded-2xl border text-xs font-medium flex items-center gap-2 animate-in fade-in"
              :class="connResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'">
              <i :class="['ph text-base', connResult.ok ? 'ph-check-circle text-emerald-600' : 'ph-x-circle text-red-600']"></i>
              <span>{{ connResult.message || connResult.error }}</span>
            </div>
          </div>

          <!-- BOTONERA DE ACCIONES RÁPIDAS EN 1 CLIC -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            
            <button
              type="button"
              :disabled="isTestingConn"
              @click="testClockConnection"
              class="p-4 rounded-2xl bg-offwhite hover:bg-white border border-charcoal-200 text-left transition-all cursor-pointer group disabled:opacity-50">
              <div class="flex items-center justify-between mb-2">
                <span class="w-8 h-8 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center text-lg">
                  <i class="ph ph-plugs-connected" :class="{ 'animate-pulse': isTestingConn }"></i>
                </span>
                <span class="text-[10px] font-bold text-sky-700 group-hover:underline">1 Clic</span>
              </div>
              <h4 class="text-xs font-bold text-charcoal-900">Probar Comunicación</h4>
              <p class="text-[11px] text-charcoal-500 mt-0.5">Diagnostica ping HTTP y latencia con el checador.</p>
            </button>

            <button
              type="button"
              :disabled="isCalibratingTime"
              @click="calibrateClockTime"
              class="p-4 rounded-2xl bg-offwhite hover:bg-white border border-charcoal-200 text-left transition-all cursor-pointer group disabled:opacity-50">
              <div class="flex items-center justify-between mb-2">
                <span class="w-8 h-8 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center text-lg">
                  <i class="ph ph-clock-clockwise" :class="{ 'animate-spin': isCalibratingTime }"></i>
                </span>
                <span class="text-[10px] font-bold text-amber-700 group-hover:underline">1 Clic</span>
              </div>
              <h4 class="text-xs font-bold text-charcoal-900">Calibrar Hora Reloj</h4>
              <p class="text-[11px] text-charcoal-500 mt-0.5">Sincroniza la hora exacta oficial de la PC al hardware.</p>
            </button>

            <button
              type="button"
              :disabled="isSettingWebhook"
              @click="setupWebhook"
              class="p-4 rounded-2xl bg-offwhite hover:bg-white border border-charcoal-200 text-left transition-all cursor-pointer group disabled:opacity-50">
              <div class="flex items-center justify-between mb-2">
                <span class="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center text-lg">
                  <i class="ph ph-broadcast" :class="{ 'animate-spin': isSettingWebhook }"></i>
                </span>
                <span class="text-[10px] font-bold text-emerald-700 group-hover:underline">1 Clic</span>
              </div>
              <h4 class="text-xs font-bold text-charcoal-900">Vincular Webhook Push</h4>
              <p class="text-[11px] text-charcoal-500 mt-0.5">Configura el reloj para que mande checadas a esta PC.</p>
            </button>

          </div>

          <!-- DETALLES TÉCNICOS RESUMIDOS -->
          <div class="p-4 rounded-2xl bg-charcoal-50 border border-charcoal-200/80 text-xs">
            <h4 class="font-bold text-charcoal-900 mb-2">Especificaciones de la Terminal Biométrica</h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-charcoal-600">
              <div>
                <span class="text-[10px] uppercase text-charcoal-400 block font-bold">Modelo</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ activeClock.modelo }}</span>
              </div>
              <div>
                <span class="text-[10px] uppercase text-charcoal-400 block font-bold">Firmware</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ activeClock.firmware }}</span>
              </div>
              <div>
                <span class="text-[10px] uppercase text-charcoal-400 block font-bold">Dirección MAC</span>
                <span class="font-medium text-charcoal-700 mono-code">{{ activeClock.mac || '60:56:ee:ec:a6:5c' }}</span>
              </div>
              <div>
                <span class="text-[10px] uppercase text-charcoal-400 block font-bold">Eventos Almacenados</span>
                <span class="font-bold text-charcoal-900 mono-code">{{ activeClock.total_eventos }} registros</span>
              </div>
            </div>
          </div>

        </div>

      </div>

      <!-- ================= TAB 3: CORREO Y NOTIFICACIONES (SMTP) ================= -->
      <div v-if="activeTab === 'correo'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-xl bg-purple-500/10 text-purple-600 flex items-center justify-center text-lg">
                  <i class="ph ph-envelope-simple"></i>
                </div>
                <h3 class="text-base font-bold text-charcoal-900">Servidor de Correo para Pre-Nómina y Reportes (SMTP)</h3>
              </div>
              <p class="text-xs text-charcoal-500 mt-1">
                Permite enviar la pre-nómina, bitácoras de incidencias y reportes a RH y gerencia directamente por correo.
              </p>
            </div>
            
            <span class="px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5"
              :class="isSmtpConfigured ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'">
              <span class="w-2 h-2 rounded-full" :class="isSmtpConfigured ? 'bg-emerald-500' : 'bg-amber-500'"></span>
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
            :class="smtpFeedback.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-800 border border-red-200'">
            <i :class="['ph', smtpFeedback.type === 'success' ? 'ph-check-circle text-emerald-600' : 'ph-x-circle text-red-600', 'text-base']"></i>
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

      <!-- ================= TAB 4: SERVIDOR LOCAL Y RED ================= -->
      <div v-if="activeTab === 'red'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <h3 class="text-base font-bold text-charcoal-900">Servidor Local y Receptor de Webhooks</h3>
              <p class="text-xs text-charcoal-500 mt-0.5">Parámetros de red de la computadora anfitriona donde corre ACCESS</p>
            </div>
            <span class="px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
              FastAPI 2.0 Activo
            </span>
          </div>

          <!-- TARJETA URL DEL WEBHOOK -->
          <div class="p-4 rounded-2xl bg-charcoal-900 text-white space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">URL del Receptor de Checadas en Vivo (ISAPI Push)</span>
              <button
                type="button"
                @click="copyWebhookUrl"
                class="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-white transition-colors cursor-pointer flex items-center gap-1.5">
                <i class="ph ph-copy"></i>
                <span>Copiar URL</span>
              </button>
            </div>
            <div class="text-sm font-mono text-emerald-400 font-bold truncate">
              {{ form.webhook_url }}
            </div>
            <p class="text-[11px] text-charcoal-400">
              Esta es la dirección a la que el reloj Hikvision envía cada checada en menos de 1 segundo.
            </p>
          </div>

          <!-- CHECKLIST DE SALUD DEL SISTEMA -->
          <div class="space-y-2.5">
            <h4 class="text-xs font-bold text-charcoal-900">Diagnóstico de Salud y Arquitectura</h4>
            
            <div class="p-3 rounded-2xl bg-offwhite border border-charcoal-200 flex items-center justify-between text-xs">
              <div class="flex items-center gap-2.5">
                <i class="ph ph-check-circle text-emerald-600 text-lg"></i>
                <span class="font-bold text-charcoal-900">Base de Datos de Producción SQLite</span>
              </div>
              <span class="mono-code text-charcoal-500 font-medium">access.db (Local & Segura)</span>
            </div>

            <div class="p-3 rounded-2xl bg-offwhite border border-charcoal-200 flex items-center justify-between text-xs">
              <div class="flex items-center gap-2.5">
                <i class="ph ph-check-circle text-emerald-600 text-lg"></i>
                <span class="font-bold text-charcoal-900">Receptor Webhook HTTP</span>
              </div>
              <span class="mono-code text-charcoal-500 font-medium">Puerto 8000 • Protocolo ISAPI 2.0</span>
            </div>

            <div class="p-3 rounded-2xl bg-offwhite border border-charcoal-200 flex items-center justify-between text-xs">
              <div class="flex items-center gap-2.5">
                <i class="ph ph-check-circle text-emerald-600 text-lg"></i>
                <span class="font-bold text-charcoal-900">Sincronizador en Segundo Plano (Auto-Pull)</span>
              </div>
              <span class="mono-code text-charcoal-500 font-medium">Activo cada 4.0s (Tolerancia a fallas)</span>
            </div>

            <div class="p-3 rounded-2xl bg-offwhite border border-charcoal-200 flex items-center justify-between text-xs">
              <div class="flex items-center gap-2.5">
                <i class="ph ph-check-circle text-emerald-600 text-lg"></i>
                <span class="font-bold text-charcoal-900">Filtro Anti-Rebote Activo</span>
              </div>
              <span class="mono-code text-emerald-700 font-bold">{{ form.debounce_seconds }} segundos</span>
            </div>
          </div>

        </div>

      </div>

      <!-- ================= TAB 5: PERFIL DEL OPERADOR ================= -->
      <div v-if="activeTab === 'perfil'" class="space-y-6">
        
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-5">
          <div class="flex items-center gap-4">
            <div class="w-16 h-16 rounded-3xl bg-[#18181B] text-white flex items-center justify-center text-xl font-bold shrink-0">
              {{ (form.operator_name || 'AF').slice(0, 2).toUpperCase() }}
            </div>
            <div>
              <h3 class="text-base font-bold text-charcoal-900">{{ form.operator_name }}</h3>
              <p class="text-xs text-charcoal-500">{{ form.operator_role }}</p>
              <span class="text-[11px] mono-code text-emerald-600 font-medium">Administrador de Terminales e ISAPI</span>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Nombre Completo del Operador</label>
              <input v-model="form.operator_name" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Puesto / Cargo</label>
              <input v-model="form.operator_role" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Correo Electrónico de Contacto</label>
              <input v-model="form.operator_email" type="email"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs mono-code focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>

            <div>
              <label class="block text-xs font-bold text-charcoal-800 mb-1">Turno Asignado</label>
              <input v-model="form.operator_shift" type="text"
                class="w-full px-3.5 py-2.5 rounded-xl border border-charcoal-200 text-xs focus:outline-none focus:ring-2 focus:ring-charcoal-900">
            </div>
          </div>

          <div class="pt-3 border-t border-charcoal-100 flex justify-end">
            <button
              type="button"
              :disabled="isSaving"
              @click="saveSettings(false)"
              class="px-6 py-2.5 rounded-2xl bg-[#18181B] hover:bg-black text-white text-xs font-bold flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50">
              <i class="ph ph-floppy-disk text-base"></i>
              <span>Guardar Perfil de Administrador</span>
            </button>
          </div>
        </div>

      </div>

      <!-- ================= TAB 6: AYUDA Y PREGUNTAS FRECUENTES ================= -->
      <div v-if="activeTab === 'ayuda'" class="space-y-6">
        
        <!-- ACORDEÓN PREGUNTAS FRECUENTES -->
        <div class="bg-white rounded-3xl p-6 border border-charcoal-200 shadow-sm space-y-3">
          <h3 class="text-base font-bold text-charcoal-900 mb-2">Preguntas Frecuentes y Buenas Prácticas</h3>

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
