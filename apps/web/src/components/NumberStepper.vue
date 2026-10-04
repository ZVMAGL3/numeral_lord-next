<script setup lang="ts">
import { computed, ref, watch } from "vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  modelValue: number | string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
  size?: "default" | "compact";
}>(), {
  step: 1,
  disabled: false,
  ariaLabel: "数值",
  size: "default"
});

const emit = defineEmits<{
  "update:modelValue": [value: number];
  change: [value: number];
}>();

const focused = ref(false);
const draft = ref(String(props.modelValue));
const currentValue = computed(() => {
  const value = Number(draft.value);
  return Number.isFinite(value) ? value : Number(props.modelValue) || 0;
});
const cannotDecrease = computed(() => props.min !== undefined && currentValue.value <= props.min);
const cannotIncrease = computed(() => props.max !== undefined && currentValue.value >= props.max);

watch(() => props.modelValue, (value) => {
  if (!focused.value) draft.value = String(value);
});

function clamp(value: number): number {
  let result = value;
  if (props.min !== undefined) result = Math.max(props.min, result);
  if (props.max !== undefined) result = Math.min(props.max, result);
  return Math.round(result * 1e8) / 1e8;
}

function onInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  draft.value = value;
  const parsed = value.trim() === "" ? props.min ?? 0 : Number(value);
  if (Number.isFinite(parsed)) emit("update:modelValue", parsed);
}

function commit(): void {
  const parsed = draft.value.trim() === "" ? props.min ?? 0 : Number(draft.value);
  const value = clamp(Number.isFinite(parsed) ? parsed : Number(props.modelValue) || 0);
  draft.value = String(value);
  emit("update:modelValue", value);
  emit("change", value);
}

function adjust(direction: -1 | 1): void {
  const base = Number.isFinite(currentValue.value) ? currentValue.value : props.min ?? 0;
  const value = clamp(base + props.step * direction);
  draft.value = String(value);
  emit("update:modelValue", value);
  emit("change", value);
}
</script>

<template>
  <div class="number-stepper" :class="{ compact: size === 'compact', disabled }" role="group" :aria-label="`${ariaLabel}调整`">
    <button type="button" class="step-button decrement" :aria-label="`减少${ariaLabel}`" :disabled="disabled || cannotDecrease" @pointerdown.prevent @click="adjust(-1)">−</button>
    <input
      v-bind="$attrs"
      :value="draft"
      type="number"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :aria-label="ariaLabel"
      @input="onInput"
      @change="commit"
      @focus="focused = true"
      @blur="focused = false"
      @keydown.enter.prevent="commit"
    />
    <button type="button" class="step-button increment" :aria-label="`增加${ariaLabel}`" :disabled="disabled || cannotIncrease" @pointerdown.prevent @click="adjust(1)">＋</button>
  </div>
</template>

<style scoped>
.number-stepper {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 40px;
  box-sizing: border-box;
  grid-template-columns: 32px minmax(0, 1fr) 32px;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid rgba(132, 170, 201, .34);
  border-radius: 11px;
  background: linear-gradient(145deg, rgba(20, 39, 58, .98), rgba(8, 19, 31, .98));
  box-shadow: inset 0 1px rgba(255, 255, 255, .045), 0 4px 12px rgba(0, 0, 0, .14);
  transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
}
.number-stepper:focus-within {
  border-color: rgba(94, 234, 212, .72);
  background: linear-gradient(145deg, rgba(22, 45, 62, .99), rgba(8, 22, 34, .99));
  box-shadow: inset 0 1px rgba(255, 255, 255, .06), 0 0 0 3px rgba(94, 234, 212, .09), 0 6px 16px rgba(0, 0, 0, .18);
}
.number-stepper .step-button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #a9c3d6;
  background: rgba(109, 146, 176, .1);
  font: 500 19px/1 system-ui, "Microsoft YaHei", sans-serif;
  cursor: pointer;
  transition: color .14s ease, border-color .14s ease, background .14s ease, transform .1s ease;
}
.number-stepper .step-button:hover:not(:disabled) {
  border-color: rgba(94, 234, 212, .3);
  color: #eafffc;
  background: linear-gradient(145deg, rgba(65, 152, 153, .34), rgba(42, 92, 126, .32));
}
.number-stepper .step-button:active:not(:disabled) { transform: scale(.94); }
.number-stepper .step-button:disabled { color: #526679; background: rgba(80, 100, 119, .07); cursor: not-allowed; }
.number-stepper input {
  width: 100%;
  min-width: 0;
  height: 32px;
  box-sizing: border-box;
  padding: 0 2px;
  border: 0;
  border-radius: 6px;
  outline: 0;
  color: #eff8ff;
  background: transparent;
  box-shadow: none;
  font: 700 13px/1 system-ui, "Microsoft YaHei", sans-serif;
  text-align: center;
  appearance: textfield;
}
.number-stepper input::-webkit-inner-spin-button,
.number-stepper input::-webkit-outer-spin-button { margin: 0; appearance: none; }
.number-stepper.compact { min-height: 36px; grid-template-columns: 28px minmax(0, 1fr) 28px; gap: 2px; padding: 2px; border-radius: 9px; }
.number-stepper.compact .step-button { width: 28px; height: 30px; border-radius: 6px; font-size: 17px; }
.number-stepper.compact input { height: 30px; font-size: 12px; }
.number-stepper.disabled { opacity: .68; }
@media (prefers-reduced-motion: reduce) {
  .number-stepper, .number-stepper .step-button { transition: none; }
}
</style>
