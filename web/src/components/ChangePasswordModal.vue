<script setup lang="ts">
import { computed, ref } from "vue";
import BaseModal from "./ui/BaseModal.vue";
import { api } from "../api";
import { useToast } from "../composables/useToast";

const emit = defineEmits<{ (e: "close"): void }>();
const toast = useToast();

const oldPwd = ref("");
const newPwd = ref("");
const confirmPwd = ref("");
const touched = ref(false);
const saving = ref(false);

const errors = computed(() => {
  const e: Record<string, string> = {};
  if (!oldPwd.value) e.old = "请输入当前密码";
  if (newPwd.value.length < 6) e.next = "新密码至少 6 位";
  else if (newPwd.value === oldPwd.value) e.next = "新密码不能与当前密码相同";
  if (confirmPwd.value !== newPwd.value) e.confirm = "两次输入的新密码不一致";
  return e;
});

// 一个粗略的强度提示，比什么都不给强
const strength = computed(() => {
  const p = newPwd.value;
  if (!p) return { level: 0, text: "" };
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^\w\s]/.test(p)) s++;
  const level = Math.min(3, Math.ceil(s / 2));
  return { level, text: ["", "偏弱", "一般", "较强"][level] };
});

async function submit() {
  touched.value = true;
  if (Object.keys(errors.value).length) return;
  saving.value = true;
  try {
    await api.changePassword(oldPwd.value, newPwd.value);
    toast.success("密码已修改", "下次登录请使用新密码");
    emit("close");
  } catch (e) {
    toast.fromError(e, "修改失败");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <BaseModal title="修改密码" width="420px" @close="emit('close')">
    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label class="field-label" for="cp-old">当前密码</label>
        <input id="cp-old" v-model="oldPwd" class="input" type="password" autocomplete="current-password" />
        <small v-if="touched && errors.old" class="err">{{ errors.old }}</small>
      </div>
      <div class="field">
        <label class="field-label" for="cp-new">新密码</label>
        <input id="cp-new" v-model="newPwd" class="input" type="password" autocomplete="new-password" />
        <div v-if="newPwd" class="meter" :data-level="strength.level">
          <i /><i /><i />
          <span>{{ strength.text }}</span>
        </div>
        <small v-if="touched && errors.next" class="err">{{ errors.next }}</small>
      </div>
      <div class="field">
        <label class="field-label" for="cp-confirm">确认新密码</label>
        <input id="cp-confirm" v-model="confirmPwd" class="input" type="password" autocomplete="new-password" />
        <small v-if="touched && errors.confirm" class="err">{{ errors.confirm }}</small>
      </div>
      <button type="submit" hidden />
    </form>

    <template #footer>
      <button class="btn btn-ghost" :disabled="saving" @click="emit('close')">取消</button>
      <button class="btn btn-primary" :disabled="saving" @click="submit">
        {{ saving ? "保存中…" : "保存新密码" }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 15px; }
.err { color: var(--danger); font-size: 11.5px; }

.meter { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
.meter i { height: 3px; width: 26px; border-radius: 99px; background: var(--surface-3); }
.meter span { margin-left: 4px; font-size: 11px; color: var(--text-faint); }
.meter[data-level="1"] i:nth-child(1) { background: var(--danger); }
.meter[data-level="2"] i:nth-child(-n + 2) { background: var(--warn); }
.meter[data-level="3"] i { background: var(--success); }
</style>
