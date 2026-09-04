import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'

import type { TeamListItem, WorkerRole } from '../../../src/shared/types.js'
import {
  type CommandPreset,
  createRoleTemplate,
  deleteRoleTemplate,
  listCommandPresets,
  listRoleTemplates,
  type RoleTemplate,
} from '../api.js'
import { useI18n } from '../i18n.js'
import type { UiLanguage } from '../uiLanguage.js'
import { generateWorkerName } from './randomWorkerName.js'
import type { WorkerActions } from './useWorkerActions.js'

interface UseWorkerComposerInput {
  createWorker: WorkerActions['createWorker']
  open: boolean
  workers: TeamListItem[]
}

export interface WorkerComposerState {
  commandPresets: CommandPreset[]
  commandPresetId: string
  createWorkerError: string | null
  creating: boolean
  customTemplates: RoleTemplate[]
  roleDescription: string
  roleDescriptionDefault: string
  selectedTemplateId: string | null
  startupCommand: string
  templateBusy: boolean
  templateError: string | null
  workerName: string
  workerRole: WorkerRole
  setCommandPresetId: (value: string) => void
  setRoleDescription: (value: string) => void
  setStartupCommand: (value: string) => void
  setWorkerName: (value: string) => void
  setWorkerRole: (value: WorkerRole) => void
  selectTemplate: (templateId: string | null) => void
  saveAsTemplate: (name: string) => Promise<void>
  deleteTemplate: (templateId: string) => Promise<void>
  randomizeWorkerName: () => void
  resetRoleDescription: () => void
  resetError: () => void
  applyMarketplaceImport: (input: { name: string; description: string }) => void
  submit: (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => void
}

const fallbackRoleDescriptions: Record<UiLanguage, Record<WorkerRole, string>> = {
  en: {
    coder: [
      'You are a Coder. Turn clearly scoped tasks into the smallest correct code change.',
      'Working style:',
      '- Read the relevant files and local patterns before editing.',
      '- Prefer small changes; avoid unrelated refactors and scope creep.',
      '- Run validation that covers the risk. If you cannot validate, explain why.',
      'Report changed files, verification, remaining risk, and blockers.',
    ].join('\n'),
    custom: [
      "You are a custom team member. Rewrite this into the member's operating contract.",
      'Recommended shape:',
      '- Goal: what this member owns.',
      '- Boundaries: what to do and what to avoid.',
      '- Working style: how to inspect, edit, verify, or review.',
      '- Done means: what results, risks, and blockers to report.',
    ].join('\n'),
    reviewer: [
      'You are a Reviewer. Focus on quality review; do not replace the Orchestrator or edit by default.',
      'Working style:',
      '- Prioritize real bugs, regressions, edge cases, and test gaps.',
      '- For each issue, include severity, file/line, trigger condition, and minimal fix.',
      '- If no high-risk issue exists, state residual risk and unverified scope.',
      'Report blocking issues first, ordered by severity.',
    ].join('\n'),
    tester: [
      'You are a Tester. Reproduce, test, and produce concrete verification evidence.',
      'Working style:',
      '- Clarify the behavior, entry point, and failure condition under test.',
      '- Prefer real commands or real paths. Add a minimal test when useful.',
      '- Record commands, results, key output, and uncovered scenarios.',
      'Report pass/fail/unverified separately, then suggest the next step.',
    ].join('\n'),
  },
  ru: {
    coder: [
      'Ты Coder. Превращай чётко поставленные задачи в минимальные корректные изменения кода.',
      'Стиль работы:',
      '- Перед правкой изучи релевантные файлы и существующие паттерны.',
      '- Предпочитай небольшие изменения; избегай попутных рефакторингов и расползания объёма.',
      '- Запускай проверку, покрывающую риск. Если проверить нельзя — объясни почему.',
      'В отчёте: изменённые файлы, проверка, оставшийся риск, блокеры.',
    ].join('\n'),
    custom: [
      'Ты кастомный участник команды. Перепиши это в операционный контракт участника.',
      'Рекомендуемая структура:',
      '- Цель: за что отвечает этот участник.',
      '- Границы: что делать и чего избегать.',
      '- Стиль работы: как исследовать, редактировать, проверять или ревьюить.',
      '- Критерий готовности: какие результаты, риски и блокеры сообщать.',
    ].join('\n'),
    reviewer: [
      'Ты Reviewer. Фокус на ревью качества; не подменяй Оркестратора и не редактируй код по умолчанию.',
      'Стиль работы:',
      '- В приоритете реальные баги, регрессии, граничные случаи и пробелы в тестах.',
      '- Для каждой проблемы указывай серьёзность, файл/строку, условие срабатывания и минимальное исправление.',
      '- Если критичных проблем нет — укажи остаточный риск и непроверенную область.',
      'В отчёте сначала блокирующие проблемы, по убыванию серьёзности.',
    ].join('\n'),
    tester: [
      'Ты Tester. Воспроизводи, тестируй и предоставляй конкретные доказательства проверки.',
      'Стиль работы:',
      '- Уточни проверяемое поведение, точку входа и условие сбоя.',
      '- Предпочитай реальные команды и реальные пути. При необходимости добавь минимальный тест.',
      '- Фиксируй команды, результаты, ключевой вывод и непокрытые сценарии.',
      'В отчёте раздели pass/fail/не проверено, затем предложи следующий шаг.',
    ].join('\n'),
  },
  zh: {
    coder: [
      '你是实现型 Coder，负责把明确任务落成最小正确代码改动。',
      '工作方式：',
      '- 先阅读相关文件和现有模式，再动手。',
      '- 优先小步修改，避免无关重构和范围扩张。',
      '- 改动后运行能覆盖风险的验证命令；不能验证时说明原因。',
      '交付说明要包含：改动文件、验证结果、剩余风险或阻塞。',
    ].join('\n'),
    custom: [
      '你是自定义成员。请把这段改成该成员的行为契约。',
      '建议包含：',
      '- 目标：这个成员主要负责什么。',
      '- 边界：哪些事可以做，哪些事不要做。',
      '- 工作方式：如何调查、修改、验证或审查。',
      '- 完成标准：交付时需要说明哪些结果、风险和阻塞。',
    ].join('\n'),
    reviewer: [
      '你是监工型 Reviewer，负责质量审查，不替代 Orchestrator，也不默认改代码。',
      '工作方式：',
      '- 优先找真实 bug、回归风险、边界条件和测试缺口。',
      '- 发现问题时给出严重度、文件/行号、触发条件和最小修复建议。',
      '- 没有高风险问题时明确说清剩余风险和未验证范围。',
      '交付说明按严重度排序，先列 blocking 问题。',
    ].join('\n'),
    tester: [
      '你是验证型 Tester，负责复现、测试和证据化验证。',
      '工作方式：',
      '- 先明确要验证的行为、入口和失败条件。',
      '- 优先跑真实命令或真实链路；必要时补充最小测试。',
      '- 记录命令、结果、关键输出和不能覆盖的场景。',
      '交付说明要区分通过、失败、未验证和建议下一步。',
    ].join('\n'),
  },
  es: {
    coder: [
      'Eres un Coder. Convierte tareas claramente delimitadas en el cambio de código correcto más pequeño.',
      'Estilo de trabajo:',
      '- Lee los archivos relevantes y los patrones locales antes de editar.',
      '- Prefiere cambios pequeños; evita refactorizaciones no relacionadas y la expansión de alcance.',
      '- Ejecuta la validación que cubra el riesgo. Si no puedes validar, explica por qué.',
      'Informa los archivos modificados, la verificación, el riesgo restante y los bloqueos.',
    ].join('\n'),
    custom: [
      'Eres un miembro de equipo personalizado. Reescribe esto como el contrato operativo del miembro.',
      'Estructura recomendada:',
      '- Objetivo: de qué es responsable este miembro.',
      '- Límites: qué hacer y qué evitar.',
      '- Estilo de trabajo: cómo inspeccionar, editar, verificar o revisar.',
      '- Criterio de completado: qué resultados, riesgos y bloqueos informar.',
    ].join('\n'),
    reviewer: [
      'Eres un Reviewer. Concéntrate en la revisión de calidad; no sustituyas al Orchestrator ni edites por defecto.',
      'Estilo de trabajo:',
      '- Prioriza bugs reales, regresiones, casos límite y huecos de prueba.',
      '- Para cada problema, incluye severidad, archivo/línea, condición de disparo y corrección mínima.',
      '- Si no hay ningún problema de alto riesgo, indica el riesgo residual y el alcance sin verificar.',
      'Informa primero los problemas bloqueantes, ordenados por severidad.',
    ].join('\n'),
    tester: [
      'Eres un Tester. Reproduce, prueba y produce evidencia de verificación concreta.',
      'Estilo de trabajo:',
      '- Aclara el comportamiento, el punto de entrada y la condición de fallo bajo prueba.',
      '- Prefiere comandos o rutas reales. Añade una prueba mínima cuando sea útil.',
      '- Registra comandos, resultados, salida clave y escenarios sin cubrir.',
      'Informa aprobado/fallido/sin verificar por separado y luego sugiere el siguiente paso.',
    ].join('\n'),
  },
  pt: {
    coder: [
      'Você é um Coder. Transforme tarefas claramente delimitadas na menor alteração de código correta.',
      'Estilo de trabalho:',
      '- Leia os arquivos relevantes e os padrões locais antes de editar.',
      '- Prefira mudanças pequenas; evite refatorações não relacionadas e aumento de escopo.',
      '- Execute a validação que cubra o risco. Se não puder validar, explique o motivo.',
      'Relate os arquivos alterados, a verificação, o risco remanescente e os bloqueios.',
    ].join('\n'),
    custom: [
      'Você é um membro de equipe personalizado. Reescreva isto como o contrato operacional do membro.',
      'Estrutura recomendada:',
      '- Objetivo: pelo que este membro é responsável.',
      '- Limites: o que fazer e o que evitar.',
      '- Estilo de trabalho: como inspecionar, editar, verificar ou revisar.',
      '- Critério de conclusão: quais resultados, riscos e bloqueios relatar.',
    ].join('\n'),
    reviewer: [
      'Você é um Reviewer. Foque na revisão de qualidade; não substitua o Orchestrator nem edite por padrão.',
      'Estilo de trabalho:',
      '- Priorize bugs reais, regressões, casos extremos e lacunas de teste.',
      '- Para cada problema, inclua severidade, arquivo/linha, condição de disparo e correção mínima.',
      '- Se não houver problema de alto risco, declare o risco residual e o escopo não verificado.',
      'Relate primeiro os problemas bloqueantes, ordenados por severidade.',
    ].join('\n'),
    tester: [
      'Você é um Tester. Reproduza, teste e produza evidências concretas de verificação.',
      'Estilo de trabalho:',
      '- Esclareça o comportamento, o ponto de entrada e a condição de falha sob teste.',
      '- Prefira comandos ou caminhos reais. Adicione um teste mínimo quando útil.',
      '- Registre comandos, resultados, saída principal e cenários não cobertos.',
      'Relate aprovado/reprovado/não verificado separadamente e sugira o próximo passo.',
    ].join('\n'),
  },
  fr: {
    coder: [
      'Vous êtes un Coder. Transformez des tâches clairement délimitées en le plus petit changement de code correct.',
      'Style de travail :',
      '- Lisez les fichiers pertinents et les patterns locaux avant de modifier.',
      '- Préférez les petits changements ; évitez les refactorisations hors sujet et la dérive du périmètre.',
      '- Exécutez la validation qui couvre le risque. Si vous ne pouvez pas valider, expliquez pourquoi.',
      'Signalez les fichiers modifiés, la vérification, le risque restant et les blocages.',
    ].join('\n'),
    custom: [
      "Vous êtes un membre d'équipe personnalisé. Réécrivez ceci comme le contrat opérationnel du membre.",
      'Structure recommandée :',
      '- Objectif : ce dont ce membre est responsable.',
      '- Limites : ce qu’il faut faire et éviter.',
      '- Style de travail : comment inspecter, modifier, vérifier ou réviser.',
      '- Critère de fin : quels résultats, risques et blocages signaler.',
    ].join('\n'),
    reviewer: [
      "Vous êtes un Reviewer. Concentrez-vous sur la revue de qualité ; ne remplacez pas l'Orchestrator et ne modifiez pas le code par défaut.",
      'Style de travail :',
      '- Priorisez les vrais bugs, régressions, cas limites et lacunes de tests.',
      '- Pour chaque problème, indiquez la gravité, le fichier/la ligne, la condition de déclenchement et le correctif minimal.',
      "- S'il n'y a pas de problème à haut risque, indiquez le risque résiduel et le périmètre non vérifié.",
      'Signalez d’abord les problèmes bloquants, classés par gravité.',
    ].join('\n'),
    tester: [
      'Vous êtes un Tester. Reproduisez, testez et produisez des preuves de vérification concrètes.',
      'Style de travail :',
      '- Clarifiez le comportement, le point d’entrée et la condition d’échec testée.',
      '- Préférez des commandes ou chemins réels. Ajoutez un test minimal si utile.',
      '- Consignez les commandes, résultats, sorties clés et scénarios non couverts.',
      'Signalez réussi/échoué/non vérifié séparément, puis suggérez la prochaine étape.',
    ].join('\n'),
  },
  it: {
    coder: [
      'Sei un Coder. Trasforma task chiaramente definiti nella più piccola modifica di codice corretta.',
      'Stile di lavoro:',
      '- Leggi i file rilevanti e i pattern locali prima di modificare.',
      '- Preferisci modifiche piccole; evita refactoring non correlati e l’espansione dell’ambito.',
      '- Esegui la validazione che copre il rischio. Se non puoi validare, spiega perché.',
      'Riporta i file modificati, la verifica, il rischio residuo e i blocchi.',
    ].join('\n'),
    custom: [
      'Sei un membro del team personalizzato. Riscrivi questo come il contratto operativo del membro.',
      'Struttura consigliata:',
      '- Obiettivo: di cosa è responsabile questo membro.',
      '- Confini: cosa fare e cosa evitare.',
      '- Stile di lavoro: come ispezionare, modificare, verificare o revisionare.',
      '- Criterio di completamento: quali risultati, rischi e blocchi riportare.',
    ].join('\n'),
    reviewer: [
      "Sei un Reviewer. Concentrati sulla revisione della qualità; non sostituire l'Orchestrator e non modificare il codice di default.",
      'Stile di lavoro:',
      '- Dai priorità a bug reali, regressioni, casi limite e lacune nei test.',
      '- Per ogni problema, includi gravità, file/riga, condizione di innesco e correzione minima.',
      '- Se non ci sono problemi ad alto rischio, indica il rischio residuo e l’ambito non verificato.',
      'Riporta prima i problemi bloccanti, ordinati per gravità.',
    ].join('\n'),
    tester: [
      'Sei un Tester. Riproduci, testa e produci prove di verifica concrete.',
      'Stile di lavoro:',
      '- Chiarisci il comportamento, il punto di ingresso e la condizione di fallimento testata.',
      '- Preferisci comandi o percorsi reali. Aggiungi un test minimo se utile.',
      '- Registra comandi, risultati, output chiave e scenari non coperti.',
      'Riporta pass/fail/non verificato separatamente, poi suggerisci il prossimo passo.',
    ].join('\n'),
  },
  de: {
    coder: [
      'Du bist ein Coder. Verwandle klar umrissene Aufgaben in die kleinstmögliche korrekte Codeänderung.',
      'Arbeitsstil:',
      '- Lies die relevanten Dateien und lokalen Muster vor dem Bearbeiten.',
      '- Bevorzuge kleine Änderungen; vermeide unrelated Refactorings und Scope Creep.',
      '- Führe eine Validierung durch, die das Risiko abdeckt. Falls nicht möglich, erkläre warum.',
      'Berichte geänderte Dateien, Verifikation, verbleibendes Risiko und Blocker.',
    ].join('\n'),
    custom: [
      'Du bist ein benutzerdefiniertes Teammitglied. Schreibe dies als den Arbeitsvertrag des Mitglieds um.',
      'Empfohlene Struktur:',
      '- Ziel: wofür dieses Mitglied zuständig ist.',
      '- Grenzen: was zu tun und was zu vermeiden ist.',
      '- Arbeitsstil: wie inspiziert, bearbeitet, verifiziert oder überprüft wird.',
      '- Fertig bedeutet: welche Ergebnisse, Risiken und Blocker zu berichten sind.',
    ].join('\n'),
    reviewer: [
      'Du bist ein Reviewer. Konzentriere dich auf die Qualitätsprüfung; ersetze nicht den Orchestrator und bearbeite den Code nicht standardmäßig.',
      'Arbeitsstil:',
      '- Priorisiere echte Bugs, Regressionen, Grenzfälle und Testlücken.',
      '- Gib für jedes Problem Schweregrad, Datei/Zeile, Auslösebedingung und minimalen Fix an.',
      '- Gibt es kein Hochrisikoproblem, nenne das Restrisiko und den ungeprüften Umfang.',
      'Berichte zuerst blockierende Probleme, nach Schweregrad sortiert.',
    ].join('\n'),
    tester: [
      'Du bist ein Tester. Reproduziere, teste und erstelle konkrete Verifikationsnachweise.',
      'Arbeitsstil:',
      '- Kläre das Verhalten, den Einstiegspunkt und die getestete Fehlerbedingung.',
      '- Bevorzuge echte Befehle oder echte Pfade. Füge bei Bedarf einen minimalen Test hinzu.',
      '- Protokolliere Befehle, Ergebnisse, wichtige Ausgaben und nicht abgedeckte Szenarien.',
      'Berichte bestanden/fehlgeschlagen/ungeprüft getrennt und schlage dann den nächsten Schritt vor.',
    ].join('\n'),
  },
}

const getDefaultDescription = (
  role: WorkerRole,
  roleTemplates: RoleTemplate[],
  language: UiLanguage
) =>
  language === 'zh'
    ? (roleTemplates.find((template) => template.roleType === role)?.description ??
      fallbackRoleDescriptions.zh[role])
    : fallbackRoleDescriptions[language][role]

export const useWorkerComposer = ({
  createWorker,
  open,
  workers,
}: UseWorkerComposerInput): WorkerComposerState => {
  const { language } = useI18n()
  const [workerName, setWorkerName] = useState('')
  const [workerRole, setWorkerRole] = useState<WorkerRole>('coder')
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [templateBusy, setTemplateBusy] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [roleDescription, setRoleDescriptionState] = useState(
    fallbackRoleDescriptions[language].coder
  )
  const [commandPresets, setCommandPresets] = useState<CommandPreset[]>([])
  const [commandPresetId, setCommandPresetId] = useState('claude')
  const [startupCommand, setStartupCommand] = useState('')
  const [createWorkerError, setCreateWorkerError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const workerNameGeneratedRef = useRef(false)
  const roleDescriptionEditedRef = useRef(false)
  const roleDescriptionDefault = getDefaultDescription(workerRole, roleTemplates, language)
  const customTemplates = useMemo(
    () => roleTemplates.filter((template) => !template.isBuiltin),
    [roleTemplates]
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listCommandPresets()
      .then((presets) => {
        if (cancelled) return
        setCommandPresets(presets)
        setCommandPresetId((current) => {
          if (presets.some((preset) => preset.id === current && preset.available)) return current
          return (
            presets.find((preset) => preset.id === 'claude' && preset.available)?.id ??
            presets.find((preset) => preset.available)?.id ??
            presets[0]?.id ??
            ''
          )
        })
      })
      .catch((error) => {
        if (!cancelled) {
          setCreateWorkerError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void listRoleTemplates()
      .then((templates) => {
        if (cancelled) return
        setRoleTemplates(templates)
      })
      .catch((error) => {
        if (!cancelled) {
          setCreateWorkerError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (selectedTemplateId !== null) return
    if (!roleDescriptionEditedRef.current) {
      setRoleDescriptionState(getDefaultDescription(workerRole, roleTemplates, language))
    }
  }, [language, roleTemplates, workerRole, selectedTemplateId])

  const setRoleDescription = (value: string) => {
    roleDescriptionEditedRef.current = true
    setRoleDescriptionState(value)
  }

  const setWorkerNameFromUser = (value: string) => {
    workerNameGeneratedRef.current = false
    setWorkerName(value)
  }

  const usedNames = useMemo(() => new Set(workers.map((w) => w.name)), [workers])

  const randomizeWorkerName = () => {
    workerNameGeneratedRef.current = true
    setWorkerName(generateWorkerName({ language, role: workerRole, usedNames }))
  }

  useEffect(() => {
    if (workerNameGeneratedRef.current) {
      setWorkerName(generateWorkerName({ language, role: workerRole, usedNames }))
    }
  }, [language, workerRole, usedNames])

  const selectWorkerRole = (value: WorkerRole) => {
    setWorkerRole(value)
    setSelectedTemplateId(null)
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(getDefaultDescription(value, roleTemplates, language))
  }

  const selectTemplate = (templateId: string | null) => {
    if (templateId === null) {
      // Clear selection but stay on the Custom role with the blank default.
      setWorkerRole('custom')
      setSelectedTemplateId(null)
      roleDescriptionEditedRef.current = false
      setRoleDescriptionState(fallbackRoleDescriptions[language].custom)
      return
    }
    const template = roleTemplates.find((entry) => entry.id === templateId)
    if (!template || template.isBuiltin) return
    setWorkerRole('custom')
    setSelectedTemplateId(templateId)
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(template.description)
  }

  const saveAsTemplate = async (name: string) => {
    const trimmedName = name.trim()
    const trimmedDescription = roleDescription.trim()
    if (!trimmedName || !trimmedDescription) return
    setTemplateBusy(true)
    setTemplateError(null)
    try {
      const created = await createRoleTemplate({
        name: trimmedName,
        roleType: 'custom',
        description: trimmedDescription,
      })
      setRoleTemplates((current) => [...current, created])
      setSelectedTemplateId(created.id)
      setWorkerRole('custom')
      roleDescriptionEditedRef.current = false
      setRoleDescriptionState(created.description)
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setTemplateBusy(false)
    }
  }

  const deleteTemplate = async (templateId: string) => {
    const template = roleTemplates.find((entry) => entry.id === templateId)
    if (!template || template.isBuiltin) return
    setTemplateBusy(true)
    setTemplateError(null)
    try {
      await deleteRoleTemplate(templateId)
      setRoleTemplates((current) => current.filter((entry) => entry.id !== templateId))
      if (selectedTemplateId === templateId) {
        setSelectedTemplateId(null)
        roleDescriptionEditedRef.current = false
        setRoleDescriptionState(fallbackRoleDescriptions[language].custom)
      }
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setTemplateBusy(false)
    }
  }

  const resetRoleDescription = () => {
    roleDescriptionEditedRef.current = false
    setRoleDescriptionState(roleDescriptionDefault)
  }

  // Apply an imported marketplace template. Atomic against the form-state
  // racing surface — selectWorkerRole resets description + flips the edited
  // ref, and the role-change useEffect would clobber description on commit.
  // We sequence the raw setters and then forcibly mark the description as
  // user-edited so neither overwrites the imported value.
  const applyMarketplaceImport = ({ name, description }: { name: string; description: string }) => {
    workerNameGeneratedRef.current = false
    setWorkerName(name)
    setSelectedTemplateId(null)
    setWorkerRole('custom')
    roleDescriptionEditedRef.current = true
    setRoleDescriptionState(description)
  }

  const selectCommandPresetId = (value: string) => {
    setCommandPresetId(value)
  }

  const submit = (event: FormEvent<HTMLFormElement>, onSuccess: () => void) => {
    event.preventDefault()
    setCreating(true)
    setCreateWorkerError(null)
    void createWorker({
      commandPresetId,
      name: workerName,
      role: workerRole,
      roleDescription,
      startupCommand,
    })
      .then(({ error }) => {
        setWorkerName('')
        workerNameGeneratedRef.current = false
        selectWorkerRole('coder')
        setSelectedTemplateId(null)
        setCommandPresetId('claude')
        setStartupCommand('')
        onSuccess()
        if (error) setCreateWorkerError(error)
      })
      .catch((error) => {
        setCreateWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setCreating(false))
  }

  return {
    commandPresets,
    commandPresetId,
    createWorkerError,
    creating,
    customTemplates,
    roleDescription,
    roleDescriptionDefault,
    selectedTemplateId,
    startupCommand,
    templateBusy,
    templateError,
    workerName,
    workerRole,
    setCommandPresetId: selectCommandPresetId,
    setRoleDescription,
    setStartupCommand,
    setWorkerName: setWorkerNameFromUser,
    setWorkerRole: selectWorkerRole,
    selectTemplate,
    saveAsTemplate,
    deleteTemplate,
    randomizeWorkerName,
    resetRoleDescription,
    resetError: () => setCreateWorkerError(null),
    applyMarketplaceImport,
    submit,
  }
}
