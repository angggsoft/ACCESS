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
    size: { type: String, default: 'md' },
    noScroll: { type: Boolean, default: false }
  },
  emits: ['close', 'confirm'],
  setup() {
    const sizeMap = {
      sm: 'max-w-md',
      md: 'max-w-2xl',
      lg: 'max-w-3xl',
      xl: 'max-w-4xl',
      wide: 'max-w-7xl'
    };
    return { sizeMap };
  },
  template: `
    <div
      class="fixed inset-0 z-50 flex items-center justify-center modal-backdrop-anim"
      :class="size === 'wide' ? 'p-3 sm:p-5 lg:p-8' : 'p-8 md:p-12'"
      @click.self="$emit('close')">

      <div
        class="bg-white rounded-3xl shadow-2xl border border-charcoal-200/90 w-full flex flex-col modal-card-anim transition-all duration-200"
        :class="[
          sizeMap[size] || 'max-w-2xl',
          noScroll ? 'overflow-visible' : 'overflow-hidden',
          noScroll ? '' : (size === 'wide' ? 'max-h-[calc(100vh-1.5rem)] sm:max-h-[calc(100vh-3rem)] lg:max-h-[calc(100vh-5rem)]' : 'max-h-[calc(100vh-6rem)]')
        ]">

        <div
          class="border-b border-charcoal-100 flex items-start justify-between gap-4 sm:gap-6 shrink-0"
          :class="noScroll
            ? 'px-5 py-3.5 sm:px-7 sm:py-4 lg:px-8 lg:py-4'
            : (size === 'wide' ? 'px-5 py-4 sm:px-8 sm:py-6 lg:px-10 lg:py-7' : 'px-10 py-7')">
          <div class="min-w-0">
            <h3 class="text-xl font-bold text-charcoal-900 tracking-tight">{{ title }}</h3>
            <p v-if="subtitle" class="text-xs text-charcoal-500 mt-1 leading-relaxed">{{ subtitle }}</p>
          </div>
          <button
            type="button"
            @click="$emit('close')"
            class="w-9 h-9 rounded-full flex items-center justify-center text-charcoal-400 hover:text-charcoal-700 hover:bg-charcoal-100 transition-colors cursor-pointer text-xl shrink-0">
            <i class="ph ph-x"></i>
          </button>
        </div>

        <div
          class="flex-1 min-h-0"
          :class="[
            noScroll ? 'overflow-visible px-5 py-4 sm:px-7 sm:py-4 lg:px-8 lg:py-4 space-y-4' : 'overflow-y-auto',
            !noScroll && (size === 'wide' ? 'px-5 py-5 sm:px-8 sm:py-6 lg:px-10 lg:py-7 space-y-5' : 'px-10 py-8 space-y-6')
          ]">
          <slot></slot>
        </div>

        <div
          class="border-t border-charcoal-100 bg-white rounded-b-3xl shrink-0"
          :class="noScroll
            ? 'px-5 py-3.5 sm:px-7 sm:py-4 lg:px-8 lg:py-4 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3'
            : (size === 'wide'
              ? 'px-5 py-4 sm:px-8 sm:py-5 lg:px-10 lg:py-6 flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3'
              : 'px-10 py-6 flex items-center justify-between gap-4')">
          <div>
            <slot name="footer-left"></slot>
          </div>
          <div class="flex items-center justify-end gap-2.5 sm:gap-3 flex-wrap">
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
