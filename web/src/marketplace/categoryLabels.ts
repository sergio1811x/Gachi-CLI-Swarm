// Localized labels for marketplace categories. Kept separate from the global
// i18n catalog so adding a new upstream category never breaks the page — an
// unknown key falls back to the raw kebab-case name, prettified.

import type { UiLanguage } from '../uiLanguage.js'

interface CategoryLabel {
  en: string
  zh: string
}

const CATEGORY_LABELS: Record<string, CategoryLabel> = {
  academic: { en: 'Academic', zh: '学术' },
  design: { en: 'Design', zh: '设计' },
  engineering: { en: 'Engineering', zh: '工程' },
  finance: { en: 'Finance', zh: '金融' },
  'game-development': { en: 'Game Development', zh: '游戏开发' },
  hr: { en: 'HR', zh: '人力资源' },
  integrations: { en: 'System Integrations', zh: '系统集成' },
  legal: { en: 'Legal', zh: '法务' },
  marketing: { en: 'Marketing', zh: '营销' },
  misc: { en: 'Misc', zh: '其他' },
  'paid-media': { en: 'Paid Ads', zh: '广告投放' },
  product: { en: 'Product', zh: '产品' },
  'project-management': { en: 'Project Management', zh: '项目管理' },
  sales: { en: 'Sales', zh: '销售' },
  'spatial-computing': { en: 'Spatial Computing', zh: '空间计算' },
  specialized: { en: 'Industry Verticals', zh: '行业角色' },
  'supply-chain': { en: 'Supply Chain', zh: '供应链' },
  support: { en: 'Support', zh: '客户支持' },
  testing: { en: 'Testing', zh: '测试' },
}

const prettifyRaw = (category: string) =>
  category.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())

export const localizeMarketplaceCategory = (category: string, language: UiLanguage): string => {
  const entry = CATEGORY_LABELS[category]
  if (!entry) return prettifyRaw(category)
  return language === 'zh' ? entry.zh : entry.en
}

// Upstream emits categories alphabetically by the EN kebab key, which renders
// as a random-looking order to ZH readers (学术 → 设计 → 工程 → 金融 …). For
// ZH, sort by domain affinity so engineering-flavored categories cluster at
// the top, marketing/sales/finance in the middle, and academic / long-tail at
// the bottom. EN stays alphabetical (it reads fine).
const ZH_CATEGORY_ORDER: readonly string[] = [
  'engineering',
  'testing',
  'product',
  'design',
  'project-management',
  'integrations',
  'specialized',
  'marketing',
  'paid-media',
  'sales',
  'finance',
  'legal',
  'hr',
  'supply-chain',
  'support',
  'academic',
  'game-development',
  'spatial-computing',
  'misc',
]

export const sortCategoriesForDisplay = (
  categories: readonly string[],
  language: UiLanguage
): readonly string[] => {
  if (language !== 'zh') return categories
  const orderIndex = new Map(ZH_CATEGORY_ORDER.map((key, index) => [key, index]))
  return [...categories].sort((a, b) => {
    const ai = orderIndex.get(a) ?? Number.POSITIVE_INFINITY
    const bi = orderIndex.get(b) ?? Number.POSITIVE_INFINITY
    if (ai !== bi) return ai - bi
    return a.localeCompare(b)
  })
}
