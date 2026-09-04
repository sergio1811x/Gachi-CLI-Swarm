import { randomUUID } from 'node:crypto'

export interface UiAuth {
  getToken: () => string
  regenerate: () => string
  validate: (token: string | undefined) => boolean
}

export const createUiAuth = (): UiAuth => {
  let token = randomUUID()

  return {
    getToken() {
      return token
    },
    regenerate() {
      token = randomUUID()
      return token
    },
    validate(input) {
      return input === token
    },
  }
}
