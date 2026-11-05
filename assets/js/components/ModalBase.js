// Component: ModalBase
// Shared modal shell: backdrop, header, content area, footer button tray

export default {
  name: 'ModalBase',
  props: {
    title: { type: String, required: true },
    confirmLabel: { type: String, default: 'Guardar' },
    cancelLabel: { type: String, default: 'Cancelar' },
    confirmDisabled: { type: Boolean, default: false },
    hideConfirm: { type: Boolean, default: false },
    size: { type: String, default: 'md' }
  },
  emits: ['close', 'confirm'],
  setup() {
    const sizeMap = {
      sm: 'max-w-sm',
      md: 'max-w-md',
      lg: 'max-w-xl',
      xl: 'max-w-2xl'
    };
    return { sizeMap };
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-charcoal-950/40 backdrop-blur-sm modal-backdrop-anim"
      @click.self="$emit('close')">

      <div
        class="bg-white rounded-3xl shadow-2xl border border-charcoal-200/90 w-full overflow-hidden flex flex-col modal-card-anim"
        :class="sizeMap[size] || 'max-w-xl'">

        <div class="px-8 py-6 border-b border-charcoal-100 flex items-center justify-between">
          <h3 class="text-xl font-bold text-charcoal-900 tracking-tight">{{ title }}</h3>
          <button
            type="button"
            @click="$emit('close')"
            class="w-9 h-9 rounded-full flex items-center justify-center text-charcoal-400 hover:text-charcoal-700 hover:bg-charcoal-100 transition-colors cursor-pointer text-xl">
            <i class="ph ph-x"></i>
          </button>
        </div>

        <div class="px-8 py-6 space-y-5 overflow-y-auto max-h-[68vh]">
          <slot></slot>
        </div>

        <div class="px-8 py-5 border-t border-charcoal-100 flex items-center justify-between gap-3 bg-white rounded-b-3xl">
          <div>
            <slot name="footer-left"></slot>
          </div>
          <div class="flex items-center gap-3">
            <button
              type="button"
              @click="$emit('close')"
              class="px-6 py-2.5 rounded-full border border-charcoal-300 text-charcoal-700 hover:bg-charcoal-50 text-sm font-semibold transition-all cursor-pointer">
              {{ cancelLabel }}
            </button>
            <button
              v-if="!hideConfirm"
              type="button"
              :disabled="confirmDisabled"
              @click="$emit('confirm')"
              class="px-7 py-2.5 rounded-full bg-[#18181B] hover:bg-black text-white text-sm font-bold transition-all shadow-sm cursor-pointer disabled:opacity-50">
              {{ confirmLabel }}
            </button>
          </div>
        </div>

      </div>
    </div>
  `
};
