// Component: ViewInicio
// Dashboard simplificado: KPIs, row de gráfica optimizada + actividad, y tabla inferior con altura restante y scroll interno

import { ref, computed } from 'vue';

const ACCENT = '#00A5FF';

export default {
  name: 'ViewInicio',
  props: {
    summary: { type: Object, default: () => ({}) },
    recentRecords: { type: Array, default: () => [] },
    devices: { type: Array, default: () => [] },
    employees: { type: Array, default: () => [] },
    areas: { type: Array, default: () => [] },
    isSyncing: { type: Boolean, default: false },
    user: { type: Object, default: () => ({ name: 'Angel Flores' }) }
  },
  emits: ['navigate', 'sync-clock'],
  setup(props) {
    const firstName = computed(() => (props.user?.name || 'Angel').split(' ')[0]);
    const hoveredIndex = ref(null);

    const todayStr = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD local
    const validRecords = computed(() => props.recentRecords.filter(r => !r.es_rebote));

    const checadasHoy = computed(() =>
      validRecords.value.filter(r => (r.fecha_hora_display || '').startsWith(todayStr)).length
    );
    const empleadosPresentes = computed(() => {
      const set = new Set(
        validRecords.value
          .filter(r => (r.fecha_hora_display || '').startsWith(todayStr))
          .map(r => r.codigo_empleado)
      );
      return set.size;
    });
    const relojesOnline = computed(() => props.devices.filter(d => d.estado === 'ONLINE').length);

    // Serie: checadas válidas por día (últimos 14 días)
    const series = computed(() => {
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toLocaleDateString('sv-SE'));
      }
      const counts = Object.fromEntries(days.map(d => [d, 0]));
      validRecords.value.forEach(r => {
        const k = (r.fecha_hora_display || '').slice(0, 10);
        if (k in counts) counts[k]++;
      });
      return days.map(d => ({ day: d, value: counts[d] }));
    });

    const totalPeriodo = computed(() => series.value.reduce((acc, s) => acc + s.value, 0));

    // Geometría del SVG maximizada de borde a borde dentro de su tarjeta
    const W = 800;
    const H = 200;
    const PAD_TOP = 18;
    const PAD_BOTTOM = 28;

    const chart = computed(() => {
      const pts = series.value;
      const rawMax = Math.max(1, ...pts.map(p => p.value));
      const max = Math.ceil(rawMax * 1.15); // Margen superior para onda fluida
      const step = W / (pts.length - 1);

      // Coordenadas [x, y] de extremo a extremo sin espacios muertos laterales
      const xy = pts.map((p, i) => {
        const x = i * step;
        const y = (H - PAD_BOTTOM) - (p.value / max) * (H - PAD_BOTTOM - PAD_TOP);
        return [x, y];
      });

      // Curva Catmull-Rom a Bézier cúbica
      let d = `M ${xy[0][0]} ${xy[0][1]}`;
      for (let i = 0; i < xy.length - 1; i++) {
        const p0 = xy[i - 1] || xy[i];
        const p1 = xy[i];
        const p2 = xy[i + 1];
        const p3 = xy[i + 2] || p2;

        let c1x = p1[0] + (p2[0] - p0[0]) / 6;
        let c1y = p1[1] + (p2[1] - p0[1]) / 6;
        let c2x = p2[0] - (p3[0] - p1[0]) / 6;
        let c2y = p2[1] - (p3[1] - p1[1]) / 6;

        c1y = Math.min(H - PAD_BOTTOM, Math.max(PAD_TOP, c1y));
        c2y = Math.min(H - PAD_BOTTOM, Math.max(PAD_TOP, c2y));

        d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
      }

      const area = `${d} L ${W} ${H - PAD_BOTTOM} L 0 ${H - PAD_BOTTOM} Z`;

      const gridY = [
        PAD_TOP,
        PAD_TOP + (H - PAD_BOTTOM - PAD_TOP) * 0.33,
        PAD_TOP + (H - PAD_BOTTOM - PAD_TOP) * 0.66,
        H - PAD_BOTTOM
      ];

      return { d, area, xy, max, gridY };
    });

    function handleChartMouseMove(e) {
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const normalizedX = (mouseX / rect.width) * W;
      const step = W / (series.value.length - 1);
      const idx = Math.round(normalizedX / step);
      if (idx >= 0 && idx < series.value.length) {
        hoveredIndex.value = idx;
      }
    }

    function handleChartMouseLeave() {
      hoveredIndex.value = null;
    }

    // Heatmap de actividad (14 días)
    const heat = computed(() => {
      const max = Math.max(1, ...series.value.map(s => s.value));
      return series.value.map(s => ({
        day: s.day,
        value: s.value,
        level: s.value === 0 ? 0 : s.value / max > 0.5 ? 2 : 1
      }));
    });

    return {
      firstName,
      checadasHoy,
      empleadosPresentes,
      relojesOnline,
      series,
      totalPeriodo,
      chart,
      heat,
      hoveredIndex,
      handleChartMouseMove,
      handleChartMouseLeave,
      W,
      H,
      PAD_TOP,
      PAD_BOTTOM,
      ACCENT
    };
  },
  template: `
    <div class="w-full flex-1 min-h-0 flex flex-col space-y-4 animate-in fade-in duration-150">

      <!-- Saludo + Acciones de hardware -->
      <div class="flex items-start justify-between gap-4 shrink-0">
        <div>
          <h2 class="text-3xl font-bold text-charcoal-900 tracking-tight">Hola, {{ firstName }}</h2>
          <p class="text-xs text-sky-600 mt-0.5">Panel de asistencia</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            @click="$emit('sync-clock')"
            class="flex items-center gap-2 text-xs font-semibold text-charcoal-700 bg-white hover:bg-charcoal-50 px-4 py-2 rounded-xl border border-charcoal-200 shadow-2xs transition-all cursor-pointer">
            <i class="ph ph-arrows-clockwise text-sm" :class="{ 'animate-spin': isSyncing }"></i>
            <span>{{ isSyncing ? 'Sincronizando…' : 'Sincronizar reloj' }}</span>
          </button>
        </div>
      </div>

      <!-- 4 KPIs principales -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
        <button type="button" @click="$emit('navigate','monitor')" class="text-left bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4 cursor-pointer">
          <span class="text-4xl lg:text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ checadasHoy }}</span>
          <div class="min-w-0">
            <p class="text-sm font-bold text-charcoal-900">Checadas</p>
            <p class="text-[11px] text-charcoal-400">válidas hoy</p>
          </div>
        </button>
        <button type="button" @click="$emit('navigate','empleados')" class="text-left bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4 cursor-pointer">
          <span class="text-4xl lg:text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ empleadosPresentes }}</span>
          <div class="min-w-0">
            <p class="text-sm font-bold text-charcoal-900">Presentes</p>
            <p class="text-[11px] text-charcoal-400">de {{ employees.length }} empleados</p>
          </div>
        </button>
        <button type="button" @click="$emit('navigate','relojes')" class="text-left bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4 cursor-pointer">
          <span class="text-4xl lg:text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ relojesOnline }}</span>
          <div class="min-w-0">
            <p class="text-sm font-bold text-charcoal-900">Relojes</p>
            <p class="text-[11px] text-charcoal-400">en línea</p>
          </div>
        </button>
        <button type="button" @click="$emit('navigate','areas')" class="text-left bg-white rounded-3xl px-6 py-4 border border-charcoal-200 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4 cursor-pointer">
          <span class="text-4xl lg:text-5xl font-black text-charcoal-900 tracking-tight leading-none">{{ areas.length }}</span>
          <div class="min-w-0">
            <p class="text-sm font-bold text-charcoal-900">Áreas</p>
            <p class="text-[11px] text-charcoal-400">configuradas</p>
          </div>
        </button>
      </div>

      <!-- ROW: GRÁFICA DE ASISTENCIA + ACTIVIDAD (HEATMAP) -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 shrink-0">
        
        <!-- Tarjeta de Gráfica Optimizada (2/3 del row) -->
        <div class="lg:col-span-2 bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden flex flex-col justify-between">
          
          <div class="px-6 pt-4 pb-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-bold text-charcoal-900 tracking-tight">Tráfico de asistencia</h3>
                <span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-charcoal-100 text-charcoal-700 mono-code">
                  14 días
                </span>
              </div>
              <p class="text-[11px] text-charcoal-400 mt-0.5">
                Checadas válidas confirmadas por terminal biométrica
              </p>
            </div>

            <div>
              <div v-if="hoveredIndex !== null" class="flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-sky-50 border border-sky-200 text-sky-800 text-xs font-semibold animate-in fade-in">
                <span class="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse"></span>
                <span>{{ series[hoveredIndex].day }}: <b class="mono-code font-bold">{{ series[hoveredIndex].value }} checadas</b></span>
              </div>
              <div v-else class="text-xs text-charcoal-500">
                Total: <b class="mono-code text-charcoal-900 font-bold">{{ totalPeriodo }}</b> checadas
              </div>
            </div>
          </div>

          <!-- Canvas SVG maximizado de borde a borde -->
          <div class="w-full relative px-3 sm:px-5 pb-2 select-none cursor-crosshair"
               @mousemove="handleChartMouseMove"
               @mouseleave="handleChartMouseLeave">
            
            <svg :viewBox="'0 0 ' + W + ' ' + H" class="w-full h-44 sm:h-48 overflow-visible" preserveAspectRatio="none">
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" :stop-color="ACCENT" stop-opacity="0.25" />
                  <stop offset="75%" :stop-color="ACCENT" stop-opacity="0.04" />
                  <stop offset="100%" :stop-color="ACCENT" stop-opacity="0.0" />
                </linearGradient>
              </defs>

              <line
                v-for="(gy, idx) in chart.gridY"
                :key="'gy' + idx"
                x1="0"
                :y1="gy"
                :x2="W"
                :y2="gy"
                :stroke="idx === chart.gridY.length - 1 ? '#E4E4E7' : '#F4F4F5'"
                :stroke-dasharray="idx === chart.gridY.length - 1 ? 'none' : '4 4'"
                :stroke-width="idx === chart.gridY.length - 1 ? 1.5 : 1"
              />

              <line
                v-for="(p, i) in chart.xy"
                :key="'vl' + i"
                :x1="p[0]"
                :y1="PAD_TOP"
                :x2="p[0]"
                :y2="H - PAD_BOTTOM"
                stroke="#F4F4F5"
                stroke-dasharray="3 3"
                stroke-width="1"
              />

              <path :d="chart.area" fill="url(#areaGrad)" />

              <path
                :d="chart.d"
                fill="none"
                :stroke="ACCENT"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />

              <line
                v-if="hoveredIndex !== null"
                :x1="chart.xy[hoveredIndex][0]"
                :y1="PAD_TOP"
                :x2="chart.xy[hoveredIndex][0]"
                :y2="H - PAD_BOTTOM"
                :stroke="ACCENT"
                stroke-width="1.5"
                stroke-dasharray="3 3"
              />

              <circle
                v-for="(p, i) in chart.xy"
                :key="'pt' + i"
                :cx="p[0]"
                :cy="p[1]"
                :r="hoveredIndex === i ? 5.5 : 3"
                :fill="hoveredIndex === i ? ACCENT : '#FFFFFF'"
                :stroke="ACCENT"
                :stroke-width="hoveredIndex === i ? 2.5 : 2"
                class="transition-all duration-100"
              />

              <text
                v-for="(p, i) in chart.xy"
                :key="'txt' + i"
                v-show="i % 2 === 0 || i === series.length - 1"
                :x="p[0]"
                :y="H - 6"
                :text-anchor="i === 0 ? 'start' : (i === series.length - 1 ? 'end' : 'middle')"
                font-size="10.5"
                font-weight="500"
                fill="#94A3B8"
                class="mono-code">
                {{ series[i].day }}
              </text>
            </svg>
          </div>
        </div>

        <!-- Tarjeta de Actividad (1/3 del row) -->
        <div class="bg-white rounded-3xl p-5 border border-charcoal-200 shadow-sm flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-sm font-bold text-charcoal-900">Actividad reciente</h3>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                100% ONLINE
              </span>
            </div>
            <p class="text-[11px] text-charcoal-400">
              Frecuencia de asistencia en los últimos 14 días
            </p>

            <div class="grid grid-cols-7 gap-1.5 my-3">
              <div
                v-for="(h, i) in heat"
                :key="i"
                :title="h.day + ': ' + h.value + ' checadas'"
                class="aspect-square rounded-lg flex items-center justify-center transition-all hover:scale-105 cursor-pointer relative group"
                :class="h.level === 2 ? 'bg-charcoal-900 text-white' : (h.level === 1 ? 'bg-sky-500 text-white' : 'bg-charcoal-100 text-charcoal-400')">
                <span class="text-[10px] font-bold mono-code">{{ h.value || '' }}</span>
              </div>
            </div>

            <div class="p-2.5 rounded-2xl bg-charcoal-50 border border-charcoal-200/80 text-xs space-y-1 mb-3">
              <div class="flex justify-between text-charcoal-500">
                <span>Filtro anti-rebote:</span>
                <b class="text-charcoal-900 mono-code">180 seg</b>
              </div>
              <div class="flex justify-between text-charcoal-500">
                <span>Terminal activa:</span>
                <b class="text-emerald-700 font-medium">Cerro Gordo (Wi-Fi)</b>
              </div>
            </div>
          </div>

          <button
            type="button"
            @click="$emit('navigate','reportes')"
            class="w-full text-xs font-bold bg-[#18181B] hover:bg-black text-white py-2.5 rounded-xl flex items-center justify-center gap-2 transition-all cursor-pointer shadow-xs">
            <i class="ph ph-file-csv text-base"></i>
            <span>Ir a Pre-Nómina y Reportes</span>
          </button>
        </div>

      </div>

      <!-- TABLA INFERIOR: OCUPA EL ESPACIO RESTANTE CON SCROLL SOBRE LOS REGISTROS Y PADDING CONSISTENTE AL FINAL -->
      <div class="w-full bg-white rounded-3xl border border-charcoal-200 shadow-sm overflow-hidden flex flex-col flex-1 min-h-[180px]">
        
        <!-- Header fijo superior de la tabla -->
        <div class="px-6 py-3.5 border-b border-charcoal-100 flex items-center justify-between shrink-0 bg-white">
          <div class="flex items-center gap-2.5">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <h3 class="text-sm font-bold text-charcoal-900">Últimas checadas en tiempo real</h3>
            <span class="text-[11px] text-charcoal-400 mono-code font-medium">({{ recentRecords.length }} registradas)</span>
          </div>
          <button
            type="button"
            @click="$emit('navigate','monitor')"
            class="text-xs font-semibold text-charcoal-500 hover:text-charcoal-900 flex items-center gap-1 cursor-pointer transition-colors">
            <span>Ver bitácora completa</span>
            <i class="ph ph-arrow-right"></i>
          </button>
        </div>

        <!-- Área de la tabla con scroll interno -->
        <div class="flex-1 overflow-y-auto min-h-0">
          <table class="w-full text-left border-collapse">
            <thead class="sticky top-0 z-10 bg-charcoal-50/95 backdrop-blur-sm border-b border-charcoal-100 text-[10px] font-bold uppercase tracking-wider text-charcoal-400">
              <tr>
                <th class="py-2.5 px-6">ID</th>
                <th class="py-2.5 px-4">Colaborador</th>
                <th class="py-2.5 px-4">Área</th>
                <th class="py-2.5 px-4">Método</th>
                <th class="py-2.5 px-4">Fecha y Hora Reloj</th>
                <th class="py-2.5 px-6 text-right">Estatus Pre-Nómina</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-charcoal-100 text-xs">
              <tr
                v-for="rec in recentRecords"
                :key="rec.id"
                class="hover:bg-charcoal-50/60 transition-colors">
                
                <td class="py-3 px-6 mono-code font-bold text-charcoal-500">
                  #{{ rec.codigo_empleado }}
                </td>

                <td class="py-3 px-4">
                  <div class="flex items-center gap-2.5">
                    <div class="w-7 h-7 rounded-full bg-[#18181B] text-white flex items-center justify-center text-[10px] font-bold shrink-0">
                      {{ (rec.nombre || 'E').slice(0, 2).toUpperCase() }}
                    </div>
                    <div>
                      <span class="font-bold text-charcoal-900">{{ rec.nombre }}</span>
                    </div>
                  </div>
                </td>

                <td class="py-3 px-4 text-charcoal-600 font-medium">
                  {{ rec.area }}
                </td>

                <td class="py-3 px-4">
                  <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border"
                    :class="{
                      'bg-indigo-50 text-indigo-700 border-indigo-200': rec.metodo === 'HUELLA',
                      'bg-emerald-50 text-emerald-700 border-emerald-200': rec.metodo === 'ROSTRO',
                      'bg-amber-50 text-amber-700 border-amber-200': rec.metodo === 'PIN',
                      'bg-charcoal-100 text-charcoal-800 border-charcoal-200': !['HUELLA','ROSTRO','PIN'].includes(rec.metodo)
                    }">
                    <i class="ph" :class="{
                      'ph-fingerprint': rec.metodo === 'HUELLA',
                      'ph-scan-smiley': rec.metodo === 'ROSTRO',
                      'ph-password': rec.metodo === 'PIN'
                    }"></i>
                    {{ rec.metodo }}
                  </span>
                </td>

                <td class="py-3 px-4 mono-code text-charcoal-600">
                  {{ rec.fecha_hora_display }}
                </td>

                <td class="py-3 px-6 text-right">
                  <span
                    v-if="rec.es_rebote"
                    class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">
                    <i class="ph ph-warning-circle"></i> REBOTE &lt;180s
                  </span>
                  <span
                    v-else
                    class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <i class="ph ph-check-circle"></i> VÁLIDO
                  </span>
                </td>
              </tr>

              <tr v-if="!recentRecords.length">
                <td colspan="6" class="py-10 text-center text-xs text-charcoal-400">
                  <i class="ph ph-fingerprint text-3xl mb-1.5 block text-charcoal-300"></i>
                  <span>Esperando checadas del terminal Hikvision...</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

      </div>

    </div>
  `
};
