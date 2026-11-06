// Component: AppSidebar
// Collapsible navigation sidebar with ACCESS modules and nested operational action shortcuts

export const MODULES_NAV = [
  { 
    id: 'inicio', 
    title: 'Inicio', 
    shortLabel: 'Inicio', 
    icon: 'ph-house',
    actions: [
      { id: 'sync_clock_home', label: 'Sincronizar Reloj', subtitle: 'Descargar checadas y usuarios de la terminal', icon: 'ph-arrows-clockwise', type: 'sync-clock' },
      { id: 'sync_time_home', label: 'Calibrar Hora Reloj', subtitle: 'Ajustar hora del dispositivo vía ISAPI', icon: 'ph-clock-clockwise', type: 'sync-time' }
    ]
  },
  { 
    id: 'monitor', 
    title: 'Monitor de Checadas en Vivo', 
    shortLabel: 'Monitor en Vivo', 
    icon: 'ph-broadcast',
    actions: [
      { id: 'sync_now', label: 'Sincronizar Reloj (Pull)', subtitle: 'Extraer eventos de la memoria del reloj', icon: 'ph-arrows-clockwise', type: 'sync-clock' },
      { id: 'export_csv', label: 'Exportar Bitácora (CSV)', subtitle: 'Descargar registros en formato CSV', icon: 'ph-download-simple', type: 'export-csv' }
    ]
  },
  { 
    id: 'relojes', 
    title: 'Relojes Checadores', 
    shortLabel: 'Relojes Checadores', 
    icon: 'ph-fingerprint',
    actions: [
      { id: 'add_clock', label: 'Agregar Reloj Checador', subtitle: 'Registrar nueva terminal Hikvision ISAPI', icon: 'ph-plus-circle', type: 'modal-clock' },
      { id: 'sync_clock_dev', label: 'Sincronizar Reloj Activo', subtitle: 'Extraer eventos y censo de usuarios', icon: 'ph-arrows-clockwise', type: 'sync-clock' },
      { id: 'sync_time', label: 'Calibrar Hora Reloj', subtitle: 'Sincronizar hora del servidor al reloj', icon: 'ph-clock-clockwise', type: 'sync-time' }
    ]
  },
  { 
    id: 'empleados', 
    title: 'Plantilla de Empleados', 
    shortLabel: 'Empleados y Biometría', 
    icon: 'ph-users-three',
    actions: [
      { id: 'new_emp', label: 'Nuevo Empleado (Alta ISAPI)', subtitle: 'Registrar colaborador y enviarlo al reloj', icon: 'ph-user-plus', type: 'modal-employee' },
      { id: 'sync_emp', label: 'Importar Usuarios del Reloj', subtitle: 'Sincronizar censo desde la terminal', icon: 'ph-arrows-clockwise', type: 'sync-clock' }
    ]
  },
  { 
    id: 'areas', 
    title: 'Áreas y Turnos', 
    shortLabel: 'Áreas y Turnos', 
    icon: 'ph-buildings',
    actions: [
      { id: 'new_area', label: 'Nueva Área / Turno', subtitle: 'Crear departamento, turno y tolerancia', icon: 'ph-plus-circle', type: 'modal-area' }
    ]
  },
  { 
    id: 'reportes', 
    title: 'Reportes', 
    shortLabel: 'Reportes', 
    icon: 'ph-chart-bar',
    actions: [
      { id: 'send_report_email', label: 'Enviar Reporte por Correo', subtitle: 'Despachar reporte actual vía SMTP', icon: 'ph-paper-plane-tilt', type: 'report-send-email' },
      { id: 'export_payroll', label: 'Descargar Reporte (CSV)', subtitle: 'Exportar vista actual a archivo CSV', icon: 'ph-file-csv', type: 'export-csv' },
      { id: 'smtp_config', label: 'Configurar Correo (SMTP)', subtitle: 'Ajustar servidor y contraseña de aplicación', icon: 'ph-gear', type: 'report-smtp-config' }
    ]
  },
  { 
    id: 'configuracion', 
    title: 'Configuración del Sistema', 
    shortLabel: 'Configuración', 
    icon: 'ph-gear',
    actions: [
      { id: 'test_conn', label: 'Probar Conexión Reloj', subtitle: 'Verificar enlace HTTP Digest ISAPI', icon: 'ph-plugs-connected', type: 'test-clock-conn' },
      { id: 'sync_time_cfg', label: 'Calibrar Hora Reloj', subtitle: 'Sincronizar hora del servidor al reloj', icon: 'ph-clock-clockwise', type: 'sync-time' }
    ]
  }
];

