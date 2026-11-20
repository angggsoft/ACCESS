// Component: ScheduleBlocksEditor
// Editor visual semanal (Lun-Dom) de múltiples bloques horarios por día
// 100% componentes propios con slider de tiempo y diseño compacto sin scroll interno

import { ref, computed, onMounted, onUnmounted } from 'vue';

const WEEK_DAYS = [
  { num: 1, label: 'Lunes', short: 'Lun' },
  { num: 2, label: 'Martes', short: 'Mar' },
  { num: 3, label: 'Miércoles', short: 'Mié' },
  { num: 4, label: 'Jueves', short: 'Jue' },
  { num: 5, label: 'Viernes', short: 'Vie' },
  { num: 6, label: 'Sábado', short: 'Sáb' },
  { num: 7, label: 'Domingo', short: 'Dom' }
];

function toMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return null;
  const [hStr, mStr] = hhmm.trim().split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function fromMinutes(mins) {
  const clamped = Math.max(0, Math.min(23 * 60 + 55, Math.round(mins)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function splitHHMM(hhmm, fallback = '08:00') {
  const raw = (hhmm && typeof hhmm === 'string' && hhmm.includes(':')) ? hhmm.trim() : fallback;
  const [h, m] = raw.split(':');
  return {
    hNum: Math.max(0, Math.min(23, Number(h) || 0)),
    mNum: Math.max(0, Math.min(55, Math.round((Number(m) || 0) / 5) * 5))
  };
}

export default {
  name: 'ScheduleBlocksEditor',
  props: {
    modelValue: { type: Array, default: () => [] }
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const editorRootRef = ref(null);
    const quickStart = ref('08:00');
    const quickEnd = ref('17:00');
    const activeTimePickerKey = ref(null);

    const blocksByDay = computed(() => {
      const map = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
      for (const b of props.modelValue || []) {
        const d = Number(b?.dia_semana);
        if (d >= 1 && d <= 7) {
          map[d].push({
            dia_semana: d,
            hora_entrada: String(b.hora_entrada || '08:00').slice(0, 5),
            hora_salida: String(b.hora_salida || '17:00').slice(0, 5)
          });
        }
      }
      return map;
    });

    function emitBlocksMap(nextMap) {
      const flat = [];
      for (let d = 1; d <= 7; d++) {
        const list = nextMap[d] || [];
        list.forEach((b, idx) => {
          flat.push({
            dia_semana: d,
            orden_bloque: idx + 1,
            hora_entrada: b.hora_entrada,
            hora_salida: b.hora_salida
          });
        });
      }
      emit('update:modelValue', flat);
    }

    function cloneMap() {
      const copy = {};
      for (let d = 1; d <= 7; d++) {
        copy[d] = (blocksByDay.value[d] || []).map(b => ({ ...b }));
      }
      return copy;
    }

    function toggleTimePicker(key, event) {
      if (event) event.stopPropagation();
      activeTimePickerKey.value = activeTimePickerKey.value === key ? null : key;
    }

    function getCurrentValueForKey(key) {
      if (key === 'quickStart') return quickStart.value;
      if (key === 'quickEnd') return quickEnd.value;
      if (key && key.startsWith('b-')) {
        const parts = key.split('-');
        const dayNum = Number(parts[1]);
        const idx = Number(parts[2]);
        const field = parts[3];
        const blk = (blocksByDay.value[dayNum] || [])[idx];
        return blk ? blk[field] : '08:00';
      }
      return '08:00';
    }

    function applyValueForKey(key, hhmm) {
      if (key === 'quickStart') {
        quickStart.value = hhmm;
        return;
      }
      if (key === 'quickEnd') {
        quickEnd.value = hhmm;
        return;
      }
      if (key && key.startsWith('b-')) {
        const parts = key.split('-');
        const dayNum = Number(parts[1]);
        const idx = Number(parts[2]);
        const field = parts[3];
        updateBlockField(dayNum, idx, field, hhmm);
      }
    }

    function getMinutesForKey(key) {
      const mins = toMinutes(getCurrentValueForKey(key));
      return mins !== null ? Math.round(mins / 15) * 15 : 480;
    }

    function getHourForKey(key) {
      return splitHHMM(getCurrentValueForKey(key)).hNum;
    }

    function getMinutePartForKey(key) {
      return splitHHMM(getCurrentValueForKey(key)).mNum;
    }

    function onFullTimeSliderInput(key, totalMinsRaw) {
      const mins = Math.max(0, Math.min(23 * 60 + 45, Number(totalMinsRaw) || 0));
      applyValueForKey(key, fromMinutes(mins));
    }

    function onHourSliderInput(key, hRaw) {
      const curr = splitHHMM(getCurrentValueForKey(key));
      const h = String(Math.max(0, Math.min(23, Number(hRaw) || 0))).padStart(2, '0');
      const m = String(curr.mNum).padStart(2, '0');
      applyValueForKey(key, `${h}:${m}`);
    }

    function onMinuteSliderInput(key, mRaw) {
      const curr = splitHHMM(getCurrentValueForKey(key));
      const h = String(curr.hNum).padStart(2, '0');
      const m = String(Math.max(0, Math.min(55, Number(mRaw) || 0))).padStart(2, '0');
      applyValueForKey(key, `${h}:${m}`);
    }

    function sliderTrackStyle(val, min, max) {
      const pct = Math.max(0, Math.min(100, ((Number(val) - min) / (max - min)) * 100));
      return {
        background: `linear-gradient(to right, #18181B 0%, #18181B ${pct}%, #E4E4E7 ${pct}%, #E4E4E7 100%)`
      };
    }

    function handleOutsideClick(e) {
      if (!activeTimePickerKey.value) return;
      if (editorRootRef.value && !editorRootRef.value.contains(e.target)) {
        activeTimePickerKey.value = null;
        return;
      }
      const popover = e.target.closest('[data-time-picker-scope]');
      if (!popover) {
        activeTimePickerKey.value = null;
      }
    }

    onMounted(() => window.addEventListener('click', handleOutsideClick));
    onUnmounted(() => window.removeEventListener('click', handleOutsideClick));

    function toggleDay(dayNum) {
      const next = cloneMap();
      if (next[dayNum].length > 0) {
        next[dayNum] = [];
      } else {
        const qs = toMinutes(quickStart.value);
        const qe = toMinutes(quickEnd.value);
        const ent = (qs !== null && qe !== null && qs < qe) ? quickStart.value : '08:00';
        const sal = (qs !== null && qe !== null && qs < qe) ? quickEnd.value : '17:00';
        next[dayNum] = [{ dia_semana: dayNum, hora_entrada: ent, hora_salida: sal }];
      }
      emitBlocksMap(next);
    }

    function addBlock(dayNum) {
      const next = cloneMap();
      const curr = next[dayNum];
      if (!curr.length) {
        next[dayNum].push({ dia_semana: dayNum, hora_entrada: '08:00', hora_salida: '17:00' });
        emitBlocksMap(next);
        return;
      }
      const last = curr[curr.length - 1];
      const lastOut = toMinutes(last.hora_salida);
      if (lastOut === null) {
        next[dayNum].push({ dia_semana: dayNum, hora_entrada: '15:00', hora_salida: '18:00' });
      } else {
        const gap = lastOut <= 12 * 60 ? 240 : 60;
        let nextStart = lastOut + gap;
        if (nextStart >= 23 * 60 + 30) {
          nextStart = Math.min(lastOut + 15, 23 * 60 + 30);
        }
        let nextEnd = Math.min(nextStart + 180, 23 * 60 + 30);
        if (nextEnd <= nextStart) {
          nextEnd = Math.min(nextStart + 30, 23 * 60 + 55);
        }
        next[dayNum].push({
          dia_semana: dayNum,
          hora_entrada: fromMinutes(nextStart),
          hora_salida: fromMinutes(nextEnd)
        });
      }
      emitBlocksMap(next);
    }

    function removeBlock(dayNum, idx) {
      const next = cloneMap();
      next[dayNum].splice(idx, 1);
      if (activeTimePickerKey.value && activeTimePickerKey.value.startsWith(`b-${dayNum}-`)) {
        activeTimePickerKey.value = null;
      }
      emitBlocksMap(next);
    }

    function updateBlockField(dayNum, idx, field, val) {
      const next = cloneMap();
      if (!next[dayNum][idx]) return;
      next[dayNum][idx][field] = val;
      emitBlocksMap(next);
    }

    function applyQuickToRange(maxDay) {
      const qs = toMinutes(quickStart.value);
      const qe = toMinutes(quickEnd.value);
      if (qs === null || qe === null || qs >= qe) return;
      const next = cloneMap();
      for (let d = 1; d <= 7; d++) {
        if (d <= maxDay) {
          next[d] = [{ dia_semana: d, hora_entrada: quickStart.value, hora_salida: quickEnd.value }];
        } else {
          next[d] = [];
        }
      }
      activeTimePickerKey.value = null;
      emitBlocksMap(next);
    }

    function copyMondayToWeekdays() {
      const monday = blocksByDay.value[1] || [];
      if (!monday.length) return;
      const next = cloneMap();
      for (let d = 2; d <= 5; d++) {
        next[d] = monday.map(b => ({
          dia_semana: d,
          hora_entrada: b.hora_entrada,
          hora_salida: b.hora_salida
        }));
      }
      activeTimePickerKey.value = null;
      emitBlocksMap(next);
    }

    function blockDurationLabel(blk) {
      const s = toMinutes(blk.hora_entrada);
      const e = toMinutes(blk.hora_salida);
      if (s === null || e === null || e <= s) return '—';
      const h = Math.round(((e - s) / 60) * 10) / 10;
      return `${h}h`;
    }

    const validationErrors = computed(() => {
      const errors = [];
      let totalBlocks = 0;
      for (const day of WEEK_DAYS) {
        const list = blocksByDay.value[day.num] || [];
        totalBlocks += list.length;
        const parsed = [];
        for (let i = 0; i < list.length; i++) {
          const s = toMinutes(list[i].hora_entrada);
          const e = toMinutes(list[i].hora_salida);
          if (s === null || e === null) {
            errors.push(`${day.short}: formato de hora inválido en bloque ${i + 1}.`);
          } else if (s >= e) {
            errors.push(`${day.short} (bloque ${i + 1}): la entrada (${list[i].hora_entrada}) debe ser menor que la salida (${list[i].hora_salida}).`);
          } else {
            parsed.push({ s, e, rawIn: list[i].hora_entrada, rawOut: list[i].hora_salida });
          }
        }
        const sorted = [...parsed].sort((a, b) => a.s - b.s);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].s <= sorted[i - 1].e) {
            errors.push(`${day.short}: los bloques ${sorted[i - 1].rawIn}-${sorted[i - 1].rawOut} y ${sorted[i].rawIn}-${sorted[i].rawOut} se empalman.`);
          }
        }
      }
      if (totalBlocks === 0) {
        errors.push('Activa al menos un día laboral con su bloque de horario.');
      }
      return errors;
    });

    const summaryStats = computed(() => {
      let activeDays = 0;
      let totalMin = 0;
      const sigs = new Set();
      let multiBlockDay = false;
      for (const day of WEEK_DAYS) {
        const list = blocksByDay.value[day.num] || [];
        if (list.length > 0) {
          activeDays += 1;
          if (list.length > 1) multiBlockDay = true;
          const ordered = [...list].sort((a, b) => a.hora_entrada.localeCompare(b.hora_entrada));
          sigs.add(ordered.map(b => `${b.hora_entrada}-${b.hora_salida}`).join('|'));
          for (const b of list) {
            const s = toMinutes(b.hora_entrada);
            const e = toMinutes(b.hora_salida);
            if (s !== null && e !== null && e > s) totalMin += (e - s);
          }
        }
      }
      const hours = Math.round((totalMin / 60) * 10) / 10;
      const isMixed = multiBlockDay || sigs.size > 1;
      return {
        activeDays,
        hours,
        isMixed
      };
    });

    return {
      editorRootRef,
      WEEK_DAYS,
      quickStart,
      quickEnd,
      activeTimePickerKey,
      blocksByDay,
      toggleTimePicker,
      getMinutesForKey,
      getHourForKey,
      getMinutePartForKey,
      onFullTimeSliderInput,
      onHourSliderInput,
      onMinuteSliderInput,
      sliderTrackStyle,
      toggleDay,
      addBlock,
      removeBlock,
      updateBlockField,
      applyQuickToRange,
      copyMondayToWeekdays,
      blockDurationLabel,
      validationErrors,
      summaryStats
    };
  },
  template: `
    <div ref="editorRootRef" class="space-y-2.5 text-xs">
      <!-- Barra compacta de llenado rápido con Slider de Tiempo Propio -->
      <div class="px-3.5 py-2.5 rounded-2xl bg-offwhite border border-charcoal-200 flex flex-wrap items-center justify-between gap-2.5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[11px] font-bold text-charcoal-600 uppercase tracking-wider flex items-center gap-1.5">
            <span class="w-4 flex items-center justify-center shrink-0"><i class="ph ph-clock text-sm text-charcoal-400"></i></span>
            <span>Rápido:</span>
          </span>

          <!-- Selector propio Entrada Rápida (Slider) -->
          <div class="relative" data-time-picker-scope>
            <button
              type="button"
              @click="toggleTimePicker('quickStart', $event)"
              class="h-8 px-2.5 rounded-xl border text-xs mono-code font-bold flex items-center gap-1.5 transition-all cursor-pointer"
              :class="activeTimePickerKey === 'quickStart'
                ? 'bg-charcoal-900 text-white border-charcoal-900'
                : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200'">
              <i class="ph ph-clock text-xs" :class="activeTimePickerKey === 'quickStart' ? 'text-white/80' : 'text-charcoal-400'"></i>
              <span>{{ quickStart }}</span>
              <i class="ph ph-caret-down text-[9px]" :class="activeTimePickerKey === 'quickStart' ? 'rotate-180 text-white/70' : 'text-charcoal-400'"></i>
            </button>

            <div
              v-if="activeTimePickerKey === 'quickStart'"
              @click.stop
              class="absolute left-0 top-10 w-72 bg-white rounded-2xl border border-charcoal-200 shadow-2xl p-3.5 z-50 space-y-3">
              <div class="flex items-center justify-between pb-1.5 border-b border-charcoal-100">
                <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">Hora de Entrada</span>
                <span class="mono-code text-sm font-black text-charcoal-900">{{ quickStart }}</span>
              </div>
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                  <span>Hora ({{ String(getHourForKey('quickStart')).padStart(2, '0') }} h)</span>
                  <span class="mono-code">00h – 23h</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="23"
                  step="1"
                  :value="getHourForKey('quickStart')"
                  @input="onHourSliderInput('quickStart', $event.target.value)"
                  :style="sliderTrackStyle(getHourForKey('quickStart'), 0, 23)"
                  class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
              </div>
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                  <span>Minutos (:{{ String(getMinutePartForKey('quickStart')).padStart(2, '0') }})</span>
                  <span class="mono-code">:00 – :55</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="55"
                  step="5"
                  :value="getMinutePartForKey('quickStart')"
                  @input="onMinuteSliderInput('quickStart', $event.target.value)"
                  :style="sliderTrackStyle(getMinutePartForKey('quickStart'), 0, 55)"
                  class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
              </div>
            </div>
          </div>

          <span class="text-charcoal-400 font-bold">→</span>

          <!-- Selector propio Salida Rápida (Slider) -->
          <div class="relative" data-time-picker-scope>
            <button
              type="button"
              @click="toggleTimePicker('quickEnd', $event)"
              class="h-8 px-2.5 rounded-xl border text-xs mono-code font-bold flex items-center gap-1.5 transition-all cursor-pointer"
              :class="activeTimePickerKey === 'quickEnd'
                ? 'bg-charcoal-900 text-white border-charcoal-900'
                : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200'">
              <i class="ph ph-clock text-xs" :class="activeTimePickerKey === 'quickEnd' ? 'text-white/80' : 'text-charcoal-400'"></i>
              <span>{{ quickEnd }}</span>
              <i class="ph ph-caret-down text-[9px]" :class="activeTimePickerKey === 'quickEnd' ? 'rotate-180 text-white/70' : 'text-charcoal-400'"></i>
            </button>

            <div
              v-if="activeTimePickerKey === 'quickEnd'"
              @click.stop
              class="absolute left-0 top-10 w-72 bg-white rounded-2xl border border-charcoal-200 shadow-2xl p-3.5 z-50 space-y-3">
              <div class="flex items-center justify-between pb-1.5 border-b border-charcoal-100">
                <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">Hora de Salida</span>
                <span class="mono-code text-sm font-black text-charcoal-900">{{ quickEnd }}</span>
              </div>
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                  <span>Hora ({{ String(getHourForKey('quickEnd')).padStart(2, '0') }} h)</span>
                  <span class="mono-code">00h – 23h</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="23"
                  step="1"
                  :value="getHourForKey('quickEnd')"
                  @input="onHourSliderInput('quickEnd', $event.target.value)"
                  :style="sliderTrackStyle(getHourForKey('quickEnd'), 0, 23)"
                  class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
              </div>
              <div class="space-y-1.5">
                <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                  <span>Minutos (:{{ String(getMinutePartForKey('quickEnd')).padStart(2, '0') }})</span>
                  <span class="mono-code">:00 – :55</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="55"
                  step="5"
                  :value="getMinutePartForKey('quickEnd')"
                  @input="onMinuteSliderInput('quickEnd', $event.target.value)"
                  :style="sliderTrackStyle(getMinutePartForKey('quickEnd'), 0, 55)"
                  class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
              </div>
            </div>
          </div>

          <button
            type="button"
            @click="applyQuickToRange(5)"
            class="h-8 px-3 rounded-xl bg-[#18181B] hover:bg-black text-white text-[11px] font-bold cursor-pointer transition-colors">
            Aplicar Lun–Vie
          </button>
          <button
            type="button"
            @click="applyQuickToRange(6)"
            class="h-8 px-3 rounded-xl bg-white hover:bg-charcoal-100 border border-charcoal-200 text-charcoal-800 text-[11px] font-bold cursor-pointer transition-colors">
            Aplicar Lun–Sáb
          </button>
        </div>

        <button
          type="button"
          :disabled="!(blocksByDay[1] && blocksByDay[1].length)"
          @click="copyMondayToWeekdays"
          class="h-8 px-3 rounded-xl bg-white hover:bg-charcoal-100 disabled:opacity-40 border border-charcoal-200 text-charcoal-800 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors">
          <i class="ph ph-copy text-xs"></i>
          <span>Copiar Lunes a Lun–Vie</span>
        </button>
      </div>

      <!-- Matriz semanal compacta de 7 días (sin scroll) -->
      <div class="rounded-2xl border border-charcoal-200 divide-y divide-charcoal-100 bg-white">
        <div
          v-for="day in WEEK_DAYS"
          :key="day.num"
          class="px-3.5 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 transition-colors"
          :class="blocksByDay[day.num].length ? 'bg-white' : 'bg-offwhite/50'">

          <!-- Toggle día -->
          <div class="flex items-center gap-2.5 sm:w-36 shrink-0">
            <button
              type="button"
              @click="toggleDay(day.num)"
              class="w-9 h-5 rounded-full transition-colors relative cursor-pointer shrink-0 flex items-center"
              :class="blocksByDay[day.num].length ? 'bg-[#18181B]' : 'bg-charcoal-200'">
              <span
                class="block w-3.5 h-3.5 rounded-full bg-white shadow-xs transition-transform"
                :class="blocksByDay[day.num].length ? 'translate-x-[18px]' : 'translate-x-[3px]'"></span>
            </button>
            <div class="min-w-0 flex items-center gap-2 sm:block">
              <div class="font-bold text-charcoal-900 text-xs leading-tight">{{ day.label }}</div>
              <div class="text-[10px] leading-tight" :class="blocksByDay[day.num].length ? 'text-emerald-700 font-semibold' : 'text-charcoal-400'">
                {{ blocksByDay[day.num].length ? (blocksByDay[day.num].length + (blocksByDay[day.num].length === 1 ? ' bloque' : ' bloques')) : 'Descanso' }}
              </div>
            </div>
          </div>

          <!-- Lista horizontal de bloques del día -->
          <div class="flex-1 flex flex-wrap items-center gap-2 min-w-0">
            <div v-if="!blocksByDay[day.num].length" class="w-full flex items-center justify-between">
              <span class="text-[11px] text-charcoal-400 italic">Día de descanso (sin checadas programadas)</span>
              <button
                type="button"
                @click="toggleDay(day.num)"
                class="h-7 px-2.5 rounded-lg bg-white hover:bg-charcoal-100 border border-charcoal-200 text-charcoal-700 text-[11px] font-bold cursor-pointer transition-colors">
                + Activar {{ day.short }}
              </button>
            </div>

            <div
              v-for="(blk, idx) in blocksByDay[day.num]"
              :key="idx"
              class="flex items-center gap-1.5 px-2 py-1 rounded-xl bg-offwhite border border-charcoal-200/80">
              <span class="px-1.5 py-0.5 rounded-md bg-[#18181B] text-white text-[10px] mono-code font-bold">
                B{{ idx + 1 }}
              </span>

              <!-- Selector Propio Hora Entrada del Bloque (Slider) -->
              <div class="relative" data-time-picker-scope>
                <button
                  type="button"
                  @click="toggleTimePicker('b-' + day.num + '-' + idx + '-hora_entrada', $event)"
                  class="h-7 px-2 rounded-lg border text-xs mono-code font-bold flex items-center gap-1 transition-all cursor-pointer"
                  :class="activeTimePickerKey === ('b-' + day.num + '-' + idx + '-hora_entrada')
                    ? 'bg-charcoal-900 text-white border-charcoal-900'
                    : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200'">
                  <i class="ph ph-clock text-xs" :class="activeTimePickerKey === ('b-' + day.num + '-' + idx + '-hora_entrada') ? 'text-white/80' : 'text-charcoal-400'"></i>
                  <span>{{ blk.hora_entrada }}</span>
                </button>

                <!-- Popover Slider Entrada -->
                <div
                  v-if="activeTimePickerKey === ('b-' + day.num + '-' + idx + '-hora_entrada')"
                  @click.stop
                  class="absolute left-0 w-72 bg-white rounded-2xl border border-charcoal-200 shadow-2xl p-3.5 z-50 space-y-3"
                  :class="day.num >= 5 ? 'bottom-full mb-1.5' : 'top-9'">
                  <div class="flex items-center justify-between pb-1.5 border-b border-charcoal-100">
                    <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">{{ day.short }} · Entrada B{{ idx + 1 }}</span>
                    <span class="mono-code text-sm font-black text-charcoal-900">{{ blk.hora_entrada }}</span>
                  </div>
                  <div class="space-y-1.5">
                    <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                      <span>Hora ({{ String(getHourForKey('b-' + day.num + '-' + idx + '-hora_entrada')).padStart(2, '0') }} h)</span>
                      <span class="mono-code">00h – 23h</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="23"
                      step="1"
                      :value="getHourForKey('b-' + day.num + '-' + idx + '-hora_entrada')"
                      @input="onHourSliderInput('b-' + day.num + '-' + idx + '-hora_entrada', $event.target.value)"
                      :style="sliderTrackStyle(getHourForKey('b-' + day.num + '-' + idx + '-hora_entrada'), 0, 23)"
                      class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
                  </div>
                  <div class="space-y-1.5">
                    <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                      <span>Minutos (:{{ String(getMinutePartForKey('b-' + day.num + '-' + idx + '-hora_entrada')).padStart(2, '0') }})</span>
                      <span class="mono-code">:00 – :55</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="55"
                      step="5"
                      :value="getMinutePartForKey('b-' + day.num + '-' + idx + '-hora_entrada')"
                      @input="onMinuteSliderInput('b-' + day.num + '-' + idx + '-hora_entrada', $event.target.value)"
                      :style="sliderTrackStyle(getMinutePartForKey('b-' + day.num + '-' + idx + '-hora_entrada'), 0, 55)"
                      class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
                  </div>
                </div>
              </div>

              <span class="text-charcoal-400 font-bold text-xs">→</span>

              <!-- Selector Propio Hora Salida del Bloque (Slider) -->
              <div class="relative" data-time-picker-scope>
                <button
                  type="button"
                  @click="toggleTimePicker('b-' + day.num + '-' + idx + '-hora_salida', $event)"
                  class="h-7 px-2 rounded-lg border text-xs mono-code font-bold flex items-center gap-1 transition-all cursor-pointer"
                  :class="activeTimePickerKey === ('b-' + day.num + '-' + idx + '-hora_salida')
                    ? 'bg-charcoal-900 text-white border-charcoal-900'
                    : 'bg-white hover:bg-charcoal-50 text-charcoal-900 border-charcoal-200'">
                  <i class="ph ph-clock text-xs" :class="activeTimePickerKey === ('b-' + day.num + '-' + idx + '-hora_salida') ? 'text-white/80' : 'text-charcoal-400'"></i>
                  <span>{{ blk.hora_salida }}</span>
                </button>

                <!-- Popover Slider Salida -->
                <div
                  v-if="activeTimePickerKey === ('b-' + day.num + '-' + idx + '-hora_salida')"
                  @click.stop
                  class="absolute left-0 sm:left-auto sm:right-0 w-72 bg-white rounded-2xl border border-charcoal-200 shadow-2xl p-3.5 z-50 space-y-3"
                  :class="day.num >= 5 ? 'bottom-full mb-1.5' : 'top-9'">
                  <div class="flex items-center justify-between pb-1.5 border-b border-charcoal-100">
                    <span class="text-[10px] font-bold uppercase tracking-wider text-charcoal-400">{{ day.short }} · Salida B{{ idx + 1 }}</span>
                    <span class="mono-code text-sm font-black text-charcoal-900">{{ blk.hora_salida }}</span>
                  </div>
                  <div class="space-y-1.5">
                    <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                      <span>Hora ({{ String(getHourForKey('b-' + day.num + '-' + idx + '-hora_salida')).padStart(2, '0') }} h)</span>
                      <span class="mono-code">00h – 23h</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="23"
                      step="1"
                      :value="getHourForKey('b-' + day.num + '-' + idx + '-hora_salida')"
                      @input="onHourSliderInput('b-' + day.num + '-' + idx + '-hora_salida', $event.target.value)"
                      :style="sliderTrackStyle(getHourForKey('b-' + day.num + '-' + idx + '-hora_salida'), 0, 23)"
                      class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
                  </div>
                  <div class="space-y-1.5">
                    <div class="flex items-center justify-between text-[10px] font-bold text-charcoal-500">
                      <span>Minutos (:{{ String(getMinutePartForKey('b-' + day.num + '-' + idx + '-hora_salida')).padStart(2, '0') }})</span>
                      <span class="mono-code">:00 – :55</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="55"
                      step="5"
                      :value="getMinutePartForKey('b-' + day.num + '-' + idx + '-hora_salida')"
                      @input="onMinuteSliderInput('b-' + day.num + '-' + idx + '-hora_salida', $event.target.value)"
                      :style="sliderTrackStyle(getMinutePartForKey('b-' + day.num + '-' + idx + '-hora_salida'), 0, 55)"
                      class="w-full h-2 rounded-full appearance-none cursor-pointer accent-[#18181B]" />
                  </div>
                </div>
              </div>

              <span class="px-1.5 py-0.5 rounded-md bg-white border border-charcoal-200/80 text-[10px] mono-code font-bold text-charcoal-700">
                {{ blockDurationLabel(blk) }}
              </span>

              <button
                type="button"
                @click="removeBlock(day.num, idx)"
                title="Quitar bloque"
                class="w-6 h-6 rounded-lg text-charcoal-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center cursor-pointer transition-colors">
                <i class="ph ph-trash text-xs"></i>
              </button>
            </div>

            <button
              v-if="blocksByDay[day.num].length > 0"
              type="button"
              @click="addBlock(day.num)"
              class="h-7 px-2.5 rounded-lg bg-charcoal-100 hover:bg-charcoal-200 text-charcoal-800 text-[11px] font-bold flex items-center gap-1 cursor-pointer transition-colors ml-auto">
              <i class="ph ph-plus text-[10px]"></i>
              <span>+ Bloque</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Alertas de validación -->
      <div v-if="validationErrors.length" class="px-3.5 py-2 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 space-y-0.5">
        <div v-for="(err, idx) in validationErrors" :key="idx" class="flex items-start gap-1.5 text-[11px] font-semibold">
          <i class="ph ph-warning-circle text-sm text-rose-600 shrink-0 mt-0.5"></i>
          <span>{{ err }}</span>
        </div>
      </div>

      <!-- Barra resumen inferior compacta -->
      <div class="px-3.5 py-2 rounded-2xl bg-charcoal-50 border border-charcoal-200/80 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div class="flex items-center gap-2 text-charcoal-700 font-semibold">
          <span class="w-5 flex items-center justify-center shrink-0"><i class="ph ph-clock-user text-base text-charcoal-400"></i></span>
          <span>{{ summaryStats.activeDays }} {{ summaryStats.activeDays === 1 ? 'día laboral activo' : 'días laborales activos' }}</span>
          <span class="text-charcoal-300">•</span>
          <span class="mono-code font-bold text-charcoal-900">{{ summaryStats.hours }}h / semana</span>
        </div>
        <span
          class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mono-code"
          :class="summaryStats.isMixed ? 'bg-[#18181B] text-white' : 'bg-white border border-charcoal-200 text-charcoal-700'">
          {{ summaryStats.isMixed ? 'Horario Mixto / Parcial' : 'Horario Fijo' }}
        </span>
      </div>
    </div>
  `
};
