<template>
  <!-- 地区分流:紧凑列表(拖动排序 / 编辑 / 删除),细节在编辑弹窗里。每次操作整份保存,不用重启内核 -->
  <div class="app-card-inset flex flex-col gap-3">
    <div class="flex items-center gap-2">
      <span class="text-base font-semibold">{{ $t('clientAppRegionsTitle') }}</span>
      <div class="ml-auto flex items-center gap-1">
        <button
          type="button"
          class="btn btn-ghost btn-square btn-sm"
          :disabled="saving"
          v-tip="$t('clientAppResetDefault')"
          @click="reset"
        >
          <ArrowUturnLeftIcon class="h-4 w-4" />
        </button>
        <button
          type="button"
          class="btn btn-primary btn-circle btn-sm"
          :disabled="saving || list.length >= SHARE_REGION_LIMITS.groups"
          v-tip="$t('clientAppAddGroup')"
          @click="openEdit(null)"
        >
          <PlusIcon class="h-4 w-4" />
        </button>
      </div>
    </div>
    <p class="text-base-content/60 text-xs">{{ $t('clientAppRegionsHint') }}</p>

    <Draggable
      v-model="list"
      :animation="150"
      :force-fallback="true"
      :fallback-on-body="true"
      handle=".drag-handle"
      ghost-class="opacity-40"
      item-key="id"
      class="divide-base-content/10 divide-y"
      @end="persist([...list])"
    >
      <template #item="{ element }">
        <div class="flex items-center gap-2 py-2">
          <Bars3Icon class="drag-handle text-base-content/40 h-4 w-4 shrink-0 cursor-move" />
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="truncate text-sm">{{ groupName(element) }}</span>
              <span
                v-if="element.default"
                class="badge badge-sm"
              >
                {{ $t('clientAppDefaultBadge') }}
              </span>
            </div>
            <span
              v-if="element.description"
              class="text-base-content/60 truncate text-xs"
            >
              {{ element.description }}
            </span>
            <div class="text-base-content/60 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              <span
                v-if="summary(element)"
                class="flex min-w-0 items-center gap-1"
              >
                <CountryFlag
                  v-for="c in element.regions.slice(0, 4)"
                  :key="c"
                  :code="c"
                  :size="14"
                  :title="regionName(c)"
                />
                <span class="truncate">{{ summary(element) }}</span>
              </span>
              <span>{{ $t('clientAppRegionRuleCount', { count: element.rules.length }) }}</span>
              <span>{{ $t('clientAppRegionRest', { action: actionText(element.catchAll) }) }}</span>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm"
            v-tip="$t('edit')"
            @click="openEdit(element)"
          >
            <PencilSquareIcon class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-square btn-sm hover:text-error"
            v-tip="$t('delete')"
            @click="remove(element)"
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </div>
      </template>
    </Draggable>

    <ShareRegionEditDialog
      v-model="dialogOpen"
      :group="editing"
      :groups="list"
      :defaults="info.defaultShareRegions"
      :lan-subnets="info.lanSubnets"
      :saving="saving"
      @saved="onDialogSaved"
    />
  </div>
</template>

