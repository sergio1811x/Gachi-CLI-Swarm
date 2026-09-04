// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AddWorkspaceDialog } from '../../web/src/workspace/AddWorkspaceDialog.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('AddWorkspaceDialog native picker', () => {
  test('opens directory input and resolves selected folder', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname
      if (path === '/api/settings/command-presets')
        return { ok: true, json: async () => [] } as Response
      if (path === '/api/fs/resolve-folder')
        return { ok: true, json: async () => ({ path: '/repo', matches: [] }) } as Response
      return {
        ok: true,
        json: async () => ({ ok: true, is_dir: true, path: '/repo', suggested_name: 'repo' }),
      } as Response
    })
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    render(<AddWorkspaceDialog trigger={1} onClose={vi.fn()} onCreate={vi.fn()} />)
    const input = await screen.findByTestId('add-workspace-native-input')
    expect(input).toHaveAttribute('webkitdirectory')
    await waitFor(() => expect(click).toHaveBeenCalled())
    const file = new File(['x'], 'index.ts')
    Object.defineProperty(file, 'webkitRelativePath', { value: 'repo/index.ts' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByTestId('confirm-workspace-dialog')).toBeInTheDocument())
  })
})
