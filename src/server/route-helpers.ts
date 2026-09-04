import type { IncomingMessage, ServerResponse } from 'node:http'

import { BadRequestError, PayloadTooLargeError } from './http-errors.js'
import type { RouteDefinition } from './route-types.js'

const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024

export type BodyValidator<T> = (value: unknown) => T

export const sendJson = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

export const readJsonBody = async <T>(
  request: IncomingMessage,
  options: { limitBytes?: number } = {}
): Promise<T> => {
  const limitBytes = options.limitBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES
  const rawContentLength = request.headers['content-length']
  const contentLength = Array.isArray(rawContentLength) ? rawContentLength[0] : rawContentLength
  if (contentLength && Number(contentLength) > limitBytes) {
    throw new PayloadTooLargeError('Request body too large')
  }

  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    totalBytes += buffer.byteLength
    if (totalBytes > limitBytes) {
      throw new PayloadTooLargeError('Request body too large')
    }
    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') {
    throw new BadRequestError('Request body is required')
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new BadRequestError(
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export const parseJsonBody = async <T>(
  request: IncomingMessage,
  validator: BodyValidator<T>,
  options: { limitBytes?: number } = {}
): Promise<T> => {
  const body = await readJsonBody<unknown>(request, options)
  return validator(body)
}

const expectObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestError('Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

const expectString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new BadRequestError(`${field} must be a string`)
  }
  return value
}

const expectOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined
  return expectString(value, field)
}

const expectNullableString = (value: unknown, field: string): string | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  return expectString(value, field)
}

const expectBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new BadRequestError(`${field} must be a boolean`)
  }
  return value
}

const expectOptionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined
  return expectBoolean(value, field)
}

const expectOptionalStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BadRequestError(`${field} must be an array of strings`)
  }
  return value
}

const expectNullableStringArray = (value: unknown, field: string): string[] | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BadRequestError(`${field} must be an array of strings or null`)
  }
  return value
}

const expectRecord = (value: unknown, field: string): Record<string, string> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new BadRequestError(`${field} must be an object of string values`)
  }
  return value as Record<string, string>
}

const expectOptionalRecord = (
  value: unknown,
  field: string
): Record<string, string> | undefined => {
  if (value === undefined) return undefined
  return expectRecord(value, field)
}

export const jsonBodyValidator = {
  object: expectObject,
  string: expectString,
  optionalString: expectOptionalString,
  nullableString: expectNullableString,
  boolean: expectBoolean,
  optionalBoolean: expectOptionalBoolean,
  optionalStringArray: expectOptionalStringArray,
  nullableStringArray: expectNullableStringArray,
  record: expectRecord,
  optionalRecord: expectOptionalRecord,
}

export const getRequiredParam = (
  response: ServerResponse,
  params: Record<string, string>,
  key: string,
  error: string
) => {
  const value = params[key]
  if (value) {
    return value
  }

  sendJson(response, 400, { error })
  return null
}

export const route = (
  method: string,
  path: string,
  handler: RouteDefinition['handler']
): RouteDefinition => ({
  method,
  path,
  handler,
})

export const matchPath = (pattern: string, pathname: string) => {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)

  if (patternParts.length !== pathParts.length) {
    return null
  }

  const params: Record<string, string> = {}

  for (const [index, patternPart] of patternParts.entries()) {
    const pathPart = pathParts[index]
    if (!pathPart) {
      return null
    }

    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart)
      continue
    }

    if (patternPart !== pathPart) {
      return null
    }
  }

  return params
}
