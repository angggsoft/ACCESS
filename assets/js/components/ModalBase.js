// Component: ModalBase
// Shared modal shell: backdrop, header, content area, footer button tray

export default {
  name: 'ModalBase',
  props: {
    title: { type: String, required: true },
    subtitle: { type: String, default: '' },
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
      md: 'max-w-lg',
      lg: 'max-w-2xl',
      xl: 'max-w-3xl'
    };
    return { sizeMap };
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center p-8 md:p-12 modal-backdrop-anim"
      @click.self="$emit('close')">

      <div
        class="bg-white rounded-3xl shadow-2xl border border-charcoal-200/90 w-full overflow-hidden flex flex-col modal-card-anim max-h-[calc(100vh-6rem)]"
        :class="sizeMap[size] || 'max-w-2xl'">

        <div class="px-10 py-7 border-b border-charcoal-100 flex items-start justify-between gap-6 shrink-0">
          <div class="min-w-0">
            <h3 class="text-xl font-bold text-charcoal-900 tracking-tight">{{ title }}</h3>
            <p v-if="subtitle" class="text-xs text-charcoal-500 mt-1.5 leading-relaxed">{{ subtitle }}</p>
          </div>
          <button
            type="button"
            @click="$emit('close')"
            class="w-9 h-9 rounded-full flex items-center justify-center text-charcoal-400 hover:text-charcoal-700 hover:bg-charcoal-100 transition-colors cursor-pointer text-xl shrink-0">
            <i class="ph ph-x"></i>
          </button>
        </div>

        <div class="px-10 py-8 space-y-6 overflow-y-auto flex-1 min-h-0">
          <slot></slot>
        </div>

        <div class="px-10 py-6 border-t border-charcoal-100 flex items-center justify-between gap-4 bg-white rounded-b-3xl shrink-0">
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