export default {
  name: 'AppSidebar',
  props: {
    activeModule: { type: String, default: 'inicio' },
    isCollapsed: { type: Boolean, default: false },
    branchName: { type: String, default: 'Cerro Gordo' },
    branchSubtitle: { type: String, default: '192.168.11.71 • Wi-Fi TBS' }
  },
  emits: ['select-module', 'quick-action'],
  setup(props, { emit }) {
    function select(id) {
      emit('select-module', id);
    }

    function executeSubAction(act) {
      emit('quick-action', act.type);
    }

    return {
      modules: MODULES_NAV,
      select,
      executeSubAction
    };
  },
  template: `
    <aside 
      class="h-full bg-white border-r border-charcoal-200 flex flex-col justify-between shrink-0 select-none sidebar-transition"
      :class="isCollapsed ? 'w-16' : 'w-64'">
      
      <div class="p-2 space-y-1 overflow-y-auto overflow-x-hidden flex-1">
        
        <div v-show="!isCollapsed" class="px-3.5 py-2 text-[10px] font-bold text-charcoal-400 uppercase tracking-wider">
          Módulos ACCESS
        </div>

        <div v-for="m in modules" :key="m.id" class="space-y-0.5">
          
          <button 
            type="button" 
            @click="select(m.id)"
            class="w-full h-11 flex items-center px-3.5 rounded-xl text-sm transition-all group cursor-pointer relative"
            :class="activeModule === m.id 
              ? 'bg-[#18181B] text-white font-semibold shadow-xs' 
              : 'text-charcoal-600 hover:text-charcoal-900 hover:bg-charcoal-100 font-medium'"
            :title="m.title">
            <span class="w-5 flex items-center justify-center shrink-0">
              <i :class="['ph', m.icon, 'text-lg', activeModule === m.id ? 'text-white' : 'text-charcoal-400 group-hover:text-charcoal-700']"></i>
            </span>
            <span v-show="!isCollapsed" class="ml-3 text-sm truncate flex-1 text-left" :class="{ 'font-semibold': activeModule === m.id }">
              {{ m.shortLabel }}
            </span>
            <span v-show="!isCollapsed && m.actions && m.actions.length && activeModule === m.id" class="text-[10px] text-charcoal-400">
              <i class="ph ph-caret-down text-xs"></i>
            </span>
          </button>

          <!-- NESTED ACTIONS -->
          <div 
            v-if="!isCollapsed && activeModule === m.id && m.actions && m.actions.length" 
            class="ml-6 pl-3 border-l-2 border-charcoal-200 py-1 space-y-1 animate-in fade-in duration-150">
            
            <button 
              v-for="act in m.actions" 
              :key="act.id" 
              type="button" 
              @click.stop="executeSubAction(act)" 
              class="w-full h-8 px-2.5 rounded-lg text-xs font-medium flex items-center gap-2.5 hover:bg-charcoal-100 text-charcoal-600 hover:text-charcoal-900 transition-colors cursor-pointer text-left group">
              <i :class="['ph', act.icon, 'text-charcoal-400 group-hover:text-charcoal-700 text-sm shrink-0']"></i>
              <span class="truncate flex-1">{{ act.label }}</span>
            </button>
          </div>

        </div>

      </div>

    </aside>
  `
};
