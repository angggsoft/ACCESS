// Component: AppSidebar
// Collapsible navigation sidebar with ACCESS modules, Multi-Tenant shortcuts and Role separation

export const MODULES_NAV = [
  { 
    id: 'inicio', 
    title: 'Inicio', 
    shortLabel: 'Inicio', 
    icon: 'ph-house',
    actions: [
      { id: 'open_companies_home', label: 'Cambiar Empresa / Sucursal', subtitle: 'Alternar entre tus empresas y sedes', icon: 'ph-buildings', type: 'modal-companies' },
      { id: 'invite_totp_home', label: 'Invitar RH (Clave 5 min)', subtitle: 'Compartir código y clave dinámica TOTP', icon: 'ph-key', type: 'modal-invite' },
      { id: 'refresh_home', label: 'Actualizar Datos', subtitle: 'Refrescar checadas y estado del reloj', icon: 'ph-arrows-clockwise', type: 'refresh' }
    ]
  },
  { 
    id: 'monitor', 
    title: 'Monitor de Checadas en Vivo', 
    shortLabel: 'Monitor en Vivo', 
    icon: 'ph-broadcast',
    actions: [
      { id: 'refresh_mon', label: 'Actualizar Monitor', subtitle: 'Consultar últimas checadas recibidas', icon: 'ph-arrows-clockwise', type: 'refresh' },
      { id: 'export_csv', label: 'Exportar Bitácora (CSV)', subtitle: 'Descargar registros de la sucursal', icon: 'ph-download-simple', type: 'export-csv' }
    ]
  },
  { 
    id: 'relojes', 
    title: 'Relojes Checadores', 
    shortLabel: 'Relojes Checadores', 
    icon: 'ph-fingerprint',
    actions: [
      { id: 'add_clock', label: 'Registrar Reloj en Sucursal', subtitle: 'Generar token Push único para reloj Hikvision', icon: 'ph-plus-circle', type: 'modal-clock' },
      { id: 'refresh_dev', label: 'Actualizar Estado', subtitle: 'Verificar último contacto del reloj', icon: 'ph-arrows-clockwise', type: 'refresh' }
    ]
  },
  { 
    id: 'empleados', 
    title: 'Plantilla de Empleados', 
    shortLabel: 'Empleados y Biometría', 
    icon: 'ph-users-three',
    actions: [
      { id: 'refresh_emp', label: 'Actualizar Plantilla', subtitle: 'Sincronizar empleados detectados en reloj', icon: 'ph-arrows-clockwise', type: 'refresh' }
    ]
  },
  { 
    id: 'areas', 
    title: 'Empresa, Sucursales y Áreas', 
    shortLabel: 'Empresa y Áreas', 
    icon: 'ph-buildings',
    actions: [
      { id: 'new_area', label: 'Nueva Área / Turno', subtitle: 'Crear departamento, horario y días laborales', icon: 'ph-plus-circle', type: 'modal-area' },
      { id: 'new_comp', label: 'Crear Nueva Empresa', subtitle: 'Registrar razón social y sucursal matriz', icon: 'ph-buildings', type: 'empresa-nueva' },
      { id: 'invite_rh', label: 'Equipo y Código de Acceso', subtitle: 'Unirse a empresa, generar código o gestionar miembros', icon: 'ph-users-three', type: 'modal-invite' }
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
      { id: 'open_companies_cfg', label: 'Empresas e Invitaciones', subtitle: 'Gestionar empresas, sucursales y clave 5 min', icon: 'ph-buildings', type: 'modal-companies' }
    ]
  }
];

export const ADMIN_MODULES_NAV = [
  {
    id: 'admin_saas',
    title: 'Suscripciones y Clientes RH',
    shortLabel: 'Clientes y Suscripciones',
    icon: 'ph-shield-check',
    actions: []
  }
];

export default {
  name: 'AppSidebar',
  props: {
    activeModule: { type: String, default: 'inicio' },
    isCollapsed: { type: Boolean, default: false },
    isAdminSaas: { type: Boolean, default: false },
    companyName: { type: String, default: 'Quodo S.A. de C.V.' },
    branchName: { type: String, default: 'Planta Cerro Gordo' },
    branchSubtitle: { type: String, default: 'One-Way Push' }
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
      rhModules: MODULES_NAV,
      adminModules: ADMIN_MODULES_NAV,
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
          {{ isAdminSaas ? 'Consola SaaS' : 'Módulos ACCESS' }}
        </div>

        <div v-for="m in (isAdminSaas ? adminModules : rhModules)" :key="m.id" class="space-y-0.5">
          
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
          </button>

        </div>

      </div>

      <!-- FOOTER DE SEDE ACTIVA EN SIDEBAR (SOLO RH) -->
      <div v-if="!isAdminSaas && !isCollapsed" class="p-3 border-t border-charcoal-100">
        <button
          type="button"
          @click="$emit('quick-action', 'modal-companies')"
          class="w-full p-2.5 rounded-2xl bg-offwhite hover:bg-charcoal-100 border border-charcoal-200 text-left transition-all cursor-pointer group">
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">Empresa / Sucursal</span>
            <i class="ph ph-caret-up-down text-xs text-charcoal-400 group-hover:text-charcoal-900"></i>
          </div>
          <p class="text-xs font-bold text-charcoal-900 truncate mt-0.5">{{ companyName }}</p>
          <p class="text-[11px] text-emerald-700 font-semibold truncate flex items-center gap-1 mt-0.5">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>{{ branchName }}</span>
          </p>
        </button>
      </div>

    </aside>
  `
};
