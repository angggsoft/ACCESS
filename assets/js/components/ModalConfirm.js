// Component: ModalConfirm
// Sistema propio de diálogos (reemplaza confirm() / alert() nativos del navegador).
// Uso desde cualquier componente:
//   import { confirmDialog, alertDialog } from './ModalConfirm.js';
//   if (!(await confirmDialog({ title: '¿Eliminar?', message: '...', variant: 'danger', confirmLabel: 'Eliminar' }))) return;
//   await alertDialog({ title: 'Listo', message: '...', variant: 'success' });
// El host <ModalConfirmHost /> debe montarse una sola vez en app.js.

import { reactive, watch, onMounted, onUnmounted } from 'vue';

const dialogState = reactive({
  isOpen: false,
  mode: 'confirm', // 'confirm' | 'alert'
  title: '',
  message: '',
  detail: '',
  variant: 'info', // 'info' | 'danger' | 'warning' | 'success'
  confirmLabel: 'Aceptar',
  cancelLabel: 'Cancelar'
});

let pendingResolve = null;

function openDialog(mode, options = {}) {
  // Si había un diálogo abierto, se resuelve como cancelado
  if (pendingResolve) pendingResolve(false);

  dialogState.mode = mode;
  dialogState.title = options.title || (mode === 'confirm' ? '¿Confirmar acción?' : 'Aviso');
  dialogState.message = options.message || '';
  dialogState.detail = options.detail || '';
  dialogState.variant = options.variant || (mode === 'confirm' ? 'info' : 'info');
  dialogState.confirmLabel = options.confirmLabel || (mode === 'confirm' ? 'Confirmar' : 'Entendido');
  dialogState.cancelLabel = options.cancelLabel || 'Cancelar';
  dialogState.isOpen = true;

  return new Promise((resolve) => {
    pendingResolve = resolve;
  });
}

function closeDialog(result) {
  dialogState.isOpen = false;
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(result);
  }
}

export function confirmDialog(options) {
  return openDialog('confirm', options);
}

export function alertDialog(options) {
  return openDialog('alert', options).then(() => true);
}

const VARIANTS = {
  info: { icon: 'ph-info', iconColor: 'text-sky-500', btn: 'bg-[#18181B] hover:bg-black text-white' },
  success: { icon: 'ph-check-circle', iconColor: 'text-emerald-500', btn: 'bg-[#18181B] hover:bg-black text-white' },
  warning: { icon: 'ph-warning', iconColor: 'text-amber-500', btn: 'bg-[#18181B] hover:bg-black text-white' },
  danger: { icon: 'ph-warning-circle', iconColor: 'text-rose-500', btn: 'bg-rose-600 hover:bg-rose-700 text-white' }
};

export default {
  name: 'ModalConfirmHost',
  setup() {
    function onKeydown(e) {
      if (!dialogState.isOpen) return;
      if (e.key === 'Escape') {
        closeDialog(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        closeDialog(true);
      }
    }

    onMounted(() => window.addEventListener('keydown', onKeydown));
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    // Evita scroll del fondo mientras el diálogo está abierto
    watch(() => dialogState.isOpen, (open) => {
      document.body.style.overflow = open ? 'hidden' : '';
    });

    return { state: dialogState, VARIANTS, closeDialog };
  },
  template: `
    <div
      v-if="state.isOpen"
      class="fixed inset-0 z-[70] flex items-center justify-center p-8 modal-backdrop-anim"
      @click.self="closeDialog(false)">

      <div
        role="alertdialog"
        aria-modal="true"
        class="bg-white rounded-3xl shadow-2xl border border-charcoal-200/90 w-full max-w-md overflow-hidden flex flex-col modal-card-anim">

        <div class="px-10 pt-10 pb-8 flex flex-col items-center text-center">
          <i
            class="ph-fill text-5xl mb-5"
            :class="[VARIANTS[state.variant].icon, VARIANTS[state.variant].iconColor]"></i>
          <h3 class="text-lg font-bold text-charcoal-900 tracking-tight">{{ state.title }}</h3>
          <p v-if="state.message" class="text-sm text-charcoal-600 mt-2.5 leading-relaxed">{{ state.message }}</p>
          <p v-if="state.detail" class="text-xs text-charcoal-400 mt-3 leading-relaxed mono-code">{{ state.detail }}</p>
        </div>

        <div class="px-10 pb-8 flex items-center justify-center gap-3">
          <button
            v-if="state.mode === 'confirm'"
            type="button"
            @click="closeDialog(false)"
            class="px-6 py-2.5 rounded-full border border-charcoal-300 text-charcoal-700 hover:bg-charcoal-50 text-sm font-semibold transition-all cursor-pointer">
            {{ state.cancelLabel }}
          </button>
          <button
            type="button"
            @click="closeDialog(true)"
            class="px-7 py-2.5 rounded-full text-sm font-bold transition-all shadow-sm cursor-pointer"
            :class="VARIANTS[state.variant].btn">
            {{ state.confirmLabel }}
          </button>
        </div>

      </div>
    </div>
  `
};
