export interface SkillPackage {
  description: string
  name: string
  rules: string[]
  skills: string[]
}

export const skillCatalog: SkillPackage[] = [
  {
    name: 'React Expert',
    description: 'React UI implementation and testing.',
    skills: ['react', 'typescript', 'accessibility'],
    rules: ['write component tests', 'preserve accessible semantics'],
  },
  {
    name: 'Security Auditor',
    description: 'Security-focused implementation review.',
    skills: ['security', 'threat-modeling'],
    rules: ['identify trust boundaries', 'report evidence and severity'],
  },
  {
    name: 'Performance Engineer',
    description: 'Runtime and frontend performance analysis.',
    skills: ['performance', 'profiling'],
    rules: ['measure before optimizing', 'record regressions and budgets'],
  },
  {
    name: 'Database Architect',
    description: 'Schema and data-integrity design.',
    skills: ['sqlite', 'data-modeling'],
    rules: ['preserve migrations', 'verify transactional behavior'],
  },
]

export const findSkillPackage = (name: string) =>
  skillCatalog.find(
    (skillPackage) => skillPackage.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  )
