// Component: ModalConfig
// Configuración Rápida del Sistema, Debounce y Servidor de Correo SMTP

import { ref, watch, onMounted } from 'vue';
import ModalBase from './ModalBase.js';

export default {
  name: 'ModalConfig',
  components: { ModalBase },
  props: {
    isOpen: { type: Boolean, default: false },
    initialTab: { type: String, default: 'perfil' },
    user: {
      type: Object,
      default: () => ({
        name: 'Angel Flores',
        role: 'Ingeniero de Sistemas y Hardware',
        email: 'angel.flores@quodo.mx',
        shift: 'Mixto (08:00 - 17:30)',
        node: 'Cerro Gordo • Terminal #01'
      })
    }
  },
  emits: ['close', 'logout', 'navigate', 'update-user'],
  setup(props, { emit }) {
    const currentTab = ref('perfil');
    const debounceVal = ref(180);
    const isSaving = ref(false);

    // Email SMTP Form State
    const emailForm = ref({
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
      smtp_security: 'STARTTLS',
      smtp_user: '',
      smtp_password: '',
      remitente_nombre: 'ACCESS - Control Biométrico',
      remitente_email: '',
      destinatario_default: '',
      is_configured: false,
      has_password: false
    });
    const showPassword = ref(false);
    const isSavingEmail = ref(false);
    const isTestingEmail = ref(false);
    const testRecipient = ref('');
    const emailFeedback = ref({ type: '', message: '' });

    const tabs = [
      { id: 'perfil', label: 'Perfil', icon: 'ph-user' },
      { id: 'correo', label: 'Servidor SMTP / Correo', icon: 'ph-envelope-simple' },
      { id: 'terminal', label: 'Anti-Rebote', icon: 'ph-funnel' }
    ];

    watch(() => props.initialTab, (v) => { if (v) currentTab.value = v; }, { immediate: true });

    async function loadEmailConfig() {
      try {
        const res = await fetch('/api/email/config');
        if (!res.ok) return;
        const data = await res.json();
        if (data.config) {
          emailForm.value = {
            ...emailForm.value,
            ...data.config,
            smtp_password: data.config.has_password ? '••••••••' : ''
          };
          if (!testRecipient.value) {
            testRecipient.value = data.config.destinatario_default || data.config.smtp_user || '';
          }
        }
      } catch (e) {
        console.error('Error cargando configuración de correo:', e);
      }
    }

    async function saveEmailConfig() {
      isSavingEmail.value = true;
      emailFeedback.value = { type: '', message: '' };
      try {
        const res = await fetch('/api/email/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(emailForm.value)
        });
        const data = await res.json();
        if (res.ok) {
          emailFeedback.value = {
            type: 'success',
            message: 'Configuración SMTP guardada con éxito.'
          };
          await loadEmailConfig();
        } else {
          emailFeedback.value = {
            type: 'error',
            message: data.detail || 'Error al guardar la configuración.'
          };
        }
      } catch (e) {
        emailFeedback.value = {
          type: 'error',
          message: 'Error de conexión con el servidor.'
        };
      } finally {
        isSavingEmail.value = false;
      }
    }

    async function sendTestEmail() {
      isTestingEmail.value = true;
      emailFeedback.value = { type: '', message: '' };
      try {
        const payload = {
          ...emailForm.value,
          to_email: testRecipient.value || emailForm.value.destinatario_default || emailForm.value.smtp_user
        };
        const res = await fetch('/api/email/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          emailFeedback.value = {
            type: 'success',
            message: `¡Correo de prueba enviado con éxito a ${payload.to_email}!`
          };
        } else {
          emailFeedback.value = {
            type: 'error',
            message: data.detail || 'Fallo al enviar correo de prueba.'
          };
        }
      } catch (e) {
        emailFeedback.value = {
          type: 'error',
          message: 'Error al comunicarse con el servidor.'
        };
      } finally {
        isTestingEmail.value = false;
      }
    }

    async function loadQuickSettings() {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const data = await res.json();
        if (data.settings && data.settings.debounce_seconds) {
          debounceVal.value = parseInt(data.settings.debounce_seconds) || 180;
        }
      } catch (e) {
        // silent
      }
    }

    async function saveDebounce(sec) {
      debounceVal.value = sec;
      isSaving.value = true;
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ debounce_seconds: sec })
        });
      } catch (e) {
        // silent
      } finally {
        isSaving.value = false;
      }
    }

    watch(() => props.isOpen, (open) => {
      if (open) {
        loadQuickSettings();
        loadEmailConfig();
      }
    });

    onMounted(() => {
      loadQuickSettings();
      loadEmailConfig();
    });

    return {
      currentTab,
      tabs,
      debounceVal,
      isSaving,
      saveDebounce,
      emailForm,
      showPassword,
      isSavingEmail,
      isTestingEmail,
      testRecipient,
      emailFeedback,
      saveEmailConfig,
      sendTestEmail
    };
  },
  template: `
    <ModalBase
      v-if="isOpen"
      title="Ajustes y Configuración"
      size="lg"
      confirmLabel="Listo"
      @close="$emit('close')"
      @confirm="$emit('close')">

      <!-- Pestañas -->
      <div class="flex items-center justify-between pb-3 border-b border-charcoal-100">
        <div class="flex items-center gap-1.5 overflow-x-auto">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            @click="currentTab = t.id"
            class="px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer flex items-center gap-2 whitespace-nowrap"
            :class="currentTab === t.id ? 'bg-[#18181B] text-white' : 'text-charcoal-600 hover:bg-charcoal-100'">
            <span class="w-5 flex items-center justify-center shrink-0"><i :class="['ph text-base', t.icon, currentTab === t.id ? 'text-white' : 'text-charcoal-400']"></i></span>
            <span>{{ t.label }}</span>
          </button>
        </div>

      </div>

      <!-- Tab 1: Perfil -->
      <div v-if="currentTab === 'perfil'" class="space-y-4 pt-2">
        <div class="flex items-center gap-3.5">
          <div>
            <div class="text-base text-charcoal-700">Hola, <b class="font-bold text-charcoal-900">{{ user.name }}</b></div>
            <div class="text-xs text-charcoal-500">{{ user.role }} • {{ user.node || 'Cerro Gordo' }}</div>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl bg-charcoal-50 border border-charcoal-200 text-xs space-y-1.5">
          <div class="flex justify-between text-charcoal-600">
            <span>Turno Asignado:</span>
            <b class="text-charcoal-900">{{ user.shift || 'Mixto (08:00 - 17:30)' }}</b>
          </div>
          <div class="flex justify-between text-charcoal-600">
            <span>Correo Oficial:</span>
            <b class="text-charcoal-900 font-mono">{{ user.email || 'angel.flores@quodo.mx' }}</b>
          </div>
        </div>
      </div>

      <!-- Tab 2: Servidor SMTP / Correo -->
      <div v-else-if="currentTab === 'correo'" class="space-y-4 pt-2 text-xs">
        
        <!-- Estado de Configuración -->
        <div class="flex items-center justify-between p-3.5 rounded-2xl border border-charcoal-200 bg-offwhite text-charcoal-800">
          <div class="flex items-center gap-2">
            <span class="w-5 flex items-center justify-center shrink-0"><i :class="['ph text-lg', emailForm.is_configured ? 'ph-check-circle text-charcoal-400' : 'ph-warning-circle text-rose-600']"></i></span>
            <div>
              <span class="font-semibold text-charcoal-900">{{ emailForm.is_configured ? 'Servidor SMTP Listo' : 'Configuración Pendiente' }}</span>
              <p class="text-[11px] opacity-90">{{ emailForm.is_configured ? 'Los reportes de asistencia se enviarán mediante esta cuenta.' : 'Ingresa los datos de tu servidor SMTP y contraseña de aplicación.' }}</p>
            </div>
          </div>
          <span class="text-[10px] mono-code font-semibold uppercase tracking-wider" :class="emailForm.is_configured ? 'text-charcoal-400' : 'text-rose-600'">
            {{ emailForm.is_configured ? 'Activo' : 'Incompleto' }}
          </span>
        </div>

        <!-- Banner de Notificación / Errores -->
        <div v-if="emailFeedback.message" class="p-3 rounded-xl text-xs flex items-center justify-between" :class="emailFeedback.type === 'success' ? 'bg-charcoal-50 text-charcoal-800 border border-charcoal-200' : 'bg-rose-50 text-rose-800 border border-rose-200'">
          <div class="flex items-center gap-2">
            <i :class="['ph', emailFeedback.type === 'success' ? 'ph-check' : 'ph-x-circle', 'text-base shrink-0']"></i>
            <span>{{ emailFeedback.message }}</span>
          </div>
          <button type="button" @click="emailFeedback.message = ''" class="cursor-pointer text-charcoal-500 hover:text-black">
            <i class="ph ph-x"></i>
          </button>
        </div>

        <!-- Formulario SMTP -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          
          <div>
            <label class="block font-bold text-charcoal-700 mb-1">Servidor SMTP (Host)</label>
            <input
              type="text"
              v-model="emailForm.smtp_host"
              placeholder="smtp.gmail.com"
              class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block font-bold text-charcoal-700 mb-1">Puerto</label>
              <input
                type="number"
                v-model="emailForm.smtp_port"
                placeholder="587"
                class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
              />
            </div>
            <div>
              <label class="block font-bold text-charcoal-700 mb-1">Seguridad</label>
              <select
                v-model="emailForm.smtp_security"
                class="w-full h-9 px-2 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none font-medium">
                <option value="STARTTLS">STARTTLS</option>
                <option value="SSL/TLS">SSL/TLS</option>
                <option value="NONE">Ninguna</option>
              </select>
            </div>
          </div>

          <div>
            <label class="block font-bold text-charcoal-700 mb-1">Usuario SMTP / Correo Remitente</label>
            <input
              type="email"
              v-model="emailForm.smtp_user"
              placeholder="tu_correo@gmail.com"
              class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="block font-bold text-charcoal-700">Contraseña de Aplicación</label>
              <button
                type="button"
                @click="showPassword = !showPassword"
                class="text-[10px] text-charcoal-500 hover:text-charcoal-900 font-semibold cursor-pointer">
                {{ showPassword ? 'Ocultar' : 'Mostrar' }}
              </button>
            </div>
            <input
              :type="showPassword ? 'text' : 'password'"
              v-model="emailForm.smtp_password"
              placeholder="16 caracteres (App Password)"
              class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div>
            <label class="block font-bold text-charcoal-700 mb-1">Nombre para Mostrar</label>
            <input
              type="text"
              v-model="emailForm.remitente_nombre"
              placeholder="ACCESS - Control Biométrico"
              class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white text-xs focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

          <div>
            <label class="block font-bold text-charcoal-700 mb-1">Destinatario por Defecto para Reportes</label>
            <input
              type="email"
              v-model="emailForm.destinatario_default"
              placeholder="reportes@tuempresa.com"
              class="w-full h-9 px-3 rounded-xl border border-charcoal-200 bg-white font-mono text-xs focus:ring-2 focus:ring-black focus:outline-none"
            />
          </div>

        </div>

        <!-- Instrucción de ayuda rápida -->
        <div class="p-3 rounded-xl bg-charcoal-50 border border-charcoal-200 text-[11px] text-charcoal-600 flex items-start gap-2">
          <i class="ph ph-info text-charcoal-400 text-sm shrink-0 mt-0.5"></i>
          <div>
            <strong>Consejo para Gmail / Workspace:</strong> Activa la verificación en dos pasos en tu cuenta de Google y genera una 
            <span class="font-mono font-bold text-charcoal-900">Contraseña de Aplicación</span> de 16 caracteres desde 
            <span class="font-semibold text-charcoal-900">Seguridad &gt; Contraseñas de aplicaciones</span>.
          </div>
        </div>

        <!-- Botones de Acción -->
        <div class="pt-2 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-charcoal-100">
          
          <div class="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="email"
              v-model="testRecipient"
              placeholder="Destinatario de prueba..."
              class="h-9 px-3 rounded-xl border border-charcoal-200 bg-white text-xs font-mono w-full sm:w-48 focus:ring-2 focus:ring-black focus:outline-none"
            />
            <button
              type="button"
              @click="sendTestEmail"
              :disabled="isTestingEmail"
              class="h-9 px-3.5 rounded-xl bg-white hover:bg-charcoal-100 text-charcoal-800 border border-charcoal-300 font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 disabled:opacity-50">
              <i :class="['ph', isTestingEmail ? 'ph-spinner animate-spin' : 'ph-paper-plane-tilt']"></i>
              <span>{{ isTestingEmail ? 'Probando...' : 'Probar Envío' }}</span>
            </button>
          </div>

          <button
            type="button"
            @click="saveEmailConfig"
            :disabled="isSavingEmail"
            class="h-9 px-5 rounded-xl bg-[#18181B] hover:bg-black text-white font-bold flex items-center justify-center gap-2 transition-all cursor-pointer w-full sm:w-auto shrink-0 shadow-xs disabled:opacity-50">
            <i :class="['ph', isSavingEmail ? 'ph-spinner animate-spin' : 'ph-floppy-disk']"></i>
            <span>{{ isSavingEmail ? 'Guardando...' : 'Guardar Ajustes SMTP' }}</span>
          </button>

        </div>

      </div>

      <!-- Tab 3: Anti-Rebote -->
      <div v-else class="space-y-4 pt-2 text-xs">
        <div class="p-3.5 rounded-2xl border border-charcoal-200 space-y-2 bg-offwhite">
          <div class="flex items-center justify-between">
            <div class="font-semibold text-charcoal-900 flex items-center gap-3">
              <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-funnel text-lg text-charcoal-400"></i></span>
              <span>Filtro Anti-Rebote (Debounce)</span>
            </div>
            <span class="mono-code font-bold text-charcoal-900">
              {{ debounceVal }} seg
            </span>
          </div>
          <p class="text-charcoal-500 text-[11px] leading-relaxed">
            Ignora pases repetidos accidentales de un mismo colaborador para no duplicar horas en la nómina.
          </p>

          <div class="grid grid-cols-3 gap-2 pt-1">
            <button
              type="button"
              @click="saveDebounce(60)"
              class="py-1.5 px-2 rounded-lg border text-center transition-all cursor-pointer font-bold text-[11px]"
              :class="debounceVal === 60 ? 'bg-charcoal-900 text-white' : 'bg-white hover:bg-charcoal-50 text-charcoal-700'">
              1 min (60s)
            </button>
            <button
              type="button"
              @click="saveDebounce(180)"
              class="py-1.5 px-2 rounded-lg border text-center transition-all cursor-pointer font-bold text-[11px]"
              :class="debounceVal === 180 ? 'bg-charcoal-900 text-white' : 'bg-white hover:bg-charcoal-50 text-charcoal-700'">
              3 min (180s)
            </button>
            <button
              type="button"
              @click="saveDebounce(300)"
              class="py-1.5 px-2 rounded-lg border text-center transition-all cursor-pointer font-bold text-[11px]"
              :class="debounceVal === 300 ? 'bg-charcoal-900 text-white' : 'bg-white hover:bg-charcoal-50 text-charcoal-700'">
              5 min (300s)
            </button>
          </div>
        </div>

        <div class="p-3.5 rounded-2xl border border-charcoal-200 space-y-1">
          <div class="font-bold text-charcoal-900">Sincronización Dual Continua</div>
          <div class="text-charcoal-500 text-[11px]">
            Webhook Push en tiempo real + Auto-Pull de respaldo cada 4 segundos. Cero pérdida de registros ante caídas de red.
          </div>
        </div>
      </div>

    </ModalBase>
  `
};
