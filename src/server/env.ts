/**
 * Environment access helpers.
 *
 * Runtime-injected settings use the `GACH_*` prefix (e.g. `GACH_PORT`,
 * `GACH_DATA_DIR`). All reads go through here so the prefix lives in exactly
 * one place.
 */

export const readEnv = (name: string): string | undefined => {
  const value = process.env[`GACH_${name}`]
  return value !== '' ? value : undefined
}

export const hasEnv = (name: string): boolean => {
  const value = process.env[`GACH_${name}`]
  return value !== undefined && value !== '' && value !== '0'
}
