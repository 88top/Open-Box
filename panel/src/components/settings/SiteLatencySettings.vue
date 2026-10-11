<template>
  <!-- 测试站点:概览「站点延迟」按这里的站点测速。图标 / 名称 / 地址都能改,右上角恢复默认的四个。 -->
  <div class="settings-section flex flex-col gap-2 p-4 text-sm">
    <div class="settings-title">
      {{ $t('testSites') }}
      <QuestionMarkCircleIcon
        class="h-4 w-4 cursor-pointer"
        @mouseenter="showTip($event, $t('testSitesTip'))"
      />
      <button
        type="button"
        class="btn btn-ghost btn-circle btn-sm ml-auto"
        v-tip="$t('testSitesReset')"
        @click="resetTestSites"
      >
        <ArrowUturnLeftIcon class="h-4 w-4" />
      </button>
    </div>
    <div class="settings-grid">
      <div
        v-for="site in testSites"
        :key="site.id"
        class="setting-item"
      >
        <div class="w-16 shrink-0">
          <CountrySelect
            v-model="site.icon"
            icon-only
            brands
          />
        </div>
        <input
          class="input input-sm w-30 shrink-0"
          v-model="site.name"
          :placeholder="$t('testSitesNamePlaceholder')"
        />
        <TextInput
          class="min-w-0 flex-1"
          v-model="site.url"
          :placeholder="$t('testSitesUrlPlaceholder')"
          :clearable="true"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import CountrySelect from '@/components/common/CountrySelect.vue'
import TextInput from '@/components/common/TextInput.vue'
import { resetTestSites, testSites } from '@/composables/siteLatency'
import { useTooltip } from '@/helper/tooltip'
import { ArrowUturnLeftIcon, QuestionMarkCircleIcon } from '@heroicons/vue/24/outline'

const { showTip } = useTooltip()
</script>
