// Component: ModalTutorial
// Minitutorial interactivo: Guía paso a paso sobre el funcionamiento completo de ACCESS

import { ref } from 'vue';

export default {
  name: 'ModalTutorial',
  props: {
    isOpen: { type: Boolean, default: false }
  },
  emits: ['close'],
  setup(props, { emit }) {
    const currentStep = ref(0);

    const steps = [
      {
        number: 1,
        title: 'Registro en Terminal Biométrica',
        subtitle: 'Captura física en hardware Hikvision MinMoe',
        icon: 'ph-fingerprint',
        iconColor: 'text-indigo-600 bg-indigo-50 border-indigo-200',
        badge: 'PASO 1: ENTRADA / SALIDA',
        summary: 'El colaborador se presenta ante la terminal física instalada en la sucursal.',
        details: [
          {
            title: 'Métodos soportados',
            desc: 'Reconocimiento facial en vivo (antispoofing), huella dactilar óptica o PIN numérico en pantalla.'
          },
          {
            title: 'Confirmación instantánea',
            desc: 'El checador emite un pitido audible y muestra el nombre en pantalla junto con la hora oficial del hardware.'
          },
          {
            title: 'Memoria autónoma',
            desc: 'La terminal almacena internamente hasta 100,000 eventos, por lo que nunca depende del internet para operar.'
          }
        ],
        tip: 'Tip: Si el empleado no tiene rostro o huella registrada, puede ingresar provisionalmente con su ID y PIN de 6 dígitos.'
      },
      {
        number: 2,
        title: 'Transmisión Híbrida en Tiempo Real',
        subtitle: 'Tecnología Dual: Webhook Push (<1s) + Respaldo Auto-Pull',
        icon: 'ph-broadcast',
        iconColor: 'text-sky-600 bg-sky-50 border-sky-200',
        badge: 'PASO 2: CONECTIVIDAD TOTAL',
        summary: 'La checada viaja instantáneamente a la computadora central mediante dos canales simultáneos:',
        details: [
          {
            title: '1. Webhook Push (< 1 segundo)',
            desc: 'La terminal envía un paquete HTTP directo al servidor local en cuanto detecta al empleado. Aparece al instante en pantalla.'
          },
          {
            title: '2. Auto-Pull de Respaldo (ISAPI)',
            desc: 'Cada 4 segundos, el servidor consulta la memoria interna del checador para asegurar que ni una sola checada se quede atrás.'
          },
          {
            title: 'Tolerancia a fallas de red',
            desc: 'Si la red Wi-Fi o local se desconecta temporalmente, al restablecerse el enlace todas las checadas acumuladas se descargan automáticamente.'
          }
        ],
        tip: 'Garantía: Cero pérdida de registros, incluso ante apagones o caídas temporales de la red de la empresa.'
      },
      {
        number: 3,
        title: 'Filtro Inteligente Anti-Rebote (Debounce)',
        subtitle: 'Protección automática para la pre-nómina',
        icon: 'ph-shield-check',
        iconColor: 'text-amber-600 bg-amber-50 border-amber-200',
        badge: 'PASO 3: DEPURACIÓN AUTOMÁTICA',
        summary: 'Evita errores cuando los empleados checan varias veces seguidas por distracción o duda.',
        details: [
          {
            title: 'Ventana de seguridad (180 segundos)',
            desc: 'Si un mismo empleado registra su pase 2 o más veces dentro de los 3 minutos (configurable), el sistema lo detecta de inmediato.'
          },
          {
            title: 'Clasificación automática',
            desc: 'El primer pase se guarda como VÁLIDO para nómina, y los pases repetidos se clasifican como REBOTE IGNORADO.'
          },
          {
            title: 'Auditoría transparente',
            desc: 'Los rebotes no se borran; quedan registrados en la bitácora para que el administrador pueda revisarlos en cualquier momento.'
          }
        ],
        tip: 'Personalización: Puedes ajustar el tiempo de anti-rebote (ej. 1, 3 o 5 min) desde el módulo de Configuración.'
      },
      {
        number: 4,
        title: 'Monitor en Vivo y Notificaciones',
        subtitle: 'Supervisión en tiempo real sin recargar pantalla',
        icon: 'ph-monitor',
        iconColor: 'text-emerald-600 bg-emerald-50 border-emerald-200',
        badge: 'PASO 4: VISUALIZACIÓN',
        summary: 'Supervisión centralizada de asistencias de todas las áreas y sucursales en vivo.',
        details: [
          {
            title: 'Actualización en pantalla sin F5',
            desc: 'No necesitas refrescar el navegador; cada nueva checada ingresa automáticamente a la tabla con animación verde.'
          },
          {
            title: 'Notificación Toast flotante',
            desc: 'Un aviso en la esquina inferior confirma el colaborador que checó, el método usado y si fue pase válido o rebote.'
          },
          {
            title: 'Filtros rápidos',
            desc: 'Puedes buscar por nombre, ID de colaborador, área asignada o método de autenticación (Rostro, Huella o PIN).'
          }
        ],
        tip: 'Dashboard ejecutivo: En el Inicio tienes métricas de presentes, total de checadas hoy y gráfico de 14 días.'
      },
      {
        number: 5,
        title: 'Conciliación, Pre-Nómina y Exportación',
        subtitle: 'Cálculo automatizado y descarga directa a Excel / CSV',
        icon: 'ph-file-csv',
        iconColor: 'text-purple-600 bg-purple-50 border-purple-200',
        badge: 'PASO 5: RESULTADO FINAL',
        summary: 'Los datos están listos para ser procesados por Recursos Humanos y Contabilidad.',
        details: [
          {
            title: 'Asignación por turnos y tolerancias',
            desc: 'Cada checada se contrasta contra el turno laboral del empleado (ej. Matutino 07:00 a 15:30) y la tolerancia de retardo (10 min).'
          },
          {
            title: 'Exportación a Excel / CSV con 1 Clic',
            desc: 'Descarga la bitácora completa o filtrada lista para importar en tu sistema contable, NOI, CONTPAQi o nómina.'
          },
          {
            title: 'Control por sucursales',
            desc: 'Soporte multireloj para sucursales como Cerro Gordo y accesos secundarios desde un solo panel unificado.'
          }
        ],
        tip: '¡Todo listo! Ya conoces el ciclo completo de ACCESS. Puedes acceder a Configuración para personalizar parámetros.'
      }
    ];

    function nextStep() {
      if (currentStep.value < steps.length - 1) {
        currentStep.value++;
      } else {
        closeTutorial();
      }
    }

    function prevStep() {
      if (currentStep.value > 0) {
        currentStep.value--;
      }
    }

    function goToStep(idx) {
      if (idx >= 0 && idx < steps.length) {
        currentStep.value = idx;
      }
    }

    function closeTutorial() {
      emit('close');
    }

    return {
      currentStep,
      steps,
      nextStep,
      prevStep,
      goToStep,
      closeTutorial
    };
  },
  template: `
    <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto modal-backdrop-anim bg-black/50 backdrop-blur-sm">
      
      <!-- CARD -->
      <div class="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl border border-charcoal-200 overflow-hidden flex flex-col modal-card-anim my-auto">
        
        <!-- HEADER -->
        <div class="px-6 pt-5 pb-4 border-b border-charcoal-100 flex items-center justify-between shrink-0 bg-offwhite">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-2xl bg-charcoal-900 text-white flex items-center justify-center text-xl shrink-0 shadow-xs">
              <i class="ph ph-lightbulb"></i>
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-base font-bold text-charcoal-900">¿Cómo Funciona ACCESS?</h3>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 mono-code">
                  Guía Visual
                </span>
              </div>
              <p class="text-xs text-charcoal-500">Minitutorial paso a paso del ciclo completo de asistencia</p>
            </div>
          </div>

          <button
            type="button"
            @click="closeTutorial"
            title="Cerrar (Esc)"
            class="w-8 h-8 rounded-full text-charcoal-400 hover:text-charcoal-900 hover:bg-charcoal-200 flex items-center justify-center transition-colors cursor-pointer">
            <i class="ph ph-x text-base"></i>
          </button>
        </div>

        <!-- STEP PILLS NAVIGATION -->
        <div class="px-6 py-2.5 bg-white border-b border-charcoal-100 flex items-center gap-1.5 overflow-x-auto shrink-0 scrollbar-none">
          <button
            v-for="(st, idx) in steps"
            :key="idx"
            type="button"
            @click="goToStep(idx)"
            class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 cursor-pointer"
            :class="currentStep === idx
              ? 'bg-[#18181B] text-white shadow-2xs'
              : 'text-charcoal-500 hover:bg-charcoal-100 hover:text-charcoal-800'">
            <span class="w-4 h-4 rounded-full text-[10px] flex items-center justify-center"
              :class="currentStep === idx ? 'bg-white/20 text-white' : 'bg-charcoal-200 text-charcoal-700'">
              {{ idx + 1 }}
            </span>
            <span class="hidden sm:inline">{{ st.title.split(' ')[0] }}</span>
          </button>
        </div>

        <!-- CONTENT BODY -->
        <div class="p-6 overflow-y-auto space-y-4 max-h-[60vh]">
          
          <!-- Step Top Badge & Title -->
          <div class="flex items-start gap-4">
            <div :class="['w-12 h-12 rounded-2xl border flex items-center justify-center text-2xl shrink-0', steps[currentStep].iconColor]">
              <i :class="['ph', steps[currentStep].icon]"></i>
            </div>
            <div class="flex-1 min-w-0">
              <span class="text-[10px] font-bold mono-code text-charcoal-400 uppercase tracking-wider block">
                {{ steps[currentStep].badge }} • Paso {{ currentStep + 1 }} de {{ steps.length }}
              </span>
              <h4 class="text-lg font-bold text-charcoal-900 mt-0.5">{{ steps[currentStep].title }}</h4>
              <p class="text-xs text-charcoal-500">{{ steps[currentStep].subtitle }}</p>
            </div>
          </div>

          <!-- Summary banner -->
          <div class="p-3.5 rounded-2xl bg-charcoal-50 border border-charcoal-200/80 text-xs text-charcoal-700 leading-relaxed font-medium">
            {{ steps[currentStep].summary }}
          </div>

          <!-- 3 Detail Points Grid -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div
              v-for="(d, i) in steps[currentStep].details"
              :key="i"
              class="p-3.5 rounded-2xl bg-white border border-charcoal-200/90 shadow-2xs flex flex-col justify-between">
              <div>
                <div class="flex items-center gap-1.5 text-xs font-bold text-charcoal-900 mb-1.5">
                  <i class="ph ph-check-circle text-emerald-600 text-sm shrink-0"></i>
                  <span>{{ d.title }}</span>
                </div>
                <p class="text-[11px] text-charcoal-500 leading-relaxed">{{ d.desc }}</p>
              </div>
            </div>
          </div>

          <!-- Highlight Tip Box -->
          <div class="p-3 rounded-2xl bg-sky-50 border border-sky-200 text-xs text-sky-900 flex items-start gap-2.5">
            <i class="ph ph-info text-sky-600 text-base shrink-0 mt-0.5"></i>
            <span class="leading-relaxed">{{ steps[currentStep].tip }}</span>
          </div>

        </div>

        <!-- FOOTER WITH CONTROLS -->
        <div class="px-6 py-4 border-t border-charcoal-100 bg-offwhite flex items-center justify-between shrink-0">
          
          <button
            type="button"
            :disabled="currentStep === 0"
            @click="prevStep"
            class="px-4 py-2 rounded-xl text-xs font-semibold text-charcoal-700 bg-white border border-charcoal-200 hover:bg-charcoal-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5 shadow-2xs">
            <i class="ph ph-caret-left"></i>
            <span>Anterior</span>
          </button>

          <!-- Step Dots -->
          <div class="flex items-center gap-1.5">
            <button
              v-for="(st, idx) in steps"
              :key="idx"
              type="button"
              @click="goToStep(idx)"
              class="w-2.5 h-2.5 rounded-full transition-all cursor-pointer"
              :class="currentStep === idx ? 'w-6 bg-[#18181B]' : 'bg-charcoal-300 hover:bg-charcoal-400'"
              :title="'Ir al paso ' + (idx + 1)">
            </button>
          </div>

          <button
            type="button"
            @click="nextStep"
            class="px-5 py-2 rounded-xl text-xs font-bold text-white bg-[#18181B] hover:bg-black transition-all cursor-pointer flex items-center gap-1.5 shadow-xs">
            <span>{{ currentStep === steps.length - 1 ? '¡Entendido, Comenzar!' : 'Siguiente' }}</span>
            <i :class="['ph', currentStep === steps.length - 1 ? 'ph-check' : 'ph-caret-right']"></i>
          </button>

        </div>

      </div>

    </div>
  `
};
