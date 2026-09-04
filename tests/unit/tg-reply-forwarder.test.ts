import { describe, expect, test, vi } from 'vitest'

import { createTgReplyLineForwarder } from '../../src/server/telegram-service.js'

describe('tg reply line forwarder', () => {
  test('assembles [TG_REPLY] lines split across chunks', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('[TG_RE')
    forward('PLY] готово, собрал ')
    forward('ролик\nобычный лог без тега\n')

    expect(seen).toEqual(['готово, собрал ролик'])
  })

  test('delivers multiple replies and ignores non-matching lines', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('[TG_REPLY] first\nnoise\n[TG_REPLY] second\nno tag here\n[TG_REPLY] third')
    expect(seen).toEqual(['first', 'second'])

    // The trailing unterminated line flushes on the next chunk.
    forward('\n')
    expect(seen).toEqual(['first', 'second', 'third'])
  })

  test('callback errors do not break the stream', () => {
    const onMessage = vi.fn(() => {
      throw new Error('telegram down')
    })
    const forward = createTgReplyLineForwarder((text) => onMessage(text))
    expect(() => forward('[TG_REPLY] boom\n')).not.toThrow()
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  test('matches through ANSI colors and the TUI bullet prefix', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    // Claude Code paints assistant text like "● [TG_REPLY] …" with SGR codes.
    forward('\x1b[36m●\x1b[39m \x1b[1m[TG_REPLY]\x1b[22m Серия 10 собрана (178.9с)\n')
    expect(seen).toEqual(['Серия 10 собрана (178.9с)'])
  })

  test('strips OSC hyperlink sequences around the tag', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('\x1b]8;;https://example.com\x1b\\[TG_REPLY]\x1b]8;;\x1b\\ отчёт готов\n')
    expect(seen).toEqual(['отчёт готов'])
  })

  test('bullet-only prefix without colors still matches', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('● [TG_REPLY] короткий ответ\n')
    expect(seen).toEqual(['короткий ответ'])
  })

  test('tag split by an escape sequence across chunks still assembles', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('\x1b[32m[TG_RE')
    forward('PLY]\x1b[0m ответ после разрыва\x1b[K\n')
    expect(seen).toEqual(['ответ после разрыва'])
  })

  test('TUI repaints of the same reply are delivered once', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    const full = 'Всё ещё в работе: coder добивает пересборку Shorts-09, AE Codex делает Shorts-08'
    forward(`[TG_REPLY] ${full}\n`)
    // Spinner repaints repeat the identical line…
    for (let i = 0; i < 5; i += 1) {
      forward(`\x1b[36m●\x1b[39m [TG_REPLY] ${full}\n`)
    }
    expect(seen).toEqual([full])
  })

  test('truncated repaints collapse into the original reply', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward(
      '[TG_REPLY] Всё ещё в работе, никто не завис: coder добивает пересборку Shorts-09 и ждёт отчёт\n'
    )
    // Narrow-terminal repaint truncates the line and glues the next UI row.
    forward('[TG_REPLY] Всё ещё в работе, никто не завис: coder добивает пересборку Shorts-0\n')
    forward('[TG_REPLY] Всё ещё в работе, никто не завис\n')
    expect(seen).toHaveLength(1)
  })

  test('repaints with dropped letters and glued spaces still dedupe', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward(
      '[TG_REPLY] Всё ещё в работе, никто не завис: coder добивает пересборку Shorts-09 (был найден и чинится рассинхрон), AE Codex делает Shorts-08. Как только что-то закроется — сразу отпишусь.\n'
    )
    // Real-world repaints from a narrow TUI: spaces glued, letters lost.
    forward(
      '[TG_REPLY] Всёещёвработе,никтонезавис:coderдобиваетпересборкуShorts-09(былнайденичинитсярассинхрон),AECodexделаетShorts-08.\n'
    )
    forward(
      '[TG_REPLY] Всё ещё в работ,никто не завис: coder добиват пересборку Shorts-09 (был найдени чиится рассинхрон), AE Codex делает Shorts-08, Image Gen перегенерирует бложку 08\n'
    )
    expect(seen).toHaveLength(1)
  })

  test('the second distinct status report is delivered', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('[TG_REPLY] Всё ещё в работе, никто не завис: coder добивает пересборку Shorts-09\n')
    forward(
      '[TG_REPLY] Без изменений — всё те же 3 задачи ещё выполняются, признаков зависания нет\n'
    )
    expect(seen).toHaveLength(2)
  })

  test('an echo storm stays suppressed as long as it keeps repeating', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    const reply =
      'Без изменений — всё те же 3 задачи ещё выполняются, последняя активность 7 минут назад у всех'
    for (let wave = 0; wave < 12; wave += 1) {
      forward(`[TG_REPLY] ${reply}\n`)
    }
    expect(seen).toEqual([reply])
  })

  test('distinct replies within the window are both delivered', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text), undefined, {
      dedupeWindowMs: 60_000,
    })

    forward('[TG_REPLY] да\n')
    forward('[TG_REPLY] да, готово\n')
    expect(seen).toEqual(['да', 'да, готово'])
  })

  test('a bare CR repaint does not glue the stale prefix into the payload', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    // Spinner repaints an unterminated line: bare \r rewinds the cursor and
    // the TUI overwrites the partial line. Deleting \r used to glue both.
    forward('● [TG_REPLY] Важн')
    forward('\r\x1b[2K● [TG_REPLY] Важное сообщение доставлено\n')

    expect(seen).toEqual(['Важное сообщение доставлено'])
  })

  test('a bare CR at a chunk boundary discards the stale partial line', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('● [TG_REPLY] старый хвост\r')
    forward('\x1b[2K● [TG_REPLY] свежий текст\n')

    expect(seen).toEqual(['свежий текст'])
  })

  test('CRLF-terminated replies still assemble', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text))

    forward('[TG_REPLY] всё готово\r\n')

    expect(seen).toEqual(['всё готово'])
  })

  test('the same reply after the dedup window is delivered again', () => {
    const seen: string[] = []
    const forward = createTgReplyLineForwarder((text) => seen.push(text), undefined, {
      dedupeWindowMs: 0,
    })

    forward('[TG_REPLY] статус тот же\n')
    forward('[TG_REPLY] статус тот же\n')
    expect(seen).toEqual(['статус тот же', 'статус тот же'])
  })
})
