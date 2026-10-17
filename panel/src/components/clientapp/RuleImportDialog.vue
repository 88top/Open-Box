<template>
  <!-- 导入规则:输入规则集网址 → 预览解析出的域名 / IP 明细 → 追加到当前地区组 -->
  <DialogWrapper
    v-model="isOpen"
    :title="$t('routingPolicyRuleImportTitle')"
    box-class="w-full max-w-2xl"
  >
    <div class="flex flex-col gap-3">
      <p class="text-base-content/60 text-xs">{{ $t(hintKey, { max }) }}</p>
      <div class="flex items-center gap-2">
        <input
          v-model="url"
          type="url"
          class="input input-sm min-w-0 flex-1 font-mono text-xs"
          :placeholder="$t('routingPolicyRuleUrlPlaceholder')"
          @keydown.enter.prevent="preview"
        />
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="loading || !url.trim()"
          @click="preview"
        >
          <span
            v-if="loading"
            class="loading loading-spinner loading-xs"
          />
          {{ $t('routingPolicyRuleImportPreview') }}
        </button>
      </div>
      <p
        v-if="error"
        class="text-error text-xs"
      >
        {{ error }}
      </p>
      <template v-if="entries">
        <p
          v-if="entries.length > max"
          class="text-warning text-xs"
        >
          {{ $t('clientAppImportTooMany', { count: entries.length, max }) }}
        </p>
        <p
          v-else
          class="text-base-content/60 text-xs"
        >
          {{ $t('routingPolicyRuleImportCount', { count: entries.length }) }}
        </p>
        <div class="border-base-300/60 max-h-80 overflow-y-auto rounded-lg border">
          <p
            v-if="!entries.length"
            class="text-base-content/50 py-8 text-center text-xs"
          >
            {{ $t('geoEntriesEmpty') }}
          </p>
          <ul v-else>
            <li
              v-for="(entry, index) in entries"
              :key="`${entry.type}:${entry.value}:${index}`"
              class="border-base-300/40 flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
            >
              <span class="badge badge-ghost badge-xs shrink-0">{{ typeLabel(entry.type) }}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ entry.value }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <!-- 底栏:取消 / 导入固定在内容区下面,与 v0.1.334 一致 -->
    <template #footer>
      <button
        type="button"
        class="btn btn-sm"
        @click="isOpen = false"
      >
        {{ $t('cancel') }}
      </button>
      <button
        v-if="entries"
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="!entries.length || entries.length > max"
        @click="apply"
      >
        {{ $t('routingPolicyRuleImportApply') }}
      </button>
    </template>
  </DialogWrapper>
</template>

<script setup lang="ts">
import { importRuleList } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{ max?: number; hintKey?: string }>(), {
  max: 200,
  hintKey: 'routingPolicyRuleImportHint',
})
const emit = defineEmits<{ import: [entries: { type: string; value: string }[]] }>()
const isOpen = defineModel<boolean>({ required: true })

const { t } = useI18n()

// 只收这四种明细:域名 / 域名后缀 / 域名关键词 / IP 段
const LABELS: Record<string, string> = {
  domain: 'routingPolicyDomain',
  domain_suffix: 'routingPolicyDomainSuffix',
  domain_keyword: 'routingPolicyDomainKeyword',
  ip_cidr: 'routingPolicyIpCidr',
}
const typeLabel = (type: string) => (LABELS[type] ? t(LABELS[type]) : type)

const url = ref('')
const entries = ref<{ type: string; value: string }[] | null>(null)
const loading = ref(false)
const error = ref('')

// 每次打开都从头来
watch(isOpen, (open) => {
  if (!open) return
  url.value = ''
  entries.value = null
  error.value = ''
})

const preview = async () => {
  const target = url.value.trim()
  if (!target || loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await importRuleList(target)
    entries.value = (result.entries || []).filter((e) => LABELS[e.type] && e.value.trim())
  } catch (e) {
    entries.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

const apply = () => {
  if (!entries.value?.length || entries.value.length > props.max) return
  emit('import', entries.value)
  isOpen.value = false
}
</script>
