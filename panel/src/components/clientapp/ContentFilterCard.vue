<template>
  <!-- 内容过滤:在路由器上管理规则集和脚本快照,同步到 iOS 后在手机执行 -->
  <div
    class="content-filter card bg-base-100 border-base-300/60 border"
    :aria-busy="busy || loading"
  >
    <div class="card-body gap-3 p-4 text-sm">
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-base font-semibold">{{ $t('cfTitle') }}</h2>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            :disabled="busy || loading"
            :aria-label="$t('cfRestore')"
            v-tip="$t('cfRestore')"
            @click="restoreOpen = true"
          >
            <ArrowUturnLeftIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm btn-square"
            :disabled="busy || loading"
            :aria-label="$t('cfAdd')"
            v-tip="$t('cfAdd')"
            @click="openEditor()"
          >
            <PlusIcon class="h-4 w-4" />
          </button>
        </div>
      </div>
      <p class="text-base-content/60 text-xs leading-relaxed">{{ $t('cfDescription') }}</p>

      <p
        v-if="loading"
        class="text-base-content/60 text-xs"
      >
        {{ $t('loading') }}
      </p>
      <div
        v-else-if="list.sets.length"
        class="divide-base-content/10 divide-y"
      >
        <div
          v-for="set in list.sets"
          :key="set.id"
          class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 py-3 sm:flex"
        >
          <ShieldCheckIcon class="text-base-content/50 h-4 w-4 shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="break-words"
                :class="!set.enabled && 'text-base-content/60'"
              >
                {{ set.name }}
              </span>
              <span class="text-base-content/50 text-xs">{{ dialectLabel(set.dialect) }}</span>
            </div>
            <p class="text-base-content/50 text-xs">
              {{ $t('cfCounts', { rules: set.ruleCount, scripts: set.scriptCount }) }} ·
              <time :datetime="set.updatedAt">{{ formatTime(set.updatedAt) }}</time>
            </p>
            <p
              v-if="set.skipped"
              class="text-warning text-xs"
            >
              {{ $t('cfSkipped', { n: set.skipped }) }}
            </p>
          </div>
          <div class="col-start-2 flex shrink-0 items-center gap-1">
            <button
              type="button"
              role="switch"
              :aria-checked="set.enabled"
              class="btn btn-ghost btn-xs btn-square"
              :class="set.enabled ? 'text-success' : 'text-base-content/40'"
              :disabled="busy || loading"
              :aria-label="`${set.name}: ${$t('cfToggle')}`"
              v-tip="$t('cfToggle')"
              @click="toggle(set)"
            >
              <PowerIcon class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square"
              :disabled="busy || loading || !set.sourceUrl"
              :aria-label="$t('cfUpdate')"
              v-tip="$t('cfUpdate')"
              @click="refresh(set)"
            >
              <ArrowPathIcon class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square"
              :disabled="busy || loading"
              :aria-label="$t('cfEdit')"
              v-tip="$t('cfEdit')"
              @click="openEditor(set)"
            >
              <PencilSquareIcon class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square text-error"
              :disabled="busy || loading"
              :aria-label="$t('cfDelete')"
              v-tip="$t('cfDelete')"
              @click="pendingDelete = set"
            >
              <TrashIcon class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      <p
        v-else
        class="text-base-content/50 text-xs"
      >
        {{ $t('cfEmpty') }}
      </p>
      <p
        v-if="list.sets.length"
        class="text-base-content/50 text-xs"
      >
        {{ $t('cfSyncHint') }}
      </p>
    </div>

    <DialogWrapper
      v-model="restoreOpen"
      :title="$t('cfRestore')"
      box-class="content-filter-dialog"
    >
      <p class="text-sm">{{ $t('cfRestoreConfirm') }}</p>
      <template #footer>
        <button
          type="button"
          class="btn btn-ghost"
          :disabled="busy"
          @click="restoreOpen = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="busy || loading"
          @click="confirmRestore"
        >
          <span
            v-if="busy"
            class="loading loading-spinner loading-xs"
          />
          {{ $t('confirm') }}
        </button>
      </template>
    </DialogWrapper>

    <DialogWrapper
      v-model="editorOpen"
      :title="$t('cfTitle')"
      box-class="content-filter-dialog w-full max-w-lg"
    >
      <form
        id="content-filter-editor"
        :aria-busy="busy"
        class="flex flex-col gap-3 text-sm"
        @submit.prevent="save"
      >
        <label class="flex flex-col gap-1">
          <span>{{ $t('cfName') }}</span>
          <input
            v-model="form.name"
            class="input input-bordered w-full"
            maxlength="100"
            :disabled="busy"
            required
          />
        </label>
        <label class="flex flex-col gap-1">
          <span>{{ $t('cfFormat') }}</span>
          <select
            v-model="form.dialect"
            :disabled="busy"
            class="select select-bordered w-full"
          >
            <option
              v-for="d in dialects"
              :key="d.value"
              :value="d.value"
            >
              {{ d.label }}
            </option>
          </select>
        </label>
        <div class="flex flex-col gap-1">
          <label for="content-filter-url">{{ $t('cfUrl') }}</label>
          <div class="flex items-center gap-2">
            <input
              id="content-filter-url"
              v-model="form.sourceUrl"
              class="input input-bordered min-w-0 flex-1"
              :disabled="busy"
              type="url"
              placeholder="https://…"
            />
            <button
              type="button"
              class="btn btn-primary shrink-0"
              :disabled="busy || !form.sourceUrl.trim()"
              @click="fetchSource('parse')"
            >
              <span
                v-if="pending === 'parse'"
                class="loading loading-spinner loading-xs"
                aria-hidden="true"
              />
              {{ $t('cfParse') }}
            </button>
          </div>
        </div>
        <label class="flex flex-col gap-1">
          <span>{{ $t('cfFile') }}</span>
          <input
            class="file-input file-input-bordered file-input-sm w-full"
            :disabled="busy"
            type="file"
            accept=".txt,.conf,.module,.sgmodule,.stoverride"
            @change="onFile"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span>{{ $t('cfContent') }}</span>
          <textarea
            v-model="form.text"
            class="textarea textarea-bordered h-64 w-full font-mono text-xs"
            :placeholder="$t('cfPaste')"
            :disabled="busy"
          />
        </label>
        <p class="text-base-content/60 text-xs">{{ $t('cfSnapshotHint') }}</p>
      </form>
      <template #footer>
        <button
          type="button"
          class="btn btn-ghost"
          :disabled="busy"
          @click="editorOpen = false"
        >
          {{ $t('cancel') }}
        </button>
        <button
          type="button"
          class="btn btn-ghost"
          :disabled="busy || !form.sourceUrl.trim()"
          @click="fetchSource('update')"
        >
          <span
            v-if="pending === 'update'"
            class="loading loading-spinner loading-xs"
            aria-hidden="true"
          />
          {{ $t('cfUpdate') }}
        </button>
        <button
          type="submit"
          form="content-filter-editor"
          class="btn btn-primary"
          :disabled="!canSave"
        >
          <span
            v-if="saving"
            class="loading loading-spinner loading-xs"
            aria-hidden="true"
          />
          {{ $t('cfSave') }}
        </button>
      </template>
    </DialogWrapper>

    <DialogWrapper
      :model-value="!!pendingDelete"
      :title="$t('cfDelete')"
      box-class="content-filter-dialog"
      @update:model-value="(open: boolean) => !open && (pendingDelete = null)"
    >
      <p>{{ $t('cfDeleteConfirm', { name: pendingDelete?.name }) }}</p>
      <template #footer>
        <button
          class="btn btn-ghost"
          :disabled="busy || loading"
          @click="pendingDelete = null"
        >
          {{ $t('cancel') }}
        </button>
        <button
          class="btn btn-error"
          :disabled="busy || loading"
          @click="confirmDelete"
        >
          {{ $t('cfDelete') }}
        </button>
      </template>
    </DialogWrapper>
  </div>
