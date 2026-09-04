export interface WorkspaceCreateInput {
  commandPresetId: string | null
  name: string
  path: string
  startupCommand?: string
  teamTemplateId?: string
  /** R8 onboarding (opt-in): seed one safe orientation card into the backlog. */
  exampleTask?: boolean
}
