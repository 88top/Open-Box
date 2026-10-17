<template>
  <!-- 探到新版之后的确认弹窗:当前版本 → 最新版本 + 那一版的更新日志(Release 说明),
       确定才真正发起升级;升级进度由 OpenboxUpdateDialog 接着显示。 -->
  <DialogWrapper
    v-model="open"
    :title="$t('obUpdateConfirmTitle')"
    box-class="w-full max-w-2xl"
  >
    <div class="flex flex-col gap-3 text-sm">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="text-base-content/70">{{ $t('obUpdateCurrent') }}</span>
        <span class="font-mono">{{ current || '—' }}</span>
        <ArrowRightIcon class="text-base-content/50 h-4 w-4 shrink-0" />
        <span class="text-base-content/70">{{ $t('obUpdateLatest') }}</span>
        <span class="font-mono font-semibold">{{ latest }}</span>
      </div>
      <div class="flex flex-col gap-2">
        <div class="flex items-baseline gap-2">
          <span class="font-medium">{{ $t('obUpdateNotes') }}</span>
          <span
            v-if="dateText"
            class="text-base-content/50 text-xs"
          >{{ dateText }}</span>
        </div>
        <div
          v-if="loading"
          class="text-base-content/60 flex items-center gap-2 text-xs"
        >
          <span class="loading loading-spinner loading-xs" />
          {{ $t('obUpdateNotesLoading') }}
        </div>
        <div
          v-else-if="blocks.length"
          class="bg-base-200/60 flex flex-col gap-1 rounded-lg p-3"
        >
          <template
            v-for="(block, index) in blocks"
            :key="index"
          >
            <div
              v-if="block.kind === 'heading'"
              class="mt-1 text-xs font-semibold first:mt-0"
            >
              <NoteSegments :segments="block.text" />
            </div>
            <div
              v-else-if="block.kind === 'item'"
              class="flex gap-1.5 text-xs leading-relaxed"
              :style="{ marginLeft: `${block.level}em` }"
            >
              <span class="text-base-content/50">•</span>
              <span class="min-w-0"><NoteSegments :segments="block.text" /></span>
            </div>
            <p
              v-else
              class="text-xs leading-relaxed"
            >
              <NoteSegments :segments="block.text" />
            </p>
          </template>
        </div>
        <p
          v-else
          class="text-base-content/60 text-xs"
        >{{ $t('obUpdateNotesFailed') }}</p>
        <a
          :href="url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-base-content/70 hover:text-primary inline-flex w-fit items-center gap-1.5 rounded-md py-0.5 text-xs"
        >
          {{ $t('obUpdateNotesAll') }}
          <ArrowTopRightOnSquareIcon class="h-4 w-4" />
        </a>
      </div>
    </div>
    <template #footer>
      <button
        type="button"
        class="btn btn-sm"
        @click="open = false"
      >
        {{ $t('cancel') }}
      </button>
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="starting"
        @click="emit('confirm')"
      >
        <span
          v-if="starting"
          class="loading loading-spinner loading-xs"
        />
        {{ $t('obUpdateConfirm') }}
      </button>
    </template>
  </DialogWrapper>
</template>

<script setup lang="ts">
import type { OpenboxUpdateNote } from '@/api/openbox'
import DialogWrapper from '@/components/common/DialogWrapper.vue'
import { ArrowRightIcon, ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline'
import { computed, h, type FunctionalComponent } from 'vue'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{
  current: string
  latest: string
  loading: boolean
  note: OpenboxUpdateNote | null
  url: string
  starting: boolean
}>()
const emit = defineEmits<{ confirm: [] }>()

// ---- 更新日志(Markdown 子集)渲染:标题 / 列表 / 段落,行内只认 `代码`、**粗体**、[链接](https://…) ----
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; href: string }
type Block =
  | { kind: 'heading'; text: Segment[] }
  | { kind: 'item'; level: number; text: Segment[] }
  | { kind: 'para'; text: Segment[] }

const parseInline = (src: string): Segment[] => {
  const out: Segment[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] })
    else {
      // 只放行 http(s) 链接,别的协议(javascript: 等)原样当文字显示
      try {
        const u = new URL(m[4]!)
        if (u.protocol === 'https:' || u.protocol === 'http:') out.push({ kind: 'link', text: m[3]!, href: u.href })
        else out.push({ kind: 'text', text: m[0] })
      } catch {
        out.push({ kind: 'text', text: m[0] })
      }
    }
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) })
  return out
}

const parseNotes = (body: string): Block[] => {
  const blocks: Block[] = []
  let cur: { kind: 'item' | 'para'; level: number; raw: string } | null = null
  const flush = () => {
    if (!cur) return
    const text = parseInline(cur.raw.trim())
    blocks.push(cur.kind === 'item' ? { kind: 'item', level: cur.level, text } : { kind: 'para', text })
    cur = null
  }
  const src = String(body || '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  for (const line of src.replace(/\r/g, '').split('\n')) {
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', text: parseInline(heading[1]!.trim()) })
      continue
    }
    const item = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const indent = item[1]!.replace(/\t/g, '  ').length
      cur = { kind: 'item', level: Math.min(3, Math.floor(indent / 2)), raw: item[2]! }
      continue
    }
    // 续行并进上一段 / 上一条
    if (cur) cur.raw += ` ${line.trim()}`
    else cur = { kind: 'para', level: 0, raw: line.trim() }
  }
  flush()
  return blocks
}

const NoteSegments: FunctionalComponent<{ segments: Segment[] }> = (p) =>
  p.segments.map((s) =>
    s.kind === 'code'
      ? h('code', { class: 'bg-base-300/60 rounded px-1 font-mono' }, s.text)
      : s.kind === 'bold'
        ? h('strong', s.text)
        : s.kind === 'link'
          ? h(
              'a',
              {
                href: s.href,
                target: '_blank',
                rel: 'noopener noreferrer',
                class: 'text-primary rounded-md underline underline-offset-2',
              },
              s.text,
            )
          : s.text,
  )
NoteSegments.props = ['segments']

const blocks = computed(() => (props.note ? parseNotes(props.note.body) : []))
const dateText = computed(() => (props.note && /^\d{4}-\d{2}-\d{2}/.test(props.note.date) ? props.note.date.slice(0, 10) : ''))
</script>
