<script setup lang="ts">
import { ref, watch } from "vue";
import BaseModal from "./BaseModal.vue";
import { useDialog } from "../../composables/useDialog";

const { current, resolve, cancel } = useDialog();

// prompt 表单的本地值
const values = ref<Record<string, string>>({});
const touched = ref(false);

watch(
  current,
  (c) => {
    touched.value = false;
    values.value = {};
    if (c?.kind === "prompt") {
      for (const f of c.spec.fields) values.value[f.key] = f.value ?? "";
    }
  },
  { immediate: true }
);

function missingRequired(): boolean {
  if (current.value?.kind !== "prompt") return false;
  return current.value.spec.fields.some((f) => f.required && !String(values.value[f.key] ?? "").trim());
}

function submit() {
  const c = current.value;
  if (!c) return;
  if (c.kind === "confirm") return resolve(true);
  touched.value = true;
  if (missingRequired()) return;
  resolve({ ...values.value });
}
</script>

<template>
  <BaseModal
    v-if="current"
    :title="current.spec.title"
    :width="current.kind === 'confirm' ? '420px' : '480px'"
    @close="cancel"
  >
    <!-- 确认 -->
    <p v-if="current.kind === 'confirm'" class="msg">
      {{ current.spec.message }}
    </p>

    <!-- 输入 -->
    <div v-else class="form" @keydown.enter.prevent="submit">
      <p v-if="current.spec.message" class="msg">{{ current.spec.message }}</p>
      <div v-for="f in current.spec.fields" :key="f.key" class="field">
        <label class="field-label" :for="'dlg-' + f.key">
          {{ f.label }}<span v-if="f.required" class="req">*</span>
        </label>
        <input
          :id="'dlg-' + f.key"
          v-model="values[f.key]"
          class="input"
          :type="f.type || 'text'"
          :placeholder="f.placeholder"
          :aria-invalid="touched && f.required && !String(values[f.key] ?? '').trim() ? 'true' : undefined"
        />
        <small v-if="f.help" class="field-help">{{ f.help }}</small>
        <small v-if="touched && f.required && !String(values[f.key] ?? '').trim()" class="err">
          此项为必填
        </small>
      </div>
    </div>

    <template #footer>
      <button class="btn btn-ghost" @click="cancel">
        {{ current.spec.cancelText || "取消" }}
      </button>
      <button
        class="btn"
        :class="current.kind === 'confirm' && current.spec.danger ? 'btn-danger-solid' : 'btn-primary'"
        @click="submit"
      >
        {{ current.spec.confirmText || "确定" }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.msg { margin: 0; color: var(--text-soft); line-height: 1.65; word-break: break-word; }
.form { display: flex; flex-direction: column; gap: 14px; }
.err { color: var(--danger); font-size: 11.5px; }
.btn-danger-solid { background: var(--danger); color: #fff; }
.btn-danger-solid:hover { filter: brightness(1.06); }
</style>
