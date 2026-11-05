// Component: ExecutiveCard
// Clean, human-readable executive module card with direct Hero KPI

export default {
  name: 'ExecutiveCard',
  props: {
    icon: { type: String, default: 'ph-stack' },
    title: { type: String, required: true },
    badge: { type: String, required: true },
    badgeColor: { type: String, default: 'emerald' },
    kpi: { type: [String, Number], required: true },
    label: { type: String, required: true },
    description: { type: String, required: true },
    actionText: { type: String, default: 'Ingresar al módulo' }
  },
  emits: ['click'],
  setup(props) {
    const badgeClasses = {
      emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      amber: 'bg-amber-50 text-amber-700 border-amber-200',
      charcoal: 'bg-charcoal-100 text-charcoal-800 border-charcoal-200'
    };

    return {
      badgeClass: badgeClasses[props.badgeColor] || badgeClasses.emerald
    };
  },
  template: `
    <div 
      @click="$emit('click')"
      class="group bg-white rounded-2xl p-6 border border-charcoal-200 hover:border-charcoal-900 flex flex-col justify-between shadow-xs hover:shadow-lg hover:-translate-y-1 transition-all duration-200 cursor-pointer relative">
      <div>
        <div class="flex items-center justify-between mb-4">
          <div class="w-11 h-11 rounded-xl bg-charcoal-100 group-hover:bg-[#18181B] group-hover:text-white flex items-center justify-center text-charcoal-800 transition-colors">
            <i :class="['ph', icon, 'text-2xl']"></i>
          </div>
          <span :class="['text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border', badgeClass]">
            {{ badge }}
          </span>
        </div>

        <div class="text-[11px] font-bold text-charcoal-400 uppercase tracking-wider mb-1">
          {{ title }}
        </div>

        <div class="flex items-baseline gap-2 mb-1.5">
          <span class="text-3xl font-black text-charcoal-900 mono-code tracking-tight">{{ kpi }}</span>
          <span class="text-xs text-charcoal-500 font-medium">{{ label }}</span>
        </div>

        <p class="text-xs text-charcoal-600 leading-relaxed">
          {{ description }}
        </p>
      </div>

      <div class="pt-4 mt-4 border-t border-charcoal-100 flex items-center justify-between text-xs font-semibold text-charcoal-700 group-hover:text-charcoal-900">
        <span>{{ actionText }}</span>
        <i class="ph ph-arrow-right text-sm group-hover:translate-x-1 transition-transform"></i>
      </div>
    </div>
  `
};