</template>

<script setup lang="ts">
import {
  deleteContentFilter,
  fetchContentFilter,
  fetchContentFilterSource,
  previewContentFilter,
  restoreContentFilterDefaults,
  saveContentFilter,
  setContentFilterEnabled,
  type OpenboxContentFilterDialect,
  type OpenboxContentFilterList,
  type OpenboxContentFilterSet,
} from '@/api/clientApp'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { showNotification } from '@/helper/notification'
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  PencilSquareIcon,
  PlusIcon,
  PowerIcon,
  ShieldCheckIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { computed, onMounted, reactive, ref } from 'vue'

const FILE_MAX_BYTES = 512 * 1024

const dialects: { value: OpenboxContentFilterDialect; label: string }[] = [
  { value: 'surge', label: 'Surge' },
  { value: 'quantumultx', label: 'Quantumult X' },
  { value: 'loon', label: 'Loon' },
  { value: 'shadowrocket', label: 'Shadowrocket' },
  { value: 'stash', label: 'Stash' },
]

const list = ref<OpenboxContentFilterList>({ sets: [], sha256: '', size: 0 })
const loading = ref(true)
const busy = ref(false)
const editorOpen = ref(false)
const restoreOpen = ref(false)
const pendingDelete = ref<OpenboxContentFilterSet | null>(null)