<script setup lang="ts">
import {
  saveShareRegions,
  SHARE_REGION_LIMITS,
  type OpenboxClientAppInfo,
  type OpenboxShareRegionGroup,
} from '@/api/clientApp'
import CountryFlag from '@/components/common/CountryFlag.vue'
import ShareRegionEditDialog from '@/components/clientapp/ShareRegionEditDialog.vue'
import { countryName, findCountry } from '@/constant/countries'
import { showNotification } from '@/helper/notification'
import {
  ArrowUturnLeftIcon,
  Bars3Icon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Draggable from 'vuedraggable'

const props = defineProps<{ info: OpenboxClientAppInfo }>()
const emit = defineEmits<{ saved: [] }>()

const { t, locale } = useI18n()

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const list = ref<OpenboxShareRegionGroup[]>([])
const saving = ref(false)
const dialogOpen = ref(false)
const editing = ref<OpenboxShareRegionGroup | null>(null)

watch(
  () => props.info,
  (info) => {
    list.value = clone(info.shareRegions)
  },
  { immediate: true },
)

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const groupName = (g: OpenboxShareRegionGroup) => g.name || g.id

const regionName = (code: string) => {
  const c = findCountry(code)
  return c ? countryName(c, locale.value) : code
}

const summary = (g: OpenboxShareRegionGroup) => {
  if (!g.regions.length) return g.default ? t('clientAppRegionOther') : ''
  const names = g.regions.map(regionName).join('、')
  return g.regionMatch === 'outside' ? t('clientAppRegionOutside', { regions: names }) : names
}

const actionText = (action: string) =>
  t(action === 'proxy' ? 'clientAppActionProxyShort' : 'clientAppActionDirect')

// ---- 校验(和后端 engine/share-regions.mjs 同一套规则,后端才是权威)----

type Problem = { content: string; params?: Record<string, string> }

const validate = (groups: OpenboxShareRegionGroup[]): Problem | null => {
  if (groups.length > SHARE_REGION_LIMITS.groups) {
    return { content: 'clientAppErrTooMany', params: { n: String(SHARE_REGION_LIMITS.groups) } }
  }
  if (groups.filter((g) => g.default).length !== 1) return { content: 'clientAppErrDefault' }
  const claimed = new Map<string, string>()
  for (const g of groups) {
    if (!g.name) return { content: 'clientAppErrName', params: { id: g.id } }
    const bad = g.regions.find((r) => !/^[A-Z]{2}$/.test(r))
    if (bad) return { content: 'clientAppErrRegionCode', params: { value: bad } }
    if (g.regionMatch === 'outside') {
      if (!g.regions.length) return { content: 'clientAppErrOutside', params: { id: g.id } }
      continue
    }
    for (const r of g.regions) {
      const other = claimed.get(r)
      if (other) return { content: 'clientAppErrRegionDup', params: { region: r, a: other, b: g.id } }
      claimed.set(r, g.id)
    }
  }
  return null
}

// ---- 保存 ----

const persist = async (groups: OpenboxShareRegionGroup[]): Promise<boolean> => {
  saving.value = true
  try {
    await saveShareRegions(groups)
    showNotification({ content: 'clientAppSaved', type: 'alert-success' })
    emit('saved')
    return true
  } catch (error) {
    // 后端校验不过时回的是英文原因,原样给出来;列表退回服务器上的样子
    list.value = clone(props.info.shareRegions)
    showNotification({
      content: 'saveFailed',
      params: { message: errorMessage(error) },
      type: 'alert-error',
    })
    return false
  } finally {
    saving.value = false
  }
}

const openEdit = (g: OpenboxShareRegionGroup | null) => {
  editing.value = g ? clone(g) : null
  dialogOpen.value = true
}

const onDialogSaved = async (group: OpenboxShareRegionGroup) => {
  // 新组设成默认时,把别的组的默认标记摘掉
  const others = list.value.map((g) => {
    if (!group.default || !g.default || g.id === group.id) return g
    const copy = { ...g }
    delete copy.default
    return copy
  })
  const next = others.some((g) => g.id === group.id)
    ? others.map((g) => (g.id === group.id ? group : g))
    : [...others, group]
  const problem = validate(next)
  if (problem) {
    showNotification({ content: problem.content, params: problem.params, type: 'alert-error' })
    return
  }
  if (await persist(next)) dialogOpen.value = false
}

const remove = async (g: OpenboxShareRegionGroup) => {
  if (g.default) {
    showNotification({ content: 'clientAppDeleteDefault', type: 'alert-warning' })
    return
  }
  if (!window.confirm(t('clientAppDeleteConfirm', { name: groupName(g) }))) return
  await persist(list.value.filter((x) => x.id !== g.id))
}

const reset = async () => {
  if (!window.confirm(t('clientAppResetConfirm'))) return
  await persist([])
}
</script>