const form = reactive({
  id: '',
  name: '',
  dialect: 'surge' as OpenboxContentFilterDialect,
  sourceUrl: '',
  text: '',
  arguments: {} as Record<string, unknown>,
})

// 打开弹窗时的表单快照:有改动且名称、内容(或链接)齐全才允许保存
const baseline = ref<string | null>(null)
const pending = ref<'parse' | 'update' | null>(null)
const saving = ref(false)

const formKey = () =>
  JSON.stringify([form.name.trim(), form.dialect, form.sourceUrl.trim(), form.text, form.arguments])

const canSave = computed(
  () =>
    !busy.value &&
    baseline.value !== null &&
    formKey() !== baseline.value &&
    !!form.name.trim() &&
    !!(form.text.trim() || form.sourceUrl.trim()),
)

const dialectLabel = (value: string) => dialects.find((d) => d.value === value)?.label ?? value

const formatTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

const notifyFailed = (error: unknown) =>
  showNotification({
    content: 'cfFailed',
    params: { message: error instanceof Error ? error.message : String(error) },
    type: 'alert-error',
  })

// 新增 / 启停 / 更新 / 删除都返回整份最新列表,统一在这里处理
const run = async (action: () => Promise<OpenboxContentFilterList>, doneKey = 'cfSaved') => {
  if (busy.value) return false
  busy.value = true
  try {
    list.value = await action()
    showNotification({ content: doneKey, type: 'alert-success' })
    return true
  } catch (error) {
    notifyFailed(error)
    return false
  } finally {
    busy.value = false
  }
}

const openEditor = async (set?: OpenboxContentFilterSet) => {
  if (busy.value || loading.value) return
  baseline.value = null
  Object.assign(form, {
    id: set?.id || '',
    name: set?.name || '',
    dialect: set?.dialect || 'surge',
    sourceUrl: set?.sourceUrl || '',
    text: '',
    arguments: { ...set?.arguments?.values },
  })
  editorOpen.value = true
  if (!set) {
    baseline.value = formKey()
    return
  }
  busy.value = true
  try {
    form.text = (await fetchContentFilterSource(set.id)).text
    baseline.value = formKey()
  } catch (error) {
    notifyFailed(error)
  } finally {
    busy.value = false
  }
}

const onFile = async (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > FILE_MAX_BYTES) {
    showNotification({ content: 'cfFileTooLarge', type: 'alert-error' })
    return
  }
  form.text = await file.text()
  if (!form.name) form.name = file.name
}

// 解析 / 更新:抓取规则链接并校验,把规则文本读进编辑框(还没保存,点「保存」才生效)
const fetchSource = async (kind: 'parse' | 'update') => {
  const sourceUrl = form.sourceUrl.trim()
  if (busy.value || !sourceUrl) return
  busy.value = true
  pending.value = kind
  try {
    const res = await previewContentFilter({
      dialect: form.dialect,
      sourceUrl,
      arguments: form.arguments,
    })
    if (editorOpen.value) {
      form.text = res.text
      showNotification({ content: 'cfLoaded', type: 'alert-success' })
    }
  } catch (error) {
    notifyFailed(error)
  } finally {
    pending.value = null
    busy.value = false
  }
}

const save = async () => {
  if (!canSave.value) return
  saving.value = true
  try {
    const ok = await run(() =>
      saveContentFilter({ ...form, id: form.id || undefined, text: form.text || undefined }),
    )
    if (ok) editorOpen.value = false
  } finally {
    saving.value = false
  }
}

const refresh = (set: OpenboxContentFilterSet) =>
  run(() =>
    saveContentFilter({
      id: set.id,
      name: set.name,
      dialect: set.dialect,
      sourceUrl: set.sourceUrl,
    }),
  )

const toggle = (set: OpenboxContentFilterSet) =>
  run(() => setContentFilterEnabled(set.id, !set.enabled))

const confirmDelete = async () => {
  const target = pendingDelete.value
  if (!target) return
  if (await run(() => deleteContentFilter(target.id))) pendingDelete.value = null
}

const confirmRestore = async () => {
  if (await run(restoreContentFilterDefaults, 'cfRestored')) restoreOpen.value = false
}

onMounted(async () => {
  try {
    list.value = await fetchContentFilter()
  } catch (error) {
    notifyFailed(error)
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.content-filter :deep(.btn:focus-visible) {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
/* 44px 触控尺寸只给手机 / 触屏;桌面保持 daisyUI 默认的 btn-xs / btn-sm 尺寸,卡片才不会被撑高 */
@media (max-width: 639px), (pointer: coarse) {
  .content-filter :deep(.btn-square) {
    width: 44px;
    min-width: 44px;
    height: 44px;
    min-height: 44px;
  }
}
</style>
